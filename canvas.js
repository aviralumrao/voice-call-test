(() => {
  if (!window.FrietSync) return; // app.js failed to load; it already reports that.

  const $ = (id) => document.getElementById(id);
  const { log, api, run, errorMessage, validatedApiBase } = window.FrietSync;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_ITEMS = 2000;
  const enc = encodeURIComponent;

  const DEFAULTS = {
    STICKY_NOTE: { width: 180, height: 140, color: '#fde68a' },
    SHAPE: { width: 160, height: 100, color: '#bfdbfe', shape: 'rectangle' },
    TEXT: { width: 200, height: 44, color: '#20251f' }
  };

  // ---------- State ----------

  let client = null;            // STOMP client (one per page, shared by canvases)
  let connectPromise = null;
  let topicSub = null;
  let canvasId = null;
  let canvasName = '';
  let revision = null;
  let loading = false;          // true while fetching the canvas detail
  let buffered = [];            // topic events that arrived during that fetch
  let tool = 'select';
  let selectedId = null;
  let drag = null;
  let wsEdited = false;
  let subscribeWatch = null;    // resolver while waiting to learn if a topic subscription was accepted
  let pollMode = false;         // true when the server rejected the live topic and we refresh by polling
  let pollTimer = null;
  let polling = false;
  let lastPollError = '';
  let lastCommand = '';         // destination of the most recent SEND, for error diagnosis
  let renderQueued = false;
  const items = new Map();      // id -> item (server shape)
  const view = { x: 40, y: 40, k: 1 };

  const svg = $('canvasSvg');
  const world = $('world');

  // ---------- Small helpers ----------

  function svgEl(name, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    if (parent) parent.append(node);
    return node;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sizeOf = (it) => ({
    w: it.width || DEFAULTS[it.type]?.width || 160,
    h: it.height || DEFAULTS[it.type]?.height || 100
  });

  function toCanvas(e) {
    const rect = svg.getBoundingClientRect();
    return { x: (e.clientX - rect.left - view.x) / view.k, y: (e.clientY - rect.top - view.y) / view.k };
  }

  function deriveWsUrl() {
    try {
      const url = new URL(validatedApiBase());
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${url.origin}/ws`;
    } catch (_) {
      return '';
    }
  }

  function syncWsField() {
    if (!wsEdited) $('wsUrl').value = deriveWsUrl();
  }

  function projectId() {
    const id = $('projectId').value.trim();
    if (!id) throw new Error('Enter a project ID first.');
    return id;
  }

  function setLive(text) { $('canvasLive').textContent = text; }

  function refreshRevision() {
    const revs = Array.from(items.values(), (it) => it.revision).filter((r) => typeof r === 'number');
    revision = revs.length ? Math.max(...revs) : null;
  }

  function updateControls() {
    refreshRevision();
    const open = Boolean(canvasId);
    $('closeCanvasButton').disabled = !client;
    $('renameCanvasButton').disabled = !open;
    $('deleteCanvasButton').disabled = !open;
    $('canvasCount').textContent = String(items.size);
    $('canvasRevision').textContent = revision ?? '—';
    $('canvasEmpty').hidden = open;
  }

  // ---------- STOMP ----------

  function ensureStomp() {
    if (client && client.connected) return Promise.resolve();
    if (connectPromise) return connectPromise;

    connectPromise = new Promise((resolve, reject) => {
      if (!window.StompJs) return reject(new Error('STOMP client library is unavailable. Check the Network tab.'));
      const token = $('token').value.trim();
      if (!token) return reject(new Error('Enter a bearer token first.'));
      const url = $('wsUrl').value.trim();
      if (!url) return reject(new Error('Enter the STOMP WebSocket URL.'));

      setLive('Connecting…');
      log(`Connecting STOMP to ${url}`);

      const c = new StompJs.Client({
        brokerURL: url,
        connectHeaders: { Authorization: `Bearer ${token}` },
        reconnectDelay: 0,
        heartbeatIncoming: 10000,
        heartbeatOutgoing: 10000
      });
      client = c;

      c.onConnect = () => {
        log('STOMP connected.');
        c.subscribe('/user/queue/canvas-created', onCanvasCreated);
        c.subscribe('/user/queue/canvas-issue-created', onIssueCreated);
        c.subscribe('/user/queue/canvas-errors', onCanvasError);
        resolve();
      };
      c.onStompError = (frame) => {
        const detail = frame.headers?.message || frame.body || 'unknown error';
        log(`STOMP error: ${detail}`, true);
        if (frame.body && frame.body !== detail) log(`STOMP error body: ${String(frame.body).slice(0, 400)}`, true);
        if (lastCommand) {
          log(`Last command sent: ${lastCommand}. A generic "Failed to send message" error hides the real cause: check the token, project access and role, and the backend logs. If it happened right after a canvas was created, the subscription to /topic/canvases/{id} is the more likely culprit.`, true);
        }
        if (subscribeWatch) {
          // The server refused a SUBSCRIBE frame and drops the connection after an ERROR frame.
          const watcher = subscribeWatch;
          if (client === c) client = null;
          try { c.deactivate(); } catch (_) { /* already closing */ }
          watcher(false);
          return;
        }
        reject(new Error(`STOMP error: ${detail}`));
      };
      c.onWebSocketError = () => {
        reject(new Error(`Could not open ${url}. Check the URL, TLS and CORS/origin settings. If the server only offers SockJS, a plain WebSocket URL will not work.`));
      };
      c.onWebSocketClose = () => {
        if (client === c && subscribeWatch) {
          client = null;
          subscribeWatch(false);
        } else if (client === c) {
          log('STOMP connection closed.', true);
          resetSession();
        }
        reject(new Error('WebSocket closed before STOMP connected.'));
      };
      c.activate();
    }).catch((error) => {
      resetSession();
      throw error;
    }).finally(() => { connectPromise = null; });

    return connectPromise;
  }

  // Pass no body for commands that take none (deletes).
  function send(destination, body) {
    if (!client || !client.connected) throw new Error('Not connected. Open a canvas first.');
    lastCommand = destination;
    client.publish({
      destination,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? '' : JSON.stringify(body)
    });
    if (pollMode) setTimeout(pollOnce, 400); // no broadcasts in poll mode, so re-read after each command
  }

  function onCanvasError(message) {
    let error;
    try { error = JSON.parse(message.body); } catch (_) { log(`Canvas error: ${message.body}`, true); return; }
    log(`Server rejected a command (${error.status}): ${error.message}${error.destination ? ` [${error.destination}]` : ''}`, true);
  }

  function resetSession() {
    lastCommand = '';
    stopPolling();
    pollMode = false;
    topicSub = null;
    client = null;
    canvasId = null;
    canvasName = '';
    revision = null;
    selectedId = null;
    items.clear();
    queued.clear();
    setLive('Not connected');
    updateControls();
    updateInspector();
    scheduleRender();
  }

  function disconnectAll() {
    const c = client;
    client = null;
    try { topicSub?.unsubscribe(); } catch (_) { /* already gone */ }
    try { c?.deactivate(); } catch (_) { /* already gone */ }
    resetSession();
    log('Disconnected from the canvas.');
  }

  // ---------- Canvas list (REST) ----------

  const listOf = (body) => (Array.isArray(body) ? body : body?.content || body?.canvases || body?.items || []);

  function fillSelect(selectId) {
    const select = $('canvasSelect');
    select.replaceChildren();
    if (!canvasesCache.length) {
      select.append(new Option('— no canvases in this project —', ''));
      return;
    }
    canvasesCache.forEach((c) => select.append(new Option(`${c.name || 'Untitled'}  (${String(c.id).slice(0, 8)}${c.elementCount !== undefined ? `, ${c.elementCount} items` : ''})`, c.id)));
    if (selectId) select.value = selectId;
  }

  let canvasesCache = [];

  async function loadCanvases() {
    const body = await api(`/api/v1/projects/${enc(projectId())}/canvases`, 'GET');
    canvasesCache = listOf(body);
    fillSelect($('canvasSelect').value);
    log(`Loaded ${canvasesCache.length} canvas(es).`);
  }

  function onCanvasCreated(message) {
    let reply;
    try { reply = JSON.parse(message.body); } catch (_) { log(`Canvas created: ${message.body}`); return; }
    const created = reply.canvas || reply; // CanvasDetailResponse: { canvas, elements }
    log(`Canvas created: "${created.name || ''}" (${created.id}). Now subscribing for live updates.`);
    if (created.id && !canvasesCache.some((c) => c.id === created.id)) canvasesCache.push(created);
    fillSelect(created.id);
    if (created.id) run(openCanvas);
  }

  async function createCanvas() {
    const pid = projectId();
    const name = (window.prompt('Name for the new canvas (max 200 characters)', 'Test canvas') || '').trim().slice(0, 200);
    if (!name) return;
    await ensureStomp();
    send(`/app/projects/${enc(pid)}/canvases/create`, { name });
    log(`Requested new canvas "${name}".`);
  }

  // ---------- Open a canvas ----------

  // Asks for a receipt on SUBSCRIBE so we know whether the server accepted it.
  function trySubscribe(id) {
    return new Promise((resolve) => {
      const receipt = `canvas-${Date.now()}`;
      let timer = null;
      const finish = (ok) => {
        clearTimeout(timer);
        if (subscribeWatch === finish) subscribeWatch = null;
        resolve(ok);
      };
      subscribeWatch = finish;
      timer = setTimeout(() => {
        log('No subscription receipt from the server within 5s; assuming the subscription worked.');
        finish(true);
      }, 5000);
      client.watchForReceipt(receipt, () => finish(true));
      topicSub = client.subscribe(`/topic/canvases/${id}`, onCanvasEvent, { receipt });
    });
  }

  function applyDetail(detail) {
    const canvas = detail.canvas || detail; // { canvas, elements }
    canvasName = canvas.name || canvasName;
    const next = new Map();
    (detail.elements || detail.items || []).forEach((it) => next.set(it.id, it));
    // Keep our local copy of an item that is being dragged right now.
    if (drag && (drag.mode === 'move' || drag.mode === 'resize') && items.has(drag.id) && next.has(drag.id)) {
      next.set(drag.id, items.get(drag.id));
    }
    items.clear();
    next.forEach((it, id) => items.set(id, it));
    if (selectedId && !items.has(selectedId)) selectedId = null;
    updateControls();
    updateInspector(true);
    scheduleRender();
  }

  async function openCanvas() {
    const id = $('canvasSelect').value;
    if (!id) throw new Error('Pick a canvas first (use Load canvases).');

    stopPolling();
    pollMode = false;
    try { topicSub?.unsubscribe(); } catch (_) { /* ignore */ }
    topicSub = null;
    canvasId = null;
    items.clear();
    selectedId = null;
    updateInspector();

    await ensureStomp();

    // Subscribe first, then fetch, so no broadcast is missed while loading.
    loading = true;
    buffered = [];
    const live = await trySubscribe(id);
    if (!live) {
      topicSub = null;
      buffered = [];
      log(`The server rejected the live subscription to /topic/canvases/${id}. The canvas itself is fine; the backend's subscription guard is refusing the topic. Falling back to refreshing every 2 seconds so you can still test edits.`, true);
      await ensureStomp();
      pollMode = true;
    }

    let detail;
    try {
      detail = await api(`/api/v1/canvases/${enc(id)}`, 'GET');
    } catch (error) {
      loading = false;
      try { topicSub?.unsubscribe(); } catch (_) { /* ignore */ }
      topicSub = null;
      pollMode = false;
      throw error;
    }

    canvasId = id;
    applyDetail(detail);
    loading = false;
    buffered.forEach(applyEvent);
    buffered = [];

    if (pollMode) {
      startPolling();
      setLive(`Polling every 2s · ${canvasName || id.slice(0, 8)}`);
    } else {
      setLive(`Live · ${canvasName || id.slice(0, 8)}`);
    }
    log(`Opened "${canvasName}" with ${items.size} item(s)${pollMode ? ' (polling, not live)' : ' and subscribed for live updates'}.`);
    resetView();
    updateControls();
    scheduleRender();
  }

  // ---------- Polling fallback (only when the live topic is rejected) ----------

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollOnce, 2000);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function pollOnce() {
    if (!pollMode || !canvasId || polling || drag) return;
    polling = true;
    const id = canvasId;
    try {
      const detail = await api(`/api/v1/canvases/${enc(id)}`, 'GET', null, { quiet: true });
      if (id !== canvasId) return;
      lastPollError = '';
      applyDetail(detail);
    } catch (error) {
      const text = errorMessage(error);
      if (/HTTP 404/.test(text)) {
        log('This canvas no longer exists.', true);
        canvasesCache = canvasesCache.filter((c) => c.id !== id);
        fillSelect('');
        disconnectAll();
      } else if (text !== lastPollError) {
        lastPollError = text;
        log(`Refresh failed: ${text}`, true);
      }
    } finally {
      polling = false;
    }
  }

  function renameCanvas() {
    if (!canvasId) return;
    const name = (window.prompt('New canvas name', canvasName) || '').trim();
    if (!name || name === canvasName) return;
    send(`/app/canvases/${enc(canvasId)}/rename`, { name });
    log(`Requested rename to "${name}".`);
  }

  function deleteCanvas() {
    if (!canvasId) return;
    if (!window.confirm(`Delete canvas "${canvasName}" for everyone? This cannot be undone.`)) return;
    send(`/app/canvases/${enc(canvasId)}/delete`);
    log('Requested canvas deletion.');
  }

  // ---------- Incoming events ----------

  function onIssueCreated(message) {
    let reply;
    try { reply = JSON.parse(message.body); } catch (_) { log(`Issue created: ${message.body}`); return; }
    const issue = reply.issue || {};
    log(`Issue created: ${issue.title || issue.id || 'unknown'}${issue.key ? ` (${issue.key})` : ''}.`);
    if (reply.element?.id) {
      items.set(reply.element.id, reply.element);
      updateInspector(true);
      scheduleRender();
    }
  }

  function onCanvasEvent(message) {
    let event;
    try { event = JSON.parse(message.body); } catch (_) { log(`Unreadable canvas event: ${message.body}`, true); return; }
    if (loading) buffered.push(event); else applyEvent(event);
  }

  function applyEvent(event) {
    const type = event.type || event.eventType;
    const payload = event.payload || {};

    if (type === 'ELEMENTS_UPSERTED') {
      const list = event.elements || event.items || payload.elements || (event.element ? [event.element] : []);
      let added = 0;
      list.forEach((it) => {
        if (!items.has(it.id)) added += 1;
        // Don't fight the person dragging this very item; their final update will land.
        if (drag && drag.id === it.id && (drag.mode === 'move' || drag.mode === 'resize')) return;
        items.set(it.id, it);
      });
      if (added) log(`${added} item(s) added by ${event.actorId ? String(event.actorId).slice(0, 8) : 'someone'}.`);
    } else if (type === 'ELEMENTS_DELETED') {
      const ids = event.elementIds || event.ids || payload.elementIds || [];
      ids.forEach((id) => items.delete(id));
      if (selectedId && !items.has(selectedId)) selectedId = null;
      log(`${ids.length} item(s) deleted.`);
    } else if (type === 'CANVAS_RENAMED') {
      canvasName = event.name || event.newName || payload.name || canvasName;
      const option = Array.from($('canvasSelect').options).find((o) => o.value === canvasId);
      if (option) option.textContent = `${canvasName}  (${String(canvasId).slice(0, 8)})`;
      const cached = canvasesCache.find((c) => c.id === canvasId);
      if (cached) cached.name = canvasName;
      setLive(`Live · ${canvasName}`);
      log(`Canvas renamed to "${canvasName}".`);
    } else if (type === 'CANVAS_DELETED') {
      log('This canvas was deleted.', true);
      const deletedId = canvasId;
      canvasesCache = canvasesCache.filter((c) => c.id !== deletedId);
      fillSelect('');
      disconnectAll();
      return;
    } else {
      log(`Unrecognised canvas event: ${message_preview(event)}`, true);
    }
    updateControls();
    updateInspector(true);
    scheduleRender();
  }

  const message_preview = (event) => JSON.stringify(event).slice(0, 200);

  // ---------- Outgoing item edits ----------

  const queued = new Map();
  let flushTimer = null;

  function sendUpdate(id, fields) {
    if (!canvasId) return;
    send(`/app/canvases/${enc(canvasId)}/elements/${enc(id)}/update`, fields);
  }

  function queueUpdate(id, fields) {
    queued.set(id, { ...(queued.get(id) || {}), ...fields });
    if (!flushTimer) flushTimer = setTimeout(flushUpdates, 70);
  }

  function flushUpdates() {
    clearTimeout(flushTimer);
    flushTimer = null;
    queued.forEach((fields, id) => {
      try { sendUpdate(id, fields); } catch (error) { log(errorMessage(error), true); }
    });
    queued.clear();
  }

  const nextZ = () => Math.max(0, ...Array.from(items.values(), (it) => it.zIndex || 0)) + 1;

  function createItem(fields) {
    if (!canvasId) throw new Error('Open a canvas first.');
    if (items.size >= MAX_ITEMS) throw new Error(`A canvas supports up to ${MAX_ITEMS} items.`);
    send(`/app/canvases/${enc(canvasId)}/elements/create`, { rotation: 0, zIndex: nextZ(), ...fields });
  }

  // ---------- Rendering ----------

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function applyViewTransform() {
    world.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    $('gridDots').setAttribute('patternTransform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    $('zoomLabel').textContent = `${Math.round(view.k * 100)}%`;
  }

  function centerOf(it) {
    const { w, h } = sizeOf(it);
    return { x: it.x + w / 2, y: it.y + h / 2 };
  }

  function rectEdge(it, tx, ty) {
    const { w, h } = sizeOf(it);
    const c = centerOf(it);
    const dx = tx - c.x;
    const dy = ty - c.y;
    if (!dx && !dy) return c;
    const sx = dx ? (w / 2) / Math.abs(dx) : Infinity;
    const sy = dy ? (h / 2) / Math.abs(dy) : Infinity;
    const t = Math.min(sx, sy, 1);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }

  function arrowPoints(a) {
    const from = a.fromElementId ? items.get(a.fromElementId) : null;
    const to = a.toElementId ? items.get(a.toElementId) : null;
    const rawStart = from ? centerOf(from) : { x: a.x, y: a.y };
    const rawEnd = to ? centerOf(to) : { x: a.endX ?? a.x + 120, y: a.endY ?? a.y };
    return {
      s: from ? rectEdge(from, rawEnd.x, rawEnd.y) : rawStart,
      e: to ? rectEdge(to, rawStart.x, rawStart.y) : rawEnd
    };
  }

  function drawLabel(group, it, w, h, centered, color) {
    const fo = svgEl('foreignObject', { width: w, height: h, 'pointer-events': 'none' }, group);
    const div = document.createElement('div');
    div.className = centered ? 'el-text center' : 'el-text';
    if (color) div.style.color = color;
    div.textContent = it.text || '';
    fo.append(div);
  }

  function drawItem(it) {
    const selected = it.id === selectedId;
    const { w, h } = sizeOf(it);

    if (it.type === 'ARROW') {
      const { s, e } = arrowPoints(it);
      const g = svgEl('g', { 'data-id': it.id }, world);
      svgEl('line', { x1: s.x, y1: s.y, x2: e.x, y2: e.y, class: 'arrow-hit' }, g);
      svgEl('line', {
        x1: s.x, y1: s.y, x2: e.x, y2: e.y,
        stroke: selected ? '#536b3c' : (it.color || '#30382b'),
        'stroke-width': selected ? 3 : 2,
        'marker-end': 'url(#arrowHead)',
        'pointer-events': 'none'
      }, g);
      return;
    }

    const rot = it.rotation || 0;
    const g = svgEl('g', { 'data-id': it.id, transform: `translate(${it.x} ${it.y}) rotate(${rot} ${w / 2} ${h / 2})` }, world);
    const fill = it.color || DEFAULTS[it.type]?.color || '#ffffff';
    const common = { class: 'el-body', fill, stroke: '#20251f33', 'stroke-width': 1 };

    if (it.type === 'STICKY_NOTE') {
      svgEl('rect', { ...common, width: w, height: h, rx: 4 }, g);
      drawLabel(g, it, w, h, false);
    } else if (it.type === 'SHAPE') {
      const shape = String(it.shape || 'rectangle').toLowerCase();
      if (shape === 'ellipse' || shape === 'circle') {
        svgEl('ellipse', { ...common, cx: w / 2, cy: h / 2, rx: w / 2, ry: h / 2 }, g);
      } else if (shape === 'diamond') {
        svgEl('polygon', { ...common, points: `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}` }, g);
      } else {
        svgEl('rect', { ...common, width: w, height: h, rx: shape === 'rounded' ? 14 : 3 }, g);
      }
      drawLabel(g, it, w, h, true);
    } else {
      // TEXT: transparent hit area, `color` is the text color.
      svgEl('rect', { class: 'el-body', width: w, height: h, fill: '#0000' }, g);
      drawLabel(g, it, w, h, false, it.color || DEFAULTS.TEXT.color);
    }

    if (selected) {
      svgEl('rect', { class: 'sel-box', x: -4, y: -4, width: w + 8, height: h + 8 }, g);
      const size = 11 / view.k;
      svgEl('rect', { class: 'resize-handle', 'data-handle': 'resize', x: w - size / 2, y: h - size / 2, width: size, height: size }, g);
    }
  }

  function render() {
    applyViewTransform();
    world.replaceChildren();

    const sorted = Array.from(items.values()).sort((a, b) =>
      (a.zIndex || 0) - (b.zIndex || 0) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    sorted.filter((it) => it.type !== 'ARROW').forEach(drawItem);
    sorted.filter((it) => it.type === 'ARROW').forEach(drawItem);

    if (drag?.mode === 'arrow' && drag.cur) {
      svgEl('line', {
        x1: drag.start.x, y1: drag.start.y, x2: drag.cur.x, y2: drag.cur.y,
        stroke: '#536b3c', 'stroke-width': 2, 'stroke-dasharray': '6 4', 'marker-end': 'url(#arrowHead)', 'pointer-events': 'none'
      }, world);
    }
    refreshRevision();
    $('canvasCount').textContent = String(items.size);
    $('canvasRevision').textContent = revision ?? '—';
  }

  // ---------- Viewport ----------

  function resetView() {
    view.x = 40; view.y = 40; view.k = 1;
    scheduleRender();
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = svg.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const k = clamp(view.k * factor, 0.2, 3);
    view.x = px - ((px - view.x) / view.k) * k;
    view.y = py - ((py - view.y) / view.k) * k;
    view.k = k;
    scheduleRender();
  }

  function zoomCenter(factor) {
    const rect = svg.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  // ---------- Tools and pointer handling ----------

  function setTool(next) {
    tool = next;
    document.querySelectorAll('#toolGroup .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === next));
    svg.classList.toggle('tool-create', next !== 'select');
  }

  function select(id) {
    selectedId = id;
    updateInspector();
    scheduleRender();
  }

  function hitItem(target) {
    const g = target.closest?.('[data-id]');
    return g ? items.get(g.getAttribute('data-id')) : null;
  }

  svg.addEventListener('pointerdown', (e) => {
    if (!canvasId || e.button > 0) return;
    svg.focus({ preventScroll: true });
    const p = toCanvas(e);
    const hit = hitItem(e.target);

    try {
      if (tool === 'STICKY_NOTE' || tool === 'SHAPE' || tool === 'TEXT') {
        const d = DEFAULTS[tool];
        createItem({
          type: tool,
          x: Math.round(p.x - d.width / 2),
          y: Math.round(p.y - d.height / 2),
          width: d.width,
          height: d.height,
          color: d.color,
          ...(d.shape ? { shape: d.shape } : {}),
          text: tool === 'TEXT' ? 'Text' : ''
        });
        setTool('select');
        return;
      }

      svg.setPointerCapture(e.pointerId);

      if (tool === 'ARROW') {
        const startOn = hit && hit.type !== 'ARROW' ? hit : null;
        drag = { mode: 'arrow', start: startOn ? centerOf(startOn) : p, fromId: startOn?.id, cur: p };
        return;
      }

      if (e.target.dataset?.handle === 'resize' && hit) {
        drag = { mode: 'resize', id: hit.id };
      } else if (hit) {
        select(hit.id);
        if (hit.type === 'ARROW') { drag = null; return; }
        drag = { mode: 'move', id: hit.id, ox: p.x - hit.x, oy: p.y - hit.y };
      } else {
        select(null);
        drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
        svg.classList.add('panning');
      }
    } catch (error) {
      log(errorMessage(error), true);
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toCanvas(e);

    if (drag.mode === 'pan') {
      view.x = drag.vx + (e.clientX - drag.sx);
      view.y = drag.vy + (e.clientY - drag.sy);
    } else if (drag.mode === 'arrow') {
      drag.cur = p;
    } else {
      const it = items.get(drag.id);
      if (!it) return;
      if (drag.mode === 'move') {
        it.x = Math.round(p.x - drag.ox);
        it.y = Math.round(p.y - drag.oy);
        queueUpdate(it.id, { x: it.x, y: it.y });
      } else if (drag.mode === 'resize') {
        it.width = Math.max(40, Math.round(p.x - it.x));
        it.height = Math.max(30, Math.round(p.y - it.y));
        queueUpdate(it.id, { width: it.width, height: it.height });
      }
    }
    scheduleRender();
  });

  function endDrag(e) {
    if (!drag) return;
    const finished = drag;
    drag = null;
    svg.classList.remove('panning');

    try {
      if (finished.mode === 'move' || finished.mode === 'resize') {
        flushUpdates();
      } else if (finished.mode === 'arrow' && e.type === 'pointerup') {
        const p = toCanvas(e);
        if (Math.hypot(p.x - finished.start.x, p.y - finished.start.y) >= 8) {
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const endOn = under ? hitItem(under) : null;
          const toId = endOn && endOn.type !== 'ARROW' && endOn.id !== finished.fromId ? endOn.id : undefined;
          const fromItem = finished.fromId ? items.get(finished.fromId) : null;
          const startPoint = fromItem ? centerOf(fromItem) : finished.start;
          createItem({
            type: 'ARROW',
            x: Math.round(startPoint.x),
            y: Math.round(startPoint.y),
            endX: Math.round(toId ? centerOf(endOn).x : p.x),
            endY: Math.round(toId ? centerOf(endOn).y : p.y),
            color: '#30382b',
            ...(finished.fromId ? { fromElementId: finished.fromId } : {}),
            ...(toId ? { toElementId: toId } : {})
          });
        }
        setTool('select');
      }
    } catch (error) {
      log(errorMessage(error), true);
    }
    scheduleRender();
  }

  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  svg.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'Escape') {
      setTool('select');
      select(null);
    }
  });

  // ---------- Inspector ----------

  function updateInspector(fromEvent = false) {
    const it = selectedId ? items.get(selectedId) : null;
    $('inspectorHint').hidden = Boolean(it);
    $('inspectorFields').hidden = !it;
    $('inspectorActions').hidden = !it;
    if (!it) return;

    const typing = document.activeElement && $('inspector').contains(document.activeElement);
    if (!(fromEvent && typing)) {
      $('inspText').value = it.text || '';
      $('inspColor').value = it.color || '';
      $('inspShape').value = String(it.shape || 'rectangle').toLowerCase();
    }
    $('inspText').disabled = it.type === 'ARROW';
    $('inspShapeWrap').hidden = it.type !== 'SHAPE';
    $('inspIssueButton').disabled = it.type === 'ARROW' || Boolean(it.linkedIssue);
    $('inspIssueButton').textContent = it.linkedIssue ? 'Issue linked' : 'Convert to issue';
  }

  function commitField(field, value) {
    const it = selectedId ? items.get(selectedId) : null;
    if (!it || it[field] === value) return;
    it[field] = value;
    sendUpdate(it.id, { [field]: value });
    scheduleRender();
  }

  function deleteSelected() {
    if (!selectedId) return;
    send(`/app/canvases/${enc(canvasId)}/elements/${enc(selectedId)}/delete`);
    log('Requested item deletion.');
  }

  $('inspText').addEventListener('change', (e) => run(async () => commitField('text', e.target.value.slice(0, 2000))));
  $('inspColor').addEventListener('change', (e) => run(async () => commitField('color', e.target.value.trim().slice(0, 7))));
  $('inspShape').addEventListener('change', (e) => run(async () => commitField('shape', e.target.value)));
  $('inspFrontButton').addEventListener('click', () => run(async () => {
    const it = items.get(selectedId);
    if (it) commitField('zIndex', nextZ());
  }));
  $('inspDeleteButton').addEventListener('click', () => run(async () => deleteSelected()));
  $('inspIssueButton').addEventListener('click', () => run(async () => {
    const it = selectedId ? items.get(selectedId) : null;
    if (!it) return;
    const title = (window.prompt('Issue title', (it.text || '').split('\n')[0].slice(0, 80)) || '').trim();
    if (!title) return;
    send(`/app/canvases/${enc(canvasId)}/elements/${enc(it.id)}/convert-to-issue`, {
      title,
      description: it.text || ''
    });
    log(`Requested conversion to issue "${title}".`);
  }));

  // ---------- Wiring ----------

  document.querySelectorAll('#toolGroup .tool').forEach((b) => {
    b.addEventListener('click', () => {
      if (!canvasId && b.dataset.tool !== 'select') log('Open a canvas before using drawing tools.', true);
      setTool(b.dataset.tool);
    });
  });

  $('zoomInButton').addEventListener('click', () => zoomCenter(1.25));
  $('zoomOutButton').addEventListener('click', () => zoomCenter(0.8));
  $('zoomResetButton').addEventListener('click', resetView);

  $('wsUrl').addEventListener('input', () => { wsEdited = $('wsUrl').value.trim() !== ''; });
  $('apiUrl').addEventListener('input', syncWsField);
  window.addEventListener('frietsync:view', (e) => { if (e.detail === 'canvas') { syncWsField(); scheduleRender(); } });

  $('loadCanvasesButton').addEventListener('click', () => run(loadCanvases));
  $('newCanvasButton').addEventListener('click', () => run(createCanvas));
  $('openCanvasButton').addEventListener('click', () => run(openCanvas));
  $('closeCanvasButton').addEventListener('click', () => run(async () => disconnectAll()));
  $('renameCanvasButton').addEventListener('click', () => run(async () => renameCanvas()));
  $('deleteCanvasButton').addEventListener('click', () => run(async () => deleteCanvas()));
  window.addEventListener('beforeunload', () => { try { client?.deactivate(); } catch (_) { /* closing */ } });

  syncWsField();
  updateControls();
  updateInspector();
  render();
})();

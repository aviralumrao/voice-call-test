(() => {
  if (!window.FrietSync) return; // app.js failed to load; it already reports that.

  const $ = (id) => document.getElementById(id);
  const { log, api, run, errorMessage, validatedApiBase } = window.FrietSync;

  const MAX_LEN = 1000;
  const WS_TIMEOUT_MS = 120000;
  const REST_TIMEOUT_MS = 120000;
  const QUEUE = '/user/queue/ai-chat';

  let client = null;
  let connectPromise = null;
  let wsUrlEdited = false;
  // requestId (or a temporary key) -> { bubble, startedAt, timer }
  const pending = new Map();
  let awaitingStart = []; // bubbles waiting for a "started" event, oldest first

  // ---------- Small helpers ----------

  function projectId() {
    const id = $('projectId').value.trim();
    if (!id) throw new Error('Enter a project ID first.');
    return id;
  }

  function token() {
    const t = $('token').value.trim();
    if (!t) throw new Error('Enter a bearer token first.');
    return t;
  }

  function derivedWsUrl() {
    try {
      const base = new URL(validatedApiBase());
      const proto = base.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${base.host}/ws`;
    } catch (_) {
      return '';
    }
  }

  function syncWsField(force = false) {
    if (force || !wsUrlEdited) $('ragWsUrl').value = derivedWsUrl();
  }

  function setConn(text) {
    $('ragConn').textContent = text;
  }

  function isWsMode() {
    return $('ragMode').value === 'ws';
  }

  // ---------- Chat rendering ----------

  function scrollToEnd() {
    const box = $('ragMessages');
    box.scrollTop = box.scrollHeight;
  }

  function addMessage(kind, text) {
    $('ragEmpty').hidden = true;
    const el = document.createElement('div');
    el.className = `rag-msg ${kind}`;
    el.textContent = text;
    $('ragMessages').appendChild(el);
    scrollToEnd();
    return el;
  }

  function fillAnswer(bubble, data) {
    bubble.className = 'rag-msg bot';
    bubble.textContent = data?.answer ?? '(The response had no answer field.)';

    const sources = Array.isArray(data?.sources) ? data.sources : [];
    if (sources.length) {
      const list = document.createElement('ul');
      list.className = 'rag-sources';
      const heading = document.createElement('h3');
      heading.textContent = `Sources (${sources.length})`;
      list.appendChild(heading);
      sources.forEach((s) => {
        const li = document.createElement('li');
        li.textContent = s.title || 'Untitled document';
        if (s.documentId) {
          const code = document.createElement('code');
          code.textContent = s.documentId;
          li.appendChild(code);
        }
        list.appendChild(li);
      });
      bubble.appendChild(list);
    }
    scrollToEnd();
  }

  function fillError(bubble, message) {
    bubble.className = 'rag-msg bot error';
    bubble.textContent = message;
    scrollToEnd();
  }

  function setTiming(startedAt) {
    $('ragTiming').textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} s`;
  }

  function setBusy(busy) {
    $('ragSendButton').disabled = busy;
  }

  // ---------- Question handling ----------

  function readQuestion() {
    const q = $('ragQuestion').value.trim();
    if (!q) throw new Error('Type a question first.');
    if (q.length > MAX_LEN) throw new Error(`Questions can be at most ${MAX_LEN} characters.`);
    return q;
  }

  async function askRest(question) {
    const path = `/api/v1/projects/${encodeURIComponent(projectId())}/rag-chat/ask`;
    addMessage('user', question);
    const bubble = addMessage('bot pending', 'Searching the project documents…');
    $('ragRequestId').textContent = 'REST';
    const startedAt = performance.now();
    setBusy(true);
    try {
      const data = await api(path, 'POST', { question }, { timeoutMs: REST_TIMEOUT_MS });
      fillAnswer(bubble, data);
      log(`RAG answer received with ${Array.isArray(data?.sources) ? data.sources.length : 0} source(s).`);
    } catch (error) {
      fillError(bubble, errorMessage(error));
      throw error;
    } finally {
      setTiming(startedAt);
      setBusy(false);
    }
  }

  function askWs(question) {
    if (!client || !client.connected) {
      throw new Error('Connect STOMP first.');
    }
    addMessage('user', question);
    const bubble = addMessage('bot pending', 'Waiting for the server…');
    const entry = { bubble, startedAt: performance.now(), requestId: null, timer: null };
    entry.timer = setTimeout(() => {
      if (!entry.done) {
        entry.done = true;
        awaitingStart = awaitingStart.filter((e) => e !== entry);
        if (entry.requestId) pending.delete(entry.requestId);
        fillError(bubble, `No response after ${WS_TIMEOUT_MS / 1000} seconds.`);
        log('RAG request timed out.', true);
        updateBusyFromPending();
      }
    }, WS_TIMEOUT_MS);
    awaitingStart.push(entry);
    client.publish({
      destination: `/app/projects/${encodeURIComponent(projectId())}/rag-chat`,
      body: JSON.stringify({ question })
    });
    log('RAG question sent over STOMP.');
    setBusy(true);
  }

  function updateBusyFromPending() {
    const stillWaiting = awaitingStart.length > 0 || pending.size > 0;
    setBusy(stillWaiting);
  }

  async function submit() {
    const question = readQuestion();
    if (isWsMode()) {
      projectId();
      askWs(question);
    } else {
      await askRest(question);
    }
    $('ragQuestion').value = '';
    updateCount();
  }

  // ---------- STOMP ----------

  function connectStomp() {
    if (client && client.connected) return Promise.resolve();
    if (connectPromise) return connectPromise;

    connectPromise = new Promise((resolve, reject) => {
      if (!window.StompJs) return reject(new Error('STOMP client library is unavailable. Check the Network tab.'));
      const t = token();
      const url = $('ragWsUrl').value.trim();
      if (!url) return reject(new Error('Enter the STOMP WebSocket URL.'));
      if (location.protocol === 'https:' && url.startsWith('ws:')) {
        return reject(new Error('The page is HTTPS but the URL is ws://. Browsers block this. Use wss://.'));
      }

      setConn('Connecting…');
      $('ragConnectButton').disabled = true;
      log(`Connecting STOMP to ${url}`);

      const c = new StompJs.Client({
        brokerURL: url,
        connectHeaders: { Authorization: `Bearer ${t}` },
        reconnectDelay: 0,
        heartbeatIncoming: 0,
        heartbeatOutgoing: 10000
      });
      client = c;

      c.onConnect = () => {
        c.subscribe(QUEUE, (message) => handleWsMessage(message.body));
        setConn('Connected');
        $('ragDisconnectButton').disabled = false;
        log(`STOMP connected and subscribed to ${QUEUE}.`);
        resolve();
      };
      c.onStompError = (frame) => {
        const detail = frame.headers?.message || frame.body || 'unknown error';
        log(`STOMP error: ${detail}`, true);
        if (frame.body && frame.body !== detail) log(`STOMP error body: ${String(frame.body).slice(0, 400)}`, true);
        reject(new Error(`STOMP error: ${detail}`));
      };
      c.onWebSocketError = () => {
        reject(new Error(`Could not open ${url}. Check the URL, TLS and CORS or origin settings.`));
      };
      c.onWebSocketClose = () => {
        const wasCurrent = client === c;
        if (wasCurrent) {
          client = null;
          setConn('Not connected');
          $('ragConnectButton').disabled = false;
          $('ragDisconnectButton').disabled = true;
          log('STOMP connection closed.', true);
          failAllPending('The connection closed before an answer arrived.');
        }
        reject(new Error('WebSocket closed before STOMP connected.'));
      };
      c.activate();
    }).catch((error) => {
      setConn('Not connected');
      $('ragConnectButton').disabled = false;
      if (client && !client.connected) { try { client.deactivate(); } catch (_) { /* closing */ } client = null; }
      throw error;
    }).finally(() => { connectPromise = null; });

    return connectPromise;
  }

  function disconnectStomp() {
    if (!client) return;
    const c = client;
    client = null;
    try { c.deactivate(); } catch (_) { /* closing */ }
    setConn('Not connected');
    $('ragConnectButton').disabled = false;
    $('ragDisconnectButton').disabled = true;
    failAllPending('Disconnected before an answer arrived.');
    log('STOMP disconnected.');
  }

  function handleWsMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      log(`Unreadable RAG message: ${String(raw).slice(0, 300)}`, true);
      return;
    }

    if (msg.type === 'started') {
      const entry = awaitingStart.shift();
      if (entry) {
        entry.requestId = msg.requestId || null;
        if (entry.requestId) pending.set(entry.requestId, entry);
        entry.bubble.textContent = 'Working on it…';
      }
      $('ragRequestId').textContent = msg.requestId || '—';
      log(`RAG request started${msg.requestId ? `: ${msg.requestId}` : ''}.`);
      return;
    }

    if (msg.type === 'completed') {
      const entry = takeEntry(msg.requestId);
      if (!entry) { log('Got a completed message with no matching question.', true); return; }
      entry.done = true;
      clearTimeout(entry.timer);
      if (entry.requestId) pending.delete(entry.requestId);
      fillAnswer(entry.bubble, msg.response ?? msg.data);
      setTiming(entry.startedAt);
      log(`RAG request completed${msg.requestId ? `: ${msg.requestId}` : ''}.`);
      updateBusyFromPending();
      return;
    }

    if (msg.type === 'error') {
      const err = msg.error ?? msg.data;
      const detail = (typeof err === 'string' ? err : err?.message) || 'The server reported an error.';
      const entry = takeEntry(msg.requestId);
      if (entry) {
        entry.done = true;
        clearTimeout(entry.timer);
        if (entry.requestId) pending.delete(entry.requestId);
        fillError(entry.bubble, detail);
        setTiming(entry.startedAt);
      }
      log(`RAG error: ${detail}`, true);
      updateBusyFromPending();
      return;
    }

    log(`Unrecognised RAG message type "${msg.type}": ${String(raw).slice(0, 300)}`, true);
  }

  function failAllPending(message) {
    const all = [...awaitingStart, ...pending.values()];
    all.forEach((entry) => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(entry.timer);
      fillError(entry.bubble, message);
    });
    awaitingStart = [];
    pending.clear();
    setBusy(false);
  }

  function takeEntry(requestId) {
    if (requestId && pending.has(requestId)) return pending.get(requestId);
    // No matching id: fall back to the oldest request still waiting.
    const waiting = awaitingStart.shift();
    if (waiting) {
      waiting.requestId = requestId || null;
      return waiting;
    }
    return pending.values().next().value || null;
  }

  // ---------- UI wiring ----------

  function updateCount() {
    $('ragCount').textContent = `${$('ragQuestion').value.length} / ${MAX_LEN}`;
  }

  function applyMode() {
    const ws = isWsMode();
    $('ragWsSettings').hidden = !ws;
    if (ws) {
      syncWsField();
      setConn(client && client.connected ? 'Connected' : 'Not connected');
    } else {
      setConn('REST (no connection needed)');
    }
  }

  $('ragMode').addEventListener('change', applyMode);
  $('ragQuestion').addEventListener('input', updateCount);
  $('ragQuestion').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run(submit);
    }
  });
  $('ragSendButton').addEventListener('click', () => run(submit));
  $('ragConnectButton').addEventListener('click', () => run(connectStomp));
  $('ragDisconnectButton').addEventListener('click', () => disconnectStomp());
  $('ragClearButton').addEventListener('click', () => {
    const box = $('ragMessages');
    box.querySelectorAll('.rag-msg').forEach((n) => n.remove());
    $('ragEmpty').hidden = false;
  });
  $('ragWsUrl').addEventListener('input', () => { wsUrlEdited = true; });
  ['apiUrl', 'projectId'].forEach((id) => {
    $(id).addEventListener('input', () => { if (isWsMode()) syncWsField(); });
  });
  window.addEventListener('frietsync:view', (e) => { if (e.detail === 'rag') applyMode(); });
  window.addEventListener('beforeunload', () => { try { client?.deactivate(); } catch (_) { /* closing */ } });

  updateCount();
  applyMode();
})();

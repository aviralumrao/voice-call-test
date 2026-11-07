(() => {
  const $ = (id) => document.getElementById(id);
  const logList = $('log');

  let janus = null;
  let pub = null;            // publisher handle (our own camera and mic)
  let myId = null;
  let myPrivateId = null;
  let currentRoom = null;
  let currentPin = null;
  let localVideo = null;
  let localTile = null;
  let call = null;
  let joinedBackend = false;
  let connecting = false;
  let janusInitialized = false;
  const feeds = new Map();   // feedId -> { id, handle, tile, video, stream }

  function log(message, error = false) {
    const item = document.createElement('li');
    item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    if (error) item.className = 'error';
    logList.prepend(item);
  }

  const errorMessage = (e) => (e instanceof Error ? e.message : String(e ?? 'Unknown error'));

  window.addEventListener('error', (e) => log(`Page script error: ${e.message}`, true));
  window.addEventListener('unhandledrejection', (e) => log(`Async error: ${errorMessage(e.reason)}`, true));

  $('appStatus').textContent = 'Controls loaded. API requests will be reported in Activity.';

  function setMediaState(text) {
    $('mediaState').textContent = text;
  }

  function setCallControls(inCall) {
    ['leaveButton', 'endButton', 'muteButton', 'cameraButton'].forEach((id) => {
      $(id).disabled = !inCall;
    });
  }

  // ---------- Backend API (same endpoints as the voice test) ----------

  function validatedApiBase() {
    const value = $('apiUrl').value.trim().replace(/\/$/, '');
    if (!value) throw new Error('Enter the backend API base URL.');
    let url;
    try {
      url = new URL(value);
    } catch (_) {
      throw new Error('Backend API base URL is invalid. Include http:// or https://.');
    }
    if (location.protocol === 'https:' && url.protocol === 'http:') {
      throw new Error('The page is HTTPS but the API URL is HTTP. Browsers block this. Use an HTTPS API URL.');
    }
    return url.origin + url.pathname.replace(/\/$/, '');
  }

  function projectCallsPath() {
    const projectId = $('projectId').value.trim();
    if (!projectId) throw new Error('Enter a project ID first.');
    return `/api/v1/projects/${encodeURIComponent(projectId)}/calls`;
  }

  async function api(path, method = 'POST', payload = null, opts = {}) {
    const token = $('token').value.trim();
    if (!token) throw new Error('Enter a bearer token first.');

    const url = `${validatedApiBase()}${path}`;
    if (!opts.quiet) log(`Sending ${method} ${url}`);

    let response;
    try {
      response = await fetch(url, {
        method,
        mode: 'cors',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json' } : {})
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new Error(`Request timed out after 20 seconds: ${method} ${url}`);
      }
      throw new Error(`Could not complete ${method} ${url}. Check CORS, DNS/TLS and the API URL. (${errorMessage(error)})`);
    }

    if (!opts.quiet || !response.ok) log(`Received HTTP ${response.status} ${response.statusText || ''}`.trim(), !response.ok);

    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_) {
      body = text;
    }

    if (!response.ok) {
      const detail = body && typeof body === 'object'
        ? (body.message || body.error || body.detail || JSON.stringify(body))
        : body;
      const hints = {
        401: 'Check that the bearer token is valid and not expired.',
        403: 'The account may not have permission for this project or action.',
        404: 'Check the project ID, call ID, and API route.',
        429: 'The backend is rate limiting requests.'
      };
      throw new Error(
        `Backend returned HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 500)}` : ''} ${hints[response.status] || ''}`.trim()
      );
    }
    return body;
  }

  function showCall(data) {
    call = data;
    $('callId').value = data.id || '';
    $('roomId').textContent = data.roomId ?? '—';
    $('roomPin').textContent = data.roomPin || '(no PIN configured)';
    setCallControls(true);
  }

  async function startCall() {
    const type = $('callType').value;
    const data = await api(projectCallsPath(), 'POST', { type });
    showCall(data);
    log(`Call started (${type}). Call ID ${data.id}; room ${data.roomId}.`);
  }

  async function findActiveCall() {
    // The backend looks up active calls per type and defaults to VOICE.
    const type = $('callType').value;
    const data = await api(`${projectCallsPath()}/active?type=${encodeURIComponent(type)}`, 'GET');
    showCall(data);
    log(`Found active call ${data.id}.`);
  }

  // ---------- Video tiles ----------

  function makeTile(label, local) {
    const tile = document.createElement('figure');
    tile.className = local ? 'tile local' : 'tile';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (local) video.muted = true; // never play our own mic back
    const caption = document.createElement('figcaption');
    caption.textContent = label;
    tile.append(video, caption);
    $('videoGrid').append(tile);
    return { tile, video };
  }

  function playVideo(video) {
    video.play().catch((error) => {
      $('remotePlaybackState').textContent = 'Browser blocked playback. Click Enable remote audio.';
      log(`Playback blocked (${error.name}). Click Enable remote audio.`, true);
    });
  }

  async function enableRemoteAudio() {
    const videos = Array.from($('videoGrid').querySelectorAll('.tile:not(.local) video'));
    const results = await Promise.allSettled(videos.map((v) => v.play()));
    const blocked = results.filter((r) => r.status === 'rejected').length;
    $('remotePlaybackState').textContent = blocked
      ? 'The browser still blocks playback. Check site sound permissions.'
      : `Playing ${videos.length} remote stream${videos.length === 1 ? '' : 's'}.`;
    log(`Remote playback enabled for ${videos.length} stream(s).`);
  }

  // ---------- Janus ----------

  function initJanus() {
    if (janusInitialized) return Promise.resolve();
    return new Promise((resolve) => {
      Janus.init({ debug: 'warn', callback: () => { janusInitialized = true; resolve(); } });
    });
  }

  async function connectVideo(roomId, roomPin) {
    if (!window.Janus) throw new Error('Janus client library is unavailable. Check the Network tab.');

    const server = $('janusUrl').value.trim();
    if (!server) throw new Error('Enter the Janus WebSocket URL.');

    currentRoom = Number(roomId);
    currentPin = roomPin || null;
    setMediaState('Connecting…');
    await initJanus();

    await new Promise((resolve, reject) => {
      const myJanus = new Janus({
        server,

        success: () => myJanus.attach({
          plugin: 'janus.plugin.videoroom',

          success: (handle) => {
            pub = handle;
            const request = {
              request: 'join',
              ptype: 'publisher',
              room: currentRoom,
              display: `FrietSync ${Math.random().toString(36).slice(2, 7)}`
            };
            if (currentPin) request.pin = currentPin;
            handle.send({ message: request });
            resolve();
          },

          error: (error) => reject(new Error(`VideoRoom attach failed: ${error}`)),

          onmessage: (message, jsep) => {
            if (janus === myJanus) onPublisherMessage(message, jsep);
          },

          onlocaltrack: (track, added) => {
            if (!localVideo) {
              ({ tile: localTile, video: localVideo } = makeTile('You', true));
              localVideo.srcObject = new MediaStream();
            }
            const stream = localVideo.srcObject;
            if (added) {
              stream.addTrack(track);
              playVideo(localVideo);
              log(`Local ${track.kind} ready.`);
            } else {
              stream.removeTrack(track);
            }
          },

          oncleanup: () => {
            if (localTile) localTile.remove();
            localTile = null;
            localVideo = null;
          }
        }),

        error: (error) => reject(new Error(`Janus connection failed: ${error}`)),

        destroyed: () => {
          if (janus === myJanus) { janus = null; pub = null; }
        }
      });
      janus = myJanus;
    });
  }

  function onPublisherMessage(message, jsep) {
    const event = message?.videoroom;

    if (event === 'joined') {
      myId = message.id;
      myPrivateId = message.private_id;
      log(`Joined Janus room ${message.room} as ${myId}.`);
      setMediaState('Joined room, starting camera');
      publishOwnFeed();
      (message.publishers || []).forEach(addFeed);
    } else if (event === 'destroyed') {
      log('The room was destroyed by the server.', true);
      leaveCall().catch((e) => log(errorMessage(e), true));
    } else if (event === 'event') {
      if (message.error) log(`VideoRoom error ${message.error_code}: ${message.error}`, true);
      (message.publishers || []).forEach(addFeed);
      if (message.leaving && message.leaving !== 'ok') removeFeed(message.leaving);
      if (message.unpublished && message.unpublished !== 'ok') removeFeed(message.unpublished);
    }

    if (jsep) pub.handleRemoteJsep({ jsep });
  }

  function publishOwnFeed() {
    pub.createOffer({
      tracks: [
        { type: 'audio', capture: true, recv: false },
        // Modest capture size keeps bandwidth low on the small server.
        { type: 'video', capture: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } }, recv: false }
      ],
      success: (offer) => {
        log('Camera and microphone offer created.');
        pub.send({ message: { request: 'configure', audio: true, video: true }, jsep: offer });
        setMediaState('Connected');
      },
      error: (error) => {
        log(`Could not start camera or microphone: ${error}`, true);
        setMediaState('Camera or microphone error');
      }
    });
  }

  // One subscriber handle per remote publisher.
  function addFeed(publisher) {
    if (!publisher || publisher.id === myId || feeds.has(publisher.id)) return;

    const label = publisher.display || `User ${publisher.id}`;
    const { tile, video } = makeTile(label, false);
    const feed = { id: publisher.id, handle: null, tile, video, stream: new MediaStream() };
    video.srcObject = feed.stream;
    feeds.set(publisher.id, feed);
    log(`${label} is in the room. Subscribing.`);

    janus.attach({
      plugin: 'janus.plugin.videoroom',

      success: (handle) => {
        feed.handle = handle;
        const request = {
          request: 'join',
          ptype: 'subscriber',
          room: currentRoom,
          streams: [{ feed: publisher.id }]
        };
        if (myPrivateId) request.private_id = myPrivateId;
        if (currentPin) request.pin = currentPin;
        handle.send({ message: request });
      },

      error: (error) => log(`Subscriber attach failed: ${error}`, true),

      onmessage: (message, jsep) => {
        if (message.error) log(`Subscriber error ${message.error_code}: ${message.error}`, true);
        if (!jsep) return;
        feed.handle.createAnswer({
          jsep,
          tracks: [{ type: 'data' }],
          success: (answer) => feed.handle.send({
            message: { request: 'start', room: currentRoom },
            jsep: answer
          }),
          error: (error) => log(`Answer failed: ${error}`, true)
        });
      },

      onremotetrack: (track, mid, added) => {
        if (added) {
          feed.stream.addTrack(track);
          playVideo(feed.video);
          log(`Remote ${track.kind} from ${label} received.`);
        } else {
          feed.stream.removeTrack(track);
        }
      }
    });
  }

  function removeFeed(id) {
    const feed = feeds.get(Number(id)) || feeds.get(id);
    if (!feed) return;
    try { feed.handle?.detach(); } catch (_) { /* already gone */ }
    feed.video.srcObject = null;
    feed.tile.remove();
    feeds.delete(feed.id);
    log(`Participant ${feed.id} left.`);
  }

  async function disconnectMedia() {
    feeds.forEach((_, id) => removeFeed(id));

    if (pub) {
      try { pub.send({ message: { request: 'leave' } }); } catch (_) { /* connection may be gone */ }
    }
    if (janus) {
      try { janus.destroy(); } catch (_) { /* connection may be gone */ }
    }

    // Make sure the camera light goes off.
    localVideo?.srcObject?.getTracks().forEach((t) => t.stop());
    localTile?.remove();

    janus = null;
    pub = null;
    myId = null;
    myPrivateId = null;
    localTile = null;
    localVideo = null;

    $('videoGrid').replaceChildren();
    $('muteButton').textContent = 'Mute microphone';
    $('cameraButton').textContent = 'Turn camera off';
    setMediaState('Disconnected');
  }

  // ---------- Call actions ----------

  async function joinCall() {
    if (connecting) return;
    connecting = true;
    try {
      if (janus || pub) await disconnectMedia();

      const callId = $('callId').value.trim();
      if (!callId) throw new Error('Enter a call ID or find an active call first.');

      const data = await api(`${projectCallsPath()}/${encodeURIComponent(callId)}/join`);
      showCall(data);
      joinedBackend = true;
      log(`Backend authorized join for call ${data.id}.`);

      await connectVideo(data.roomId, data.roomPin);
    } finally {
      connecting = false;
    }
  }

  async function leaveCall() {
    const callId = $('callId').value.trim();
    await disconnectMedia();
    if (joinedBackend && callId) {
      await api(`${projectCallsPath()}/${encodeURIComponent(callId)}/leave`);
    }
    joinedBackend = false;
    setCallControls(false);
    log('Left the call.');
  }

  async function endCall() {
    const callId = $('callId').value.trim();
    if (!callId) throw new Error('There is no call ID to end.');
    await disconnectMedia();
    const data = await api(`${projectCallsPath()}/${encodeURIComponent(callId)}/end`);
    showCall(data);
    setCallControls(false);
    joinedBackend = false;
    setMediaState('Call ended');
    log('Call ended and Janus room destroyed.');
  }

  function toggleMute() {
    if (!pub) return;
    if (pub.isAudioMuted()) pub.unmuteAudio(); else pub.muteAudio();
    $('muteButton').textContent = pub.isAudioMuted() ? 'Unmute microphone' : 'Mute microphone';
  }

  function toggleCamera() {
    if (!pub) return;
    if (pub.isVideoMuted()) pub.unmuteVideo(); else pub.muteVideo();
    $('cameraButton').textContent = pub.isVideoMuted() ? 'Turn camera on' : 'Turn camera off';
  }

  async function run(action) {
    try {
      await action();
    } catch (error) {
      log(errorMessage(error), true);
    }
  }

  // ---------- Nav bar (Video call / Live canvas) ----------

  const views = {
    video: {
      eyebrow: 'FRIETSYNC · VIDEOROOM',
      title: 'Video call test',
      intro: 'Open two browser windows (or one on your phone) to test a call. Each participant needs a valid FrietSync bearer token and project membership.',
      footer: "Video needs camera and microphone permission and a secure context (HTTPS or localhost). The server's UDP ports 10000-10200 must be reachable."
    },
    canvas: {
      eyebrow: 'FRIETSYNC · CANVAS',
      title: 'Live canvas test',
      intro: 'Open the same canvas in two browser windows and edit in one to watch the other update. Editing needs an editor role; viewing needs project membership.',
      footer: 'Edits are sent over STOMP and the canvas only changes when the server broadcasts the result, so what you see is what the backend stored.'
    }
  };

  function showView(name) {
    if (!views[name]) name = 'video';
    Object.keys(views).forEach((key) => {
      $(`view-${key}`).hidden = key !== name;
      const tab = $(key === 'video' ? 'tabVideo' : 'tabCanvas');
      tab.classList.toggle('active', key === name);
      tab.setAttribute('aria-selected', String(key === name));
    });
    $('pageEyebrow').textContent = views[name].eyebrow;
    $('pageTitle').textContent = views[name].title;
    $('pageIntro').textContent = views[name].intro;
    $('pageFooter').textContent = views[name].footer;
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
    window.dispatchEvent(new CustomEvent('frietsync:view', { detail: name }));
  }

  document.querySelectorAll('.nav-tab').forEach((tab) => {
    tab.addEventListener('click', () => showView(tab.dataset.view));
  });
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

  // Shared helpers for canvas.js
  window.FrietSync = { log, api, run, errorMessage, validatedApiBase, showView };
  showView(location.hash.slice(1) || 'video');

  $('startButton').addEventListener('click', () => run(startCall));
  $('activeButton').addEventListener('click', () => run(findActiveCall));
  $('joinButton').addEventListener('click', () => run(joinCall));
  $('leaveButton').addEventListener('click', () => run(leaveCall));
  $('endButton').addEventListener('click', () => run(endCall));
  $('muteButton').addEventListener('click', () => run(toggleMute));
  $('cameraButton').addEventListener('click', () => run(toggleCamera));
  $('enableAudioButton').addEventListener('click', () => run(enableRemoteAudio));
  $('clearLogButton').addEventListener('click', () => logList.replaceChildren());
  window.addEventListener('beforeunload', () => { if (janus) janus.destroy(); });
})();

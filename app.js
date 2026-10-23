(() => {
  const $ = (id) => document.getElementById(id);
  const logList = $('log');
  let janus = null;
  let plugin = null;
  let call = null;
  let muted = false;
  let joinedBackend = false;
  let remotePlaybackEnabled = false;
  let micMeter = null;
  const incomingMeters = new Map();
  let audioContext = null;
  let meterFrame = null;

  function log(message, error = false) {
    const item = document.createElement('li');
    item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    if (error) item.className = 'error';
    logList.prepend(item);
  }

  window.addEventListener('error', (event) => {
    log(`Page script error: ${event.message || 'Unknown JavaScript error'}${event.filename ? ` (${event.filename}:${event.lineno})` : ''}`, true);
  });
  window.addEventListener('unhandledrejection', (event) => {
    log(`Unexpected async error: ${errorMessage(event.reason)}`, true);
  });
  $('appStatus').textContent = 'Controls loaded. API requests will be reported in Activity.';

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error ?? 'Unknown error');
  }

  function setAudioState(text) { $('audioState').textContent = text; }
  function setCallControls(inCall) {
    $('leaveButton').disabled = !inCall;
    $('endButton').disabled = !inCall;
    $('muteButton').disabled = !inCall;
    $('hangupButton').disabled = !inCall;
  }

  function getAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!audioContext) audioContext = new AudioContextClass();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    return audioContext;
  }

  function createMeter(stream) {
    const context = getAudioContext();
    if (!context) return null;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    return { analyser, samples: new Uint8Array(analyser.fftSize) };
  }

  function startMeterUpdates() {
    if (meterFrame !== null) return;
    const update = () => {
      const level = (meter) => {
        if (!meter) return 0;
        meter.analyser.getByteTimeDomainData(meter.samples);
        let sum = 0;
        for (const sample of meter.samples) {
          const value = (sample - 128) / 128;
          sum += value * value;
        }
        return Math.min(1, Math.sqrt(sum / meter.samples.length) * 4);
      };
      const mic = muted ? 0 : level(micMeter);
      const incoming = Math.max(0, ...Array.from(incomingMeters.values(), level));
      $('micLevel').value = mic;
      $('micLevelText').textContent = `${Math.round(mic * 100)}%`;
      $('incomingLevel').value = incoming;
      $('incomingLevelText').textContent = `${Math.round(incoming * 100)}%`;
      meterFrame = requestAnimationFrame(update);
    };
    meterFrame = requestAnimationFrame(update);
  }

  function stopMeterUpdates() {
    if (meterFrame !== null) cancelAnimationFrame(meterFrame);
    meterFrame = null;
    micMeter = null;
    incomingMeters.clear();
    $('micLevel').value = $('incomingLevel').value = 0;
    $('micLevelText').textContent = $('incomingLevelText').textContent = '0%';
  }

  function applySpeakerVolume() {
    const volume = Number($('speakerVolume').value) / 100;
    $('speakerVolumeText').textContent = `${Math.round(volume * 100)}%`;
    $('remoteAudio').querySelectorAll('audio').forEach((audio) => { audio.volume = volume; });
  }


  function apiBase() { return $('apiUrl').value.trim().replace(/\/$/, ''); }
  function validatedApiBase() {
    const value = apiBase();
    if (!value) throw new Error('Enter the backend API base URL.');
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('Backend API base URL is invalid. Include http:// or https://.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Backend API URL must use HTTP or HTTPS.');
    if (location.protocol === 'https:' && url.protocol === 'http:') throw new Error('The page is HTTPS but the API URL is HTTP; browsers block this mixed-content request. Use an HTTPS API URL.');
    return url.origin + url.pathname.replace(/\/$/, '');
  }
  function projectCallsPath() {
    const projectId = $('projectId').value.trim();
    if (!projectId) throw new Error('Enter a project ID first.');
    return `/api/v1/projects/${encodeURIComponent(projectId)}/calls`;
  }

  async function api(path, method = 'POST') {
    const token = $('token').value.trim();
    if (!token) throw new Error('Enter a bearer token first.');
    const base = validatedApiBase();
    const url = `${base}${path}`;
    log(`Sending ${method} ${url}`);
    let response;
    try {
      response = await fetch(url, {
        method,
        mode: 'cors',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error(`Request timed out after 20 seconds: ${method} ${url}`);
      throw new Error(`Could not complete ${method} ${url}. This is commonly caused by CORS, DNS/TLS, a blocked request, or the API being unreachable. Check the browser Console and Network tab. (${errorMessage(error)})`);
    }
    log(`Received HTTP ${response.status} ${response.statusText || ''}`.trim(), !response.ok);
    let text;
    try { text = await response.text(); }
    catch (error) { throw new Error(`Received HTTP ${response.status}, but could not read the response body: ${errorMessage(error)}`); }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    if (!response.ok) {
      const detail = body && typeof body === 'object' ? (body.message || body.error || body.detail || JSON.stringify(body)) : body;
      const hints = { 401: 'Check that the bearer token is valid and not expired.', 403: 'The account may not have permission for this project or action.', 404: 'Check the project ID, call ID, and API route.', 429: 'The backend is rate limiting requests.' };
      throw new Error(`Backend returned HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 500)}` : ''}${hints[response.status] ? ` ${hints[response.status]}` : ''}`);
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
    const data = await api(projectCallsPath());
    showCall(data);
    log(`Call started. Call ID ${data.id}; room ${data.roomId}.`);
  }

  async function findActiveCall() {
    const data = await api(`${projectCallsPath()}/active`, 'GET');
    showCall(data);
    log(`Found active call ${data.id}.`);
  }

  async function connectAudio(roomId, roomPin) {
    if (!window.Janus) throw new Error('Janus client library is unavailable. Check the page status above and the browser Network/Console tabs for the Janus script request.');
    const server = $('janusUrl').value.trim();
    if (!server) throw new Error('Enter the Janus WebSocket URL.');
    setAudioState('Connecting…');
    await new Promise((resolve, reject) => {
      Janus.init({ debug: 'warn', callback: () => {
        janus = new Janus({
          server,
          success: () => janus.attach({
            plugin: 'janus.plugin.audiobridge',
            success: (handle) => {
              plugin = handle;
              const request = { request: 'join', room: Number(roomId), display: `FrietSync ${Math.random().toString(36).slice(2, 7)}` };
              if (roomPin) request.pin = roomPin;
              plugin.send({ message: request });
              resolve();
            },
            error: (error) => reject(new Error(`AudioBridge attach failed: ${error}`)),
            onmessage: (message, jsep) => onPluginMessage(message, jsep),
            onlocaltrack: (track, added) => {
              log(`Local microphone ${added ? 'ready' : 'removed'}.`);
              if (added && track.kind === 'audio') {
                micMeter = createMeter(new MediaStream([track]));
                startMeterUpdates();
              } else if (!added) micMeter = null;
            },
            onremotetrack: (track, mid, added) => onRemoteTrack(track, mid, added),
            oncleanup: () => { plugin = null; setAudioState('Disconnected'); }
          }),
          error: (error) => reject(new Error(`Janus connection failed: ${error}`)),
          destroyed: () => { janus = null; plugin = null; }
        });
      } });
    });
  }

  function onPluginMessage(message, jsep) {
    const event = message && message.audiobridge;
    if (event === 'joined') {
      setAudioState('Connected · microphone on');
      log(`Joined Janus room ${message.room}.`);
      plugin.createOffer({
        media: { audio: true, video: false },
        success: (offer) => plugin.send({ message: { request: 'configure', muted: false }, jsep: offer }),
        error: (error) => { log(`Microphone offer failed: ${error}`, true); setAudioState('Microphone error'); }
      });
    } else if (event === 'event') {
      const publishers = message.publishers || [];
      if (publishers.length) log(`${publishers.length} participant(s) already in the room.`);
      if (message.leaving) log(`Participant ${message.leaving} left the room.`);
      if (message.unpublished) log(`Participant ${message.unpublished} stopped publishing.`);
    }
    if (jsep) plugin.handleRemoteJsep({ jsep });
  }

  function onRemoteTrack(track, mid, added) {
    if (!track || track.kind !== 'audio') return;
    const id = `remote-${mid}`;
    let audio = document.getElementById(id);
    if (added) {
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = id;
        audio.autoplay = true;
        audio.playsInline = true;
        $('remoteAudio').append(audio);
        audio.addEventListener('playing', () => {
          $('remotePlaybackState').textContent = 'Remote audio is playing in this browser.';
          log(`Remote audio ${id} is playing.`);
        });
        audio.addEventListener('waiting', () => { $('remotePlaybackState').textContent = 'Remote audio track exists but is waiting for media.'; });
        audio.addEventListener('error', () => {
          $('remotePlaybackState').textContent = 'Browser could not play the remote audio element. Click Enable remote audio.';
          log(`Remote audio ${id} playback error${audio.error ? ` (code ${audio.error.code})` : ''}.`, true);
        });
      }
      audio.srcObject = new MediaStream([track]);
      audio.volume = Number($('speakerVolume').value) / 100;
      $('enableAudioButton').disabled = false;
      $('remotePlaybackState').textContent = 'Remote audio track received. Checking browser playback…';
      const meter = createMeter(new MediaStream([track]));
      if (meter) incomingMeters.set(id, meter);
      startMeterUpdates();
      audio.play().catch((error) => {
        $('remotePlaybackState').textContent = 'Remote track is connected, but browser playback is blocked. Click Enable remote audio.';
        log(`Remote audio ${id} arrived but playback was blocked (${error.name}). ${remotePlaybackEnabled ? 'Check browser sound permissions and Console.' : 'Click Enable remote audio.'}`, true);
      });
      log(`Remote audio track ${id} received from Janus.`);
    } else if (audio) {
      audio.srcObject = null;
      audio.remove();
      incomingMeters.delete(id);
      log(`Remote audio track ${id} ended.`);
      if (!incomingMeters.size) {
        $('remotePlaybackState').textContent = 'No remote audio tracks are currently active.';
      }
    }
  }

  async function enableRemoteAudio() {
    remotePlaybackEnabled = true;
    $('enableAudioButton').textContent = 'Remote audio enabled';
    const tracks = Array.from($('remoteAudio').querySelectorAll('audio'));
    if (!tracks.length) {
      $('remotePlaybackState').textContent = 'Remote playback enabled. Waiting for another participant’s audio track.';
      log('Remote audio playback enabled; waiting for participants.');
      return;
    }
    if (audioContext && audioContext.state === 'suspended') await audioContext.resume();
    const results = await Promise.allSettled(tracks.map((audio) => audio.play()));
    const blocked = results.filter((result) => result.status === 'rejected');
    if (blocked.length) {
      $('remotePlaybackState').textContent = 'The browser still blocks playback. Check site sound permissions and the Console.';
      throw new Error(`Could not start ${blocked.length} remote audio stream(s): ${blocked[0].reason?.message || blocked[0].reason}`);
    }
    $('remotePlaybackState').textContent = `Playing ${tracks.length} remote audio stream${tracks.length === 1 ? '' : 's'}.`;
    log(`Remote audio playback enabled for ${tracks.length} stream(s).`);
  }

  async function joinCall() {
    const callId = $('callId').value.trim();
    if (!callId) throw new Error('Enter a call ID or find an active call first.');
    const data = await api(`${projectCallsPath()}/${encodeURIComponent(callId)}/join`);
    showCall(data);
    joinedBackend = true;
    log(`Backend authorized join for call ${data.id}.`);
    await connectAudio(data.roomId, data.roomPin);
  }

  async function disconnectAudio() {
    if (plugin) {
      try { plugin.send({ message: { request: 'leave' } }); } catch (_) { /* Connection may already be gone. */ }
    }
    if (janus) {
      try { janus.destroy(); } catch (_) { /* Connection may already be gone. */ }
    }
    janus = null;
    plugin = null;
    $('remoteAudio').replaceChildren();
    stopMeterUpdates();
    $('enableAudioButton').disabled = false;
    $('enableAudioButton').textContent = 'Enable remote audio';
    remotePlaybackEnabled = false;
    $('remotePlaybackState').textContent = 'Disconnected. Click Enable remote audio before joining again.';
    setAudioState('Disconnected');
  }

  async function leaveCall() {
    const callId = $('callId').value.trim();
    await disconnectAudio();
    if (joinedBackend && callId) await api(`${projectCallsPath()}/${encodeURIComponent(callId)}/leave`);
    joinedBackend = false;
    setCallControls(false);
    log('Left the call.');
  }

  async function endCall() {
    const callId = $('callId').value.trim();
    if (!callId) throw new Error('There is no call ID to end.');
    await disconnectAudio();
    const data = await api(`${projectCallsPath()}/${encodeURIComponent(callId)}/end`);
    showCall(data);
    setCallControls(false);
    joinedBackend = false;
    setAudioState('Call ended');
    log('Call ended and Janus room destroyed.');
  }

  async function toggleMute() {
    if (!plugin) return;
    muted = !muted;
    plugin.send({ message: { request: 'configure', muted } });
    $('muteButton').textContent = muted ? 'Unmute microphone' : 'Mute microphone';
    setAudioState(muted ? 'Connected · microphone muted' : 'Connected · microphone on');
  }

  async function run(action) {
    try { await action(); } catch (error) { log(errorMessage(error), true); }
  }

  $('startButton').addEventListener('click', () => run(startCall));
  $('activeButton').addEventListener('click', () => run(findActiveCall));
  $('joinButton').addEventListener('click', () => run(joinCall));
  $('leaveButton').addEventListener('click', () => run(leaveCall));
  $('endButton').addEventListener('click', () => run(endCall));
  $('muteButton').addEventListener('click', () => run(toggleMute));
  $('hangupButton').addEventListener('click', () => run(disconnectAudio));
  $('enableAudioButton').addEventListener('click', () => run(enableRemoteAudio));
  $('speakerVolume').addEventListener('input', applySpeakerVolume);
  $('clearLogButton').addEventListener('click', () => logList.replaceChildren());
  window.addEventListener('beforeunload', () => { if (janus) janus.destroy(); });
})();
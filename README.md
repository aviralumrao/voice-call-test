# FrietSync voice call test page

This is a standalone browser client for testing FrietSync's call API and Janus AudioBridge. It does not require a frontend build step; serve this folder over HTTP or deploy it as a static site. Microphone access requires HTTPS or `localhost`.

## Deploy to Vercel

Import the repository in Vercel and set **Root Directory** to `voice-call-test`. Leave the framework preset as **Other**, leave the build command blank, and set the output directory to `.`. Vercel serves `index.html` directly; `vercel.json` adds basic browser security headers.

After deployment, copy the exact site origin (for example, `https://your-test.vercel.app`) into the backend's `app.cors.allowed-origins` setting. The backend must be reachable over HTTPS from the browser. If you use Vercel preview deployments, allow each preview origin you intend to test. The Janus WebSocket URL must use `wss://` from the deployed HTTPS page; `ws://` and `localhost` are only useful for local testing. Janus's WebRTC media UDP ports must also be reachable by the testing browsers.

Open the deployed site in two browser windows and fill in the backend URL, Janus WebSocket URL, project ID, and bearer token in each. Tokens are held in the page's memory and are not stored by this static app.

## Run locally

From the repository root, for example:

```bash
python -m http.server 5173 --directory voice-call-test
```

Open `http://localhost:5173` in two browser windows. The page loads Janus `janus.js` and the WebRTC adapter from public CDNs, so the browser needs internet access for those libraries. If Janus fails to load, the page reports it near the heading; allow `cdn.jsdelivr.net` in the browser/network policy.

## Configure

- **Backend API base URL**: Spring Boot base address, such as `http://localhost:8080`.
- **Janus WebSocket URL**: browser reachable Janus signaling URL, such as `ws://localhost:8188` or `wss://janus.example.com`.
- **Project ID**: a project where the authenticated user is a member.
- **Bearer token**: a valid FrietSync access token.

## Test a call

1. In window one, select **Start new call**. The backend creates the room and returns the call and room IDs.
2. In window two, use the same project and **Find active call**, then select **Join call**. Alternatively, enter the call ID in either window and join.
3. Allow microphone access. Both browsers connect directly to Janus for WebRTC audio.
4. Use **Mute microphone** or **Disconnect audio** as needed. **Leave call** also records a backend leave event; **End call** destroys the room and requires initiator/lead permissions.

The backend join/leave endpoints record call lifecycle events. Janus signaling and microphone publishing happen in the browser. AudioBridge mixes participants into one room audio stream on each participant's peer connection. If the browser can signal to Janus but hears no audio, check Janus ICE/NAT settings and the configured WebRTC UDP range/firewall. See the [Janus AudioBridge API](https://janus.conf.meetecho.com/docs/audiobridge.html) for plugin request details.

## Important

The current backend returns the same configured room PIN to every authorized joiner. The page uses that PIN to join the AudioBridge room. Keep Janus WebSocket signaling and WebRTC media reachable by the browser, while keeping Janus HTTP API access private to the backend. Do not commit real access tokens or production URLs into this folder.
# Lyricsflow

A black until music plays lyric display for a Galaxy Tab A. A Chrome/Edge extension reads YouTube Music on your Windows computer, Atlas fetches synchronized lyrics and relays playback, and the tablet draws the current line and three temporary remote controls. The tablet never plays audio or searches for lyrics.

```text
YouTube Music → MV3 extension ↔ Atlas (Node + WebSocket + LRCLIB cache) ↔ Galaxy display
```

## Requirements

- Atlas: Ubuntu, Node.js **22 or newer** and npm. Python 3.14 alone is not enough for this TypeScript/Node app.
- Desktop: Chrome or Edge **116 or newer**, with YouTube Music open in a tab and this extension installed.
- Tablet: a browser capable of WebSocket and modern enough for the built assets. Test on the actual Galaxy Tab A; Android 7 stock browser compatibility can vary. Chrome for Android, if available, is recommended.
- All three devices on the same trusted LAN. Permit inbound TCP 8766 on Atlas. No Internet exposure or port forwarding.

## Layout

- `server/src`: HTTP/WebSocket server, state ownership, LRCLIB matching and disk cache.
- `extension/src`: MV3 service worker, YouTube Music content script, settings.
- `display/src`: old browser targeted display logic, interpolation, state machine and simulator.
- `shared`: version 1 message types and input validation.
- `display/public`, `extension/public`: browser assets.
- `docs`: architecture and Ubuntu deployment.

## Start Atlas

```bash
git clone https://github.com/Bellmorewebdesign/Lyricsflow.git ~/Lyricsflow
cd ~/Lyricsflow
cp .env.example .env
npm ci
npm run build
HOST=0.0.0.0 PORT=8766 npm start
```

`.env` is an example for systemd or your shell; `npm start` does **not** automatically load `.env`. Set the variables in the shell, use `node --env-file=.env dist/server/index.js` on Node 22+, or configure systemd as below. Default host and port are already 0.0.0.0:8766. Run commands from the repository root; static assets live in `dist/display`. Check `http://192.168.1.14:8766/api/health`.

## Install desktop extension

1. Build on a machine with Node (`npm ci && npm run build`). Copy `dist/extension` to the Windows computer if the build happened on Atlas.
2. Open `chrome://extensions` (or `edge://extensions`), enable Developer mode, choose **Load unpacked**, select the **dist/extension** folder.
3. Right click the extension icon → **Options**. Confirm `ws://192.168.1.14:8766/ws` (the default). Reload an already open YouTube Music tab after first installation.
4. Start playback at `https://music.youtube.com/`. Keep the browser running. The source lives in the Chrome/Edge service worker; there is no desktop program to start.

If the server IP changes, edit the extension host permissions in `extension/public/manifest.json` to include the new `http://IP/*`, rebuild, and reload the unpacked extension. The options page changes the WebSocket URL. Remote controls click YouTube Music's real player buttons; the following player state confirms the result.

## Tablet

Open **http://192.168.1.14:8766/display**. Standby is completely black. Tap anywhere to show Previous, Play/Pause, Next for 4.5 seconds. The controls fade out on their own. The current lyric and two adjacent lines appear only when line timed lyrics are available. Pause holds the picture for 60 seconds, then fades to black; resume redraws at the actual player position. The optional web app manifest supports adding a home screen shortcut, but install/fullscreen support on an HTTP LAN origin depends on the Android browser. Use browser full screen or kiosk mode if the browser will not install a PWA over HTTP.

## Simulator

```bash
npm ci
npm run build
SIMULATOR=true npm start
```

Open `http://localhost:8766/simulator` and `/display` in separate tabs. Play, pause, seek, change tracks, show missing lyrics, standby and disconnect. The demo track has fixed local timed lines and art; LRCLIB is not called. **Stop the simulator before using the desktop extension:** only one source owns the Atlas state. The simulator route is absent unless `SIMULATOR=true`.

For source edits, `npm run dev` restarts the server; run `npm run build` again after display/extension edits, and reload the extension for its new build. `npm test`, `npm run lint`, `npm run build`, then `npm run smoke` are the verification commands. The smoke test launches a temporary local Atlas and checks HTTP, timed lyric delivery and remote command routing.

## How lyrics and timing work

Atlas queries the public [LRCLIB API](https://lrclib.net/docs) for track name and artist, accepts only line timed lyrics after strict cleaned title and primary artist equality, and rejects candidate durations more than roughly 4–8 seconds apart. Common official video/audio tags, featuring credits, and remaster tags are stripped for matching. Alternate mixes with a substantially different duration are rejected. Good matches persist for 30 days under `data/`; missing matches for six hours. API errors do not poison the cache. `LyricsProvider` can be replaced without changing the display or server protocol. Provider availability and licensing remain subject to LRCLIB; no lyrics are bundled or generated.

The extension reads `HTMLMediaElement.currentTime`, `duration`, `paused`, `ended` and `playbackRate`; player bar metadata supplies title, artist and cover. Atlas sends the entire lyric timeline on a track update and sends authoritative playback position. The tablet extrapolates from **local elapsed time since receipt**, schedules the next line boundary, and gently corrects small heartbeat drift. Seek, pause, resume and track changes update immediately. If synced lyrics do not exist, the screen stays black while controls remain accessible.

## Troubleshooting

- **Blank display while music plays:** check `/api/health` for `sourceConnected: true`, extension options IP/port and `chrome://extensions` → service worker errors. The display is deliberately black when LRCLIB has no suitable synchronized match or while lyrics are loading. Try the simulator to isolate the display.
- **Extension connected but no track:** reload the YouTube Music tab after installing the extension; check the tab's console for selector changes. YouTube Music is a third party SPA, and DOM selectors can change.
- **Tablet does not load:** verify Atlas IP, Wi-Fi, port 8766, and Ubuntu firewall (`sudo ufw allow 8766/tcp` if UFW is enabled). Test from the tablet with `/api/health`.
- **Artwork missing:** metadata art URLs may expire or fail; lyrics still work on black.
- **Remote command not moving playback:** the YouTube Music tab must remain open; inspect whether its player buttons still match the content script selectors. An ACK means delivery/click, and the next state report is the actual confirmation.
- **After Atlas reboot:** both clients reconnect automatically. The display silently darkens after a prolonged disconnect.

See [Ubuntu systemd deployment](docs/deployment.md) and [internal architecture](docs/architecture.md).

# Lyricsflow

A black until music plays lyric display for a Galaxy Tab A. A Chrome/Edge extension reads YouTube Music on your Windows computer, Atlas fetches synchronized lyrics and relays playback, and the tablet draws the current line and temporary playback and volume controls. The tablet never plays audio or searches for lyrics.

```text
YouTube Music → MV3 extension ↔ Atlas (Node + WebSocket + LRCLIB cache) ↔ Galaxy display
```

## Requirements

- Atlas: Ubuntu, Node.js **22 or newer** and npm. Python 3.14 alone is not enough for this TypeScript/Node app.
- Desktop: Chrome or Edge **116 or newer**, with YouTube Music open in a tab and this extension installed.
- Tablet: a browser capable of WebSocket and modern enough for the built assets. Test on the actual Galaxy Tab A; Android 7 stock browser compatibility can vary. Chrome for Android, if available, is recommended.
- All three devices on the same trusted LAN. Permit inbound TCP on the configured Atlas port (8766 by default; use 8777 if 8766 is occupied). No Internet exposure or port forwarding.

## Layout

- `server/src`: HTTP/WebSocket server, state ownership, LRCLIB matching and disk cache.
- `extension/src`: MV3 service worker, YouTube Music content script, settings.
- `display/src`: old browser targeted display logic, interpolation, state machine and simulator.
- `shared`: version 3 message types and input validation.
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
3. Right click the extension icon → **Options**. Set `ws://192.168.1.14:8777/ws` if Atlas is on your current port 8777 (`8766` is the extension default). Reload an already open YouTube Music tab after first installation.
4. Start playback at `https://music.youtube.com/`. Keep the browser running. The source lives in the Chrome/Edge service worker; there is no desktop program to start.

If the server IP changes, edit the extension host permissions in `extension/public/manifest.json` to include the new `http://IP/*`, rebuild, and reload the unpacked extension. The options page changes the WebSocket URL. Remote controls click YouTube Music's real player buttons; volume commands set the actual media element. ACKs confirm delivery and the subsequent source state confirms actual playback and volume.

## Tablet

Open **http://192.168.1.14:8766/display** (or **http://192.168.1.14:8777/display** when configured for port 8777). Standby is completely black. Tap anywhere to show Previous, Play/Pause, Next and a volume slider for 4.5 seconds; dragging keeps them visible. The slider starts disabled and enables only after a real media volume is reported. Only a trusted slider gesture sends a command; receiving state, page initialization, and reconnecting never set desktop volume. It follows actual YouTube Music media volume, including desktop changes. Drag updates are limited to about seven per second and the final value is sent on release. When timed lyrics are available, the current line and two adjacent lines appear. For every valid track while lyrics load, are absent, are unsynchronized, time out or error, the song title and artist remain visible with a dark artwork background and cover if available. If artwork is absent or fails, the title and artist remain visible against dark. No loading or error text appears. Pause holds either view for 60 seconds, then fades to black; resume redraws at the actual player position. The optional web app manifest supports adding a home screen shortcut, but install/fullscreen support on an HTTP LAN origin depends on the Android browser. Use browser full screen or kiosk mode if the browser will not install a PWA over HTTP.

## Simulator

```bash
npm ci
npm run build
SIMULATOR=true npm start
```

Open `http://localhost:8766/simulator` and `/display` in separate tabs. Play, pause, seek, change tracks, show missing lyrics, standby and disconnect. The demo track has fixed local timed lines and art; LRCLIB is not called. **Stop the simulator before using the desktop extension:** only one source owns the Atlas state. The simulator route is absent unless `SIMULATOR=true`.

For source edits, `npm run dev` restarts the server; run `npm run build` again after display/extension edits, and reload the extension for its new build. `npm test`, `npm run lint`, `npm run build`, then `npm run smoke` are the verification commands. The smoke test launches a temporary local Atlas and checks HTTP, timed lyric delivery and remote command routing.

## How lyrics and timing work

Atlas queries the public [LRCLIB API](https://lrclib.net/docs) first with cleaned title and artist. If that search returns no acceptable timed match, it searches by title and scores every candidate locally. A transliterated title search may be tried for accented or stylized titles. Acceptance still requires the exact normalized title, matching artist or a clearly matching credited primary artist, and duration within roughly 4–8 seconds. Common official video/audio tags, explicit markers, featuring credits, and remaster tags are stripped for matching. Alternate mixes with a substantially different duration are rejected. Good matches persist for 30 days under `data/`; missing matches for six hours. The matching cache is versioned, so old negative results do not need to be deleted. API errors do not poison the cache. Set `DEBUG_LYRICS=true` in the server environment to see query metadata, result counts and short candidate rejection reasons without logging lyric bodies. `LyricsProvider` can be replaced without changing the display or server protocol. Provider availability and licensing remain subject to LRCLIB; no lyrics are bundled or generated.

The extension reads `HTMLMediaElement.currentTime`, `duration`, `paused`, `ended`, `playbackRate`, `volume` and `muted`; it listens for `volumechange` on the selected playback element. Unknown volume is `null` until real media volume is observed. Temporary media gaps retain the last observed volume; a newly created media element that defaults to 100% inherits the prior lower volume and mute state before playback. Active media is preferred over transient preload elements. A validated `SET_VOLUME` command travels from Galaxy through Atlas to the extension, which clamps the value to 0–1, sets `media.volume`, unmutes on a positive value, and reports the resulting media state. Tablet state follows this report, including desktop volume changes. For diagnostic command and media replacement logging, build with `DEBUG_VOLUME=true npm run build`, recopy/reload the extension, and inspect the YouTube Music tab console. Normal builds do not log volume events. Player bar metadata supplies title, artist, album and cover. Dedicated artist links take precedence, and bullet-separated bylines are parsed as distinct artist/album/year fields. An incomplete read during a song transition does not immediately erase a valid track. Atlas sends the entire lyric timeline on a track update and sends authoritative playback position. The tablet extrapolates from **local elapsed time since receipt**, schedules the next line boundary, and gently corrects small heartbeat drift. Seek, pause, resume and track changes update immediately. Without synchronized lyrics, it shows track information even if artwork fails.

## Troubleshooting

- **Blank display while music plays:** check `/api/health` for `sourceConnected: true`, extension options IP/port and `chrome://extensions` → service worker errors. A valid track should show artwork and its title even without lyrics. Try the simulator to isolate the display.
- **Artwork visible but lyrics missing:** check Atlas logs for quoted title, artist and duration. Temporarily launch Atlas with `DEBUG_LYRICS=true` to inspect result counts and candidate rejection reasons. Older missing-result cache entries are ignored by this version; you do not need to clear `data/`.
- **Extension connected but no track:** reload the YouTube Music tab after installing the extension; check the tab's console for selector changes. YouTube Music is a third party SPA, and DOM selectors can change.
- **Tablet does not load:** verify Atlas IP, Wi-Fi, port 8766, and Ubuntu firewall (`sudo ufw allow 8766/tcp` if UFW is enabled). Test from the tablet with `/api/health`.
- **Artwork missing:** metadata art URLs may expire or fail; song title and artist remain visible on a dark background.
- **Slider not updating:** reload both the unpacked extension and YouTube Music tab after upgrading Atlas. Protocol v3 requires the new extension build and a Galaxy display refresh. Check that extension options still point to `ws://192.168.1.14:8777/ws`.
- **Remote command not moving playback:** the YouTube Music tab must remain open; inspect whether its player buttons still match the content script selectors. An ACK means delivery/click, and the next state report is the actual confirmation.
- **After Atlas reboot:** both clients reconnect automatically. The display silently darkens after a prolonged disconnect.

See [Ubuntu systemd deployment](docs/deployment.md) and [internal architecture](docs/architecture.md).

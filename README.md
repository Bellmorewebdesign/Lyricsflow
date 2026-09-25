# Lyricsflow

A black until music plays lyric display for a Galaxy Tab A. A Chrome/Edge extension reads YouTube Music on your Windows computer, a small Windows companion reads the system's master volume, Atlas fetches synchronized lyrics and relays playback, and the tablet draws the current line and temporary playback and volume controls. The tablet never plays audio or searches for lyrics.

```text
YouTube Music → MV3 extension ↔ Atlas (Node + WebSocket + LRCLIB cache) ↔ Galaxy display
Windows master volume → PowerShell companion ↗
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
- `windows`: dependency-free PowerShell companion for the default Windows output device.
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
4. Start playback at `https://music.youtube.com/`. Keep the browser running. The extension provides track and playback timing; the separate Windows companion below provides master volume.

If the server IP changes, edit the extension host permissions in `extension/public/manifest.json` to include the new `http://IP/*`, rebuild, and reload the unpacked extension. The options page changes the WebSocket URL. Remote playback controls still click YouTube Music's real player buttons. The Galaxy volume command only goes to the Windows companion; browser media volume reports never control or replace the master level.

## Windows master volume companion

Run once per Windows login in your **normal interactive user session**, while Atlas is listening on port 8777. In PowerShell on Windows:

```powershell
scp ldawg@192.168.1.14:/home/ldawg/Lyricsflow/windows/Lyricsflow-MasterVolume.ps1 "$env:USERPROFILE\Downloads\Lyricsflow-MasterVolume.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\Lyricsflow-MasterVolume.ps1" -TestAudio
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\Lyricsflow-MasterVolume.ps1" -ServerUrl ws://192.168.1.14:8777/ws
```

The read-only `-TestAudio` command prints the Windows master volume without changing it. Keep the second PowerShell process running while using the tablet; it reconnects automatically when Atlas restarts. It requires no administrator privileges or third-party packages. `/api/health` reports `volumeConnected: true` when the companion connects. The default Windows multimedia playback device is read every 200 ms, so desktop volume changes update the Galaxy. The companion never sets volume on startup or reconnect. If the default output device changes, its next read follows the new device. If an app is deliberately routed to another output device in Windows settings, the slider controls the default output device instead. You can set the YouTube Music site's separate volume to 100% once on the desktop if you want Windows master volume to be the only everyday control.

## Tablet

Open **http://192.168.1.14:8766/display** (or **http://192.168.1.14:8777/display** when configured for port 8777). Standby is completely black. Tap anywhere to show Previous, Play/Pause, Next and a volume slider for 4.5 seconds; dragging keeps them visible. The slider starts disabled and enables only after the Windows companion reports actual master volume. Only a trusted slider gesture sends a command; receiving state, page initialization, and reconnecting never set desktop volume. Galaxy commands are capped at **75%** on the tablet, at Atlas and on Windows. Desktop volume controls can still go above 75%; the thumb stays at its 75% limit and a small percentage label reports the real level. Drag updates are limited to about seven per second and the final value is sent on release. When timed lyrics are available, the current line and two adjacent lines appear. For every valid track while lyrics load, are absent, are unsynchronized, time out or error, the song title and artist remain visible with a dark artwork background and cover if available. If artwork is absent or fails, the title and artist remain visible against dark. No loading or error text appears. Pause holds either view for 60 seconds, then fades to black; resume redraws at the actual player position. The optional web app manifest supports adding a home screen shortcut, but install/fullscreen support on an HTTP LAN origin depends on the Android browser. Use browser full screen or kiosk mode if the browser will not install a PWA over HTTP.

## Simulator

```bash
npm ci
npm run build
SIMULATOR=true npm start
```

Open `http://localhost:8766/simulator` and `/display` in separate tabs. Play, pause, seek, change tracks, show missing lyrics, standby and disconnect. The demo track has fixed local timed lines and art; LRCLIB is not called. **Stop the simulator before using the desktop extension:** only one source owns the Atlas state. The simulator route is absent unless `SIMULATOR=true`.

For source edits, `npm run dev` restarts the server; run `npm run build` again after display/extension edits, and reload the extension for its new build. `npm test`, `npm run lint`, `npm run build`, then `npm run smoke` are the verification commands. The smoke test launches a temporary local Atlas and checks HTTP, timed lyric delivery and remote command routing.

## How lyrics and timing work

Atlas queries the public [LRCLIB API](https://lrclib.net/docs) first with cleaned title and artist. If that search returns no acceptable timed match, it searches by title and scores every candidate locally. A transliterated title search may be tried for accented or stylized titles. Acceptance still requires the exact normalized title, matching artist or a clearly matching credited primary artist, and a known duration within 3 seconds. Common official video/audio tags, explicit markers, featuring credits, and remaster tags are stripped for matching. This rejects similarly named alternate recordings whose lyrics can be several seconds out of sync. LRC `[offset:...]` tags are applied to line timestamps. Good matches persist for 30 days under `data/`; missing matches for six hours. The matching cache is versioned, so old negative results do not need to be deleted. LRCLIB search returns at most 20 records, so the lookup first tries the album/artist/title/duration endpoint when duration is known, then focused and title-only searches with local scoring. API errors do not poison the cache; Atlas retries transient provider failures for the active track. Set `DEBUG_LYRICS=true` in the server environment to see query metadata, result counts and short candidate rejection reasons without logging lyric bodies. `LyricsProvider` can be replaced without changing the display or server protocol. Provider availability and licensing remain subject to LRCLIB; no lyrics are bundled or generated.

The extension reads the YouTube Music player bar's visible position and duration alongside `HTMLMediaElement.currentTime`, pause, seek and playback rate. If media time is several seconds away from YouTube Music's advancing clock, the visible clock controls lyric timing. During autoplay a reset and advancing player-bar clock can confirm a new song even when the media clock never rewinds; after confirmation the player-bar clock remains authoritative. A temporarily stalled player bar advances by actual media progress. A seek or transition with a restarted media element uses its fresh media clock until the bar catches up. The artist, album and title come from distinct player bar fields. Duration settles before strict LRCLIB matching; the provider prefers the album recording when available, rejects synced lines that extend past the selected song, and ignores old negative cache entries from earlier matchers. A good LRCLIB file can still have intrinsically inaccurate timestamps, so the software cannot guarantee every provider line is aligned to the vocal without a verified source or manual calibration. With no usable lyrics, the track and artwork still appear. Atlas sends the lyric timeline and live playback position; the tablet extrapolates from local elapsed time and jumps on seeks or track changes.

Some LRCLIB records have the correct title, artist, album and duration yet their timed lines stop far before the end of the song. For such a record, Atlas checks for a better timeline. A lyric-video record is eligible only if its title explicitly names the same artist and song, its duration is within two seconds, its lines reach near the song's end, and at least eight distinct lyric lines corroborate the original record. This addresses the early-ending LRCLIB timeline for Lil Uzi Vert's “What You Saying.” If no corroborated alternative exists, the original strict match remains available. The cache namespace changes with this update; do not delete `data/`.

The Windows companion is the only authority for the Galaxy volume slider. It reads the actual Core Audio master level and mute state, accepts only explicit Galaxy `SET_VOLUME` requests of 0–75%, reports the resulting level to Atlas, and reports changes made on the desktop. Atlas forwards playback buttons to the YouTube Music extension and volume commands only to the companion. If the companion disconnects, the slider disables rather than falling back to YouTube Music's own volume. The extension still protects the site's media volume across track changes, but it never receives Galaxy volume commands. This is Windows output volume: applications may additionally have their own attenuation. Keep Atlas available only on your trusted LAN; the control WebSocket has no user authentication.

During autoplay, the next URL can arrive while the player bar still names the previous song. The extension keeps this handoff pending until the media clock restarts or the player-bar clock resets and progresses. It then switches tracks without a pause and clears the outgoing lyric timeline. If the bar resets but its text stops repainting in a background tab, a stable new title and video ID plus three seconds of media progress also confirm the change. A same-title repeat continues from its new position while the new URL settles. Atlas logs the starting position and video ID on each actual track change to help diagnose a real-device mismatch.

The extension now corrects the tablet's playback position once per second. The display schedules each new lyric line for its LRC timestamp, including lines only milliseconds apart; it shows the current line immediately without a fade or a forced layout pass. Playback speed and pause still determine how the clock advances. A lyric file with inaccurate timestamps cannot be made exact by increasing the display update rate.

The player-bar clock is displayed in whole seconds. Even when the HTML media clock has a different absolute origin, the extension uses its short increments between player-bar updates to preserve fractional lyric timing. Song changes and seeks still use their existing confirmation gates. A consistent multi-second lag for one recording can also come from the timed lyric file or the selected YouTube Music edit; it needs a real-device timing comparison rather than an arbitrary global offset.

## Troubleshooting

- **Blank display while music plays:** check `/api/health` for `sourceConnected: true`, extension options IP/port and `chrome://extensions` → service worker errors. A valid track should show artwork and its title even without lyrics. Try the simulator to isolate the display.
- **Repeated “Track changed” for one song:** the installed extension must use the stable player bar duration; recopy the new build and reload the YouTube Music tab.
- **Artwork visible but lyrics missing or far out of sync:** check Atlas logs for quoted title, artist and duration. Temporarily launch Atlas with `DEBUG_LYRICS=true` to inspect candidate album, length and rejection reasons without lyric bodies. Atlas ignores old negative cache entries; do not delete `data/`. This extension reports build `1.0.10`. If the displayed player clock and lyric position agree but the vocal does not, the provider's lyric file itself may describe a different edit.
- **Extension connected but no track:** reload the YouTube Music tab after installing the extension; check the tab's console for selector changes. YouTube Music is a third party SPA, and DOM selectors can change.
- **Tablet does not load:** verify Atlas IP, Wi-Fi, port 8766, and Ubuntu firewall (`sudo ufw allow 8766/tcp` if UFW is enabled). Test from the tablet with `/api/health`.
- **Artwork missing:** metadata art URLs may expire or fail; song title and artist remain visible on a dark background.
- **Volume jumps on track change:** verify the Atlas log says `Extension connected: 1.0.10`; disable old unpacked Lyricsflow copies in Edge and reload the YouTube Music tab. The Galaxy slider now adjusts Windows master output, which is independent of YouTube Music's own volume.
- **Slider disabled or not updating:** run the PowerShell companion in the Windows interactive session and check `/api/health` for `volumeConnected: true`. Atlas does not reuse the browser's volume if the companion is absent. Refresh the Galaxy display after upgrading Atlas.
- **Remote command not moving playback:** the YouTube Music tab must remain open; inspect whether its player buttons still match the content script selectors. An ACK means delivery/click, and the next state report is the actual confirmation.
- **After Atlas reboot:** both clients reconnect automatically. The display silently darkens after a prolonged disconnect.

See [Ubuntu systemd deployment](docs/deployment.md) and [internal architecture](docs/architecture.md).

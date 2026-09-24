# Ubuntu deployment on Atlas

Install Node.js 22+ on `atlas-server` through your preferred trusted package source. Check `node --version` and `npm --version`. Python is not used by the deployed service.

```bash
cd ~/Lyricsflow
npm ci
npm run lint
npm test
npm run build
mkdir -p data
```

Copy `scripts/lyricsflow.service.example` to `~/.config/systemd/user/lyricsflow.service`. Replace `%h/Lyricsflow` if you cloned elsewhere. If Node is installed through a user version manager, replace `/usr/bin/env node` in `ExecStart` with the absolute path reported by `command -v node` (user services do not necessarily load your interactive shell profile). The user service runs as your normal account; it does not require root.

```bash
mkdir -p ~/.config/systemd/user
cp scripts/lyricsflow.service.example ~/.config/systemd/user/lyricsflow.service
systemctl --user daemon-reload
systemctl --user enable --now lyricsflow.service
systemctl --user status lyricsflow.service
journalctl --user -u lyricsflow.service -f
```

For startup before your first login, enable linger once for your account (`sudo loginctl enable-linger "$USER"`). This is a system administration choice, so the repository does not run it automatically. If UFW is enabled, permit LAN access to TCP 8766. Do not forward this unauthenticated LAN service to the Internet. Update the software with `git pull && npm ci && npm run build && systemctl --user restart lyricsflow.service`.

Default address: `http://192.168.1.14:8766/display`. Health: `/api/health`. The service declares `After=network-online.target`; a user service still starts even when external Internet or LRCLIB is unavailable, and lookup errors are contained.

If Atlas already uses port 8777, set `Environment=PORT=8777` in the copied user service file and set the desktop extension to `ws://192.168.1.14:8777/ws`. Restart with `systemctl --user daemon-reload && systemctl --user restart lyricsflow.service`. Set `Environment=DEBUG_LYRICS=true` there only while diagnosing lyric matches; the matching cache version changes automatically with this release, so no manual deletion of `data/` is needed.

For this protocol v3 upgrade, update the copied `dist/extension` folder on Windows, reload the unpacked extension in Edge, reload the YouTube Music tab, and refresh the Galaxy display page after rebuilding and restarting Atlas. The current tablet volume slider needs the separate Windows master volume companion described below.

For the volume safety update, first stop the process currently bound to port 8777 (check with `ss -ltnp '( sport = :8777 )'`). If running manually, rebuild and launch from the repository with `HOST=0.0.0.0 PORT=8777 npm start`; if using the user service, rebuild and restart that service instead. Confirm `curl -fsS http://127.0.0.1:8777/display | grep 'id="volume"'` shows the new slider. Update the extension and refresh the Galaxy page after Atlas is serving v3.

## Updating from the volume and lyric glitch builds

After `git pull && npm ci && npm run build`, restart whichever Atlas process actually serves port 8777. For a user service run `systemctl --user restart lyricsflow.service`; for a manual process stop the old server and launch `HOST=0.0.0.0 PORT=8777 npm start`. Copy the freshly built `dist/extension` folder onto Windows, reload that unpacked extension in Edge, and reload the YouTube Music tab. Refresh the Galaxy display. The matching cache key is updated, so old negative entries remain on disk but are no longer used; do not delete `data/`. If lyrics cannot be matched while YouTube Music has no stable duration, the title and artist still show. Atlas retries temporary LRCLIB errors for the current track.

On a service restart, Atlas closes connected WebSocket clients so systemd can stop the old process promptly. The extension and Galaxy reconnect automatically. Check `systemctl --user is-active lyricsflow.service` and `curl -fsS http://127.0.0.1:8777/api/health` after restarting; `sourceConnected` stays false until the Edge extension connects.

## Volume persistence and popular-song lyric update

Pull main and rebuild on Atlas, then restart the process actually bound to port 8777. The extension build now reports version `1.0.5` when it connects. Copy the newly built `dist/extension` to a fresh Windows folder, remove or disable all older unpacked Lyricsflow extensions in Edge, load the new folder, and reload YouTube Music. The Galaxy page can be refreshed without reinstalling the display. If Atlas logs `Extension connected: unknown build`, an old extension remains active. This change updates the matching cache namespace without removing files from `data/`. LRCLIB searches can now proceed safely when a song length is temporarily unknown.

## Windows master volume and YouTube Music timing update

After pulling this update, `npm run build` and restart `lyricsflow.service` on Atlas (port 8777). Refresh the Galaxy page. The slider remains disabled until the new Windows volume companion connects; `/api/health` reports `volumeConnected: true` once it does. The browser's own volume is no longer the tablet's slider source. Set YouTube Music's volume manually to your preferred level (100% if you want only Windows master volume for everyday adjustment).

Copy `windows/Lyricsflow-MasterVolume.ps1` from Atlas to the Windows desktop and start it in the signed-in user's PowerShell session, with `-ServerUrl ws://192.168.1.14:8777/ws`. It needs only built-in Windows PowerShell and Core Audio, no administrator access or third-party module. Keep the PowerShell process running while using the tablet; it reconnects after Atlas restarts. To update the visible YouTube Music timing behavior, also copy the freshly built `dist/extension` to Windows and reload the unpacked extension and its YouTube Music tab. Atlas should log extension build `1.0.6`. Refresh the Galaxy once. Old missing-result cache entries are ignored by the new matching namespace, so do not delete `data/`.

## Repairing early-ending LRCLIB timelines

The "What You Saying" timing fix only changes Atlas's LRCLIB selection. Run `git pull --ff-only && npm ci && npm run build` from `~/Lyricsflow`, then `systemctl --user restart lyricsflow.service`. This update does not require a new Windows companion or extension copy if build `1.0.6` is already installed. Old cached matches are ignored automatically; keep `data/`. For a song with known metadata and a dense lyric file that stops far before the end, Atlas can now use a corroborated full lyric-video timeline under strict title, duration and text-overlap checks.

## Autoplay timing handoff

Build `1.0.7` fixes autoplay when the next YouTube Music URL, old player-bar title and restarted media clock briefly disagree. Update Atlas, then copy its new `dist/extension` folder to a fresh Windows directory, disable the older unpacked extension, load the new one in Edge and reload the YouTube Music tab. The Atlas log should say `Extension connected: 1.0.7`. The Windows master-volume companion is unchanged. Track change logs now include the starting playback position and video ID; they do not log playback position every few seconds.

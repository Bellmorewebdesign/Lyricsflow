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

For this protocol v2 upgrade, update the copied `dist/extension` folder on Windows, reload the unpacked extension in Edge, reload the YouTube Music tab, and refresh the Galaxy display page after rebuilding and restarting Atlas. Volume is read from the real YouTube Music media element, so the old extension build cannot provide it.

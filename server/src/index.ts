import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { parseIncoming, type Outgoing } from "../../shared/protocol.js";
import { LrclibProvider, LyricsService } from "./lyrics.js";
import { StateStore } from "./state.js";
const assets = join(process.cwd(), "dist", "display");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8766);
const simulator = process.env.SIMULATOR === "true";
const state = new StateStore();
const service = new LyricsService(
  new LrclibProvider(),
  process.env.DATA_DIR || join(process.cwd(), "data"),
);
const describeTrack = (
  track: { title: string; artist: string; durationMs: number } | null,
): string =>
  track
    ? `${JSON.stringify(track.title)} — ${JSON.stringify(track.artist)} [${(track.durationMs / 1000).toFixed(1)}s]`
    : "(none)";
let source: WebSocket | null = null;
const displays = new Set<WebSocket>();
const alive = new Map<WebSocket, boolean>();
const pendingCommands = new Map<
  string,
  { ws: WebSocket; timer: ReturnType<typeof setTimeout> }
>();
const send = (ws: WebSocket, message: Outgoing) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};
const broadcast = () => {
  const snapshot = state.snapshot;
  for (const ws of displays) send(ws, snapshot);
};
const server = createServer(async (req, res) => {
  const path = new URL(req.url || "/", "http://localhost").pathname;
  if (path === "/api/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        ok: true,
        sourceConnected: source?.readyState === WebSocket.OPEN,
        displays: displays.size,
      }),
    );
    return;
  }
  const files: Record<string, [string, string]> = {
    "/display": ["index.html", "text/html"],
    "/display/": ["index.html", "text/html"],
    "/display/app.js": ["app.js", "text/javascript"],
    "/display/style.css": ["style.css", "text/css"],
    "/display/manifest.json": ["manifest.json", "application/manifest+json"],
    "/display/icon.svg": ["icon.svg", "image/svg+xml"],
    "/display/demo-art.svg": ["demo-art.svg", "image/svg+xml"],
  };
  if (simulator) {
    files["/simulator"] = ["simulator.html", "text/html"];
    files["/display/simulator.js"] = ["simulator.js", "text/javascript"];
  }
  const selected = files[path];
  if (!selected) {
    res.writeHead(
      path === "/" ? 302 : 404,
      path === "/" ? { Location: "/display" } : {},
    );
    res.end();
    return;
  }
  try {
    const body = await readFile(join(assets, selected[0]));
    res.writeHead(200, {
      "Content-Type": selected[1],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  } catch {
    res.writeHead(503);
    res.end("Build assets first: npm run build");
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
server.on("upgrade", (req, socket, head) => {
  if (req.url?.split("?")[0] !== "/ws") {
    socket.destroy();
    return;
  }
  // Same-origin displays and extension service workers only; CLI simulator has no Origin.
  const origin = req.headers.origin;
  if (
    origin &&
    !origin.startsWith("chrome-extension://") &&
    !origin.startsWith("extension://") &&
    origin !== `http://${req.headers.host}`
  ) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));
  let role: "source" | "display" | null = null;
  const helloTimer = setTimeout(() => {
    if (!role) ws.close();
  }, 5000);
  ws.on("message", (raw) => {
    const msg = parseIncoming(raw.toString());
    if (!msg) return;
    if (msg.type === "PING") {
      send(ws, { type: "PONG" });
      return;
    }
    if (!role) {
      if (msg.type !== "HELLO") return;
      role = msg.role;
      clearTimeout(helloTimer);
      if (role === "source") {
        if (source && source !== ws)
          source.close(1000, "Replaced by new source");
        source = ws;
        state.clear();
        state.connect();
        broadcast();
        console.info("Extension connected");
      } else {
        displays.add(ws);
        send(ws, state.snapshot);
        console.info("Display connected");
      }
      return;
    }
    if (role === "source" && msg.type === "SOURCE_STATE" && source === ws) {
      const changed = state.update(msg);
      broadcast();
      if (changed) {
        const snap = state.snapshot;
        console.info("Track changed:", describeTrack(snap.track));
        if (simulator && snap.track?.videoId?.startsWith("lyricsflow-demo-")) {
          const lyrics =
            snap.track.videoId === "lyricsflow-demo-no-lyrics"
              ? null
              : {
                  provider: "Simulator",
                  lines: Array.from({ length: 24 }, (_, i) => ({
                    startMs: 4000 + i * 5000,
                    text: [
                      "The room is quiet now",
                      "A rhythm fills the air",
                      "And all the lights begin to move",
                      "We find our way from here",
                    ][i % 4]!,
                  })),
                };
          if (state.setLyrics(snap.version, lyrics)) broadcast();
        } else if (snap.track)
          void service
            .get(snap.track)
            .then((lyrics) => {
              if (state.setLyrics(snap.version, lyrics)) {
                console.info(
                  lyrics ? "Lyrics found:" : "Lyrics not found:",
                  describeTrack(snap.track),
                );
                broadcast();
              }
            })
            .catch((error) => {
              console.warn(
                "Lyrics provider error:",
                describeTrack(snap.track),
                error,
              );
            });
      }
    }
    if (
      role === "display" &&
      (msg.type === "CONTROL_COMMAND" || msg.type === "SET_VOLUME") &&
      !pendingCommands.has(msg.id)
    ) {
      if (!source || source.readyState !== WebSocket.OPEN) {
        send(ws, { type: "CONTROL_ACK", id: msg.id, delivered: false });
        return;
      }
      send(source, msg);
      const timer = setTimeout(() => {
        pendingCommands.delete(msg.id);
        send(ws, { type: "CONTROL_ACK", id: msg.id, delivered: false });
      }, 3000);
      pendingCommands.set(msg.id, { ws, timer });
    }
    if (role === "source" && msg.type === "CONTROL_ACK" && source === ws) {
      const pending = pendingCommands.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingCommands.delete(msg.id);
        send(pending.ws, msg);
      }
    }
  });
  ws.on("close", () => {
    clearTimeout(helloTimer);
    alive.delete(ws);
    if (role === "source" && source === ws) {
      source = null;
      state.disconnect();
      broadcast();
      console.info("Extension disconnected");
    }
    if (role === "display") {
      displays.delete(ws);
      console.info("Display disconnected");
    }
    for (const [id, pending] of pendingCommands)
      if (pending.ws === ws) {
        clearTimeout(pending.timer);
        pendingCommands.delete(id);
      }
  });
  ws.on("error", (error) => console.warn("WebSocket error:", error.message));
});
// Correct drift and detect a dead source without requiring constant tablet messages.
const heartbeat = setInterval(() => {
  broadcast();
  for (const ws of [source, ...displays]) {
    if (ws?.readyState !== WebSocket.OPEN) continue;
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 10_000);
server.listen(port, host, () =>
  console.info(`Lyricsflow listening at http://${host}:${port}/display`),
);
process.on("SIGTERM", () => {
  clearInterval(heartbeat);
  server.close();
  wss.close();
});

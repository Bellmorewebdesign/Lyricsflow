import type { Snapshot, Command } from "../../shared/protocol.js";
import {
  displayState,
  effectivePosition,
  lineIndex,
  type DisplayState,
} from "./model.js";
const scene = document.querySelector<HTMLElement>("#scene")!;
const artistEl = document.querySelector<HTMLElement>("#artist")!;
const titleEl = document.querySelector<HTMLElement>("#title")!;
const lyricEls = Array.from(document.querySelectorAll<HTMLElement>(".line"));
const controls = document.querySelector<HTMLElement>("#controls")!;
const playButton = document.querySelector<HTMLButtonElement>("#play")!;
const artEls = [
  document.querySelector<HTMLElement>("#art-a")!,
  document.querySelector<HTMLElement>("#art-b")!,
];
let artSide = 0;
let artUrl = "";
let socket: WebSocket | null = null;
let snapshot: Snapshot | null = null;
let receipt = performance.now();
let connected = false;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let standbyTimer: ReturnType<typeof setTimeout> | null = null;
let controlsTimer: ReturnType<typeof setTimeout> | null = null;
let disconnectedAt: number | null = null;
let pausedAt: number | null = null;
let lastActive = 0;
let activeLine = -99;
let trackVersion = -1;
let state: DisplayState = "STANDBY";
function applyState(next: DisplayState): void {
  state = next;
  const visible =
    next === "PLAYING" ||
    next === "PAUSED" ||
    next === "HOLDING" ||
    (next === "DISCONNECTED" &&
      disconnectedAt !== null &&
      Date.now() - disconnectedAt < 10000 &&
      scene.classList.contains("visible"));
  scene.classList.toggle("visible", visible);
  scene.classList.toggle("paused", next === "PAUSED");
  document.body.classList.toggle("black", !visible);
}
function showArtwork(url: string): void {
  if (url === artUrl) return;
  artUrl = url;
  artSide = 1 - artSide;
  const incoming = artEls[artSide]!;
  const outgoing = artEls[1 - artSide]!;
  // HTTPS artwork or an image hosted by Atlas; no arbitrary CSS from a source.
  let safe = "";
  try {
    if (!url) throw new Error("no artwork");
    const parsed = new URL(url, location.href);
    if (parsed.protocol === "https:" || parsed.origin === location.origin)
      safe = parsed.href;
  } catch {}
  incoming.style.backgroundImage = safe
    ? "url(" + JSON.stringify(safe) + ")"
    : "none";
  incoming.classList.add("active");
  outgoing.classList.remove("active");
}
function render(): void {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  if (standbyTimer) {
    clearTimeout(standbyTimer);
    standbyTimer = null;
  }
  const now = Date.now();
  const next = displayState(snapshot, connected, now, pausedAt, lastActive);
  applyState(next);
  if (next === "HOLDING")
    standbyTimer = setTimeout(render, Math.max(1, lastActive + 8000 - now));
  if (next === "PAUSED" && pausedAt !== null)
    standbyTimer = setTimeout(render, Math.max(1, pausedAt + 60000 - now));
  if (
    next === "DISCONNECTED" &&
    disconnectedAt !== null &&
    now - disconnectedAt < 10000
  )
    standbyTimer = setTimeout(render, 10000 - (now - disconnectedAt));
  if (
    !snapshot?.track ||
    !snapshot.lyrics?.lines.length ||
    next === "STANDBY" ||
    next === "NO_LYRICS"
  )
    return;
  if (snapshot.version !== trackVersion) {
    trackVersion = snapshot.version;
    activeLine = -99;
  }
  if (titleEl.textContent !== snapshot.track.title)
    titleEl.textContent = snapshot.track.title;
  if (artistEl.textContent !== snapshot.track.artist)
    artistEl.textContent = snapshot.track.artist;
  showArtwork(snapshot.track.artwork || "");
  const position = effectivePosition(snapshot, receipt, performance.now());
  const lines = snapshot.lyrics.lines;
  const index = lineIndex(lines, position);
  if (index !== activeLine) {
    activeLine = index;
    const visible = [index - 1, index, index + 1];
    lyricEls.forEach((el, i) => {
      el.textContent = lines[visible[i] || 0]?.text || "";
      el.classList.remove("change");
      void el.offsetWidth;
      el.classList.add("change");
    });
  }
  if (next === "PLAYING" && lines[index + 1]) {
    const remaining = (lines[index + 1]!.startMs - position) / snapshot.rate;
    renderTimer = setTimeout(
      render,
      Math.max(30, Math.min(remaining + 12, 10000)),
    );
  }
}
function receive(next: Snapshot): void {
  if (
    next.type !== "SERVER_STATE" ||
    !Number.isFinite(next.positionMs) ||
    !Number.isFinite(next.version)
  )
    return;
  const now = performance.now();
  // Gently absorb small heartbeat differences, jump immediately on seeks/track changes.
  if (
    snapshot &&
    snapshot.version === next.version &&
    snapshot.playing &&
    next.playing &&
    !next.seek
  ) {
    const prior = effectivePosition(snapshot, receipt, now);
    if (Math.abs(prior - next.positionMs) < 400)
      next.positionMs = prior + (next.positionMs - prior) * 0.3;
  }
  if (next.playing) {
    pausedAt = null;
    lastActive = Date.now();
  } else if (next.track && (snapshot?.playing || pausedAt === null))
    pausedAt = Date.now();
  else if (!next.track) pausedAt = null;
  if (!next.sourceConnected && disconnectedAt === null)
    disconnectedAt = Date.now();
  if (next.sourceConnected) disconnectedAt = null;
  snapshot = next;
  receipt = now;
  playButton.setAttribute("aria-label", next.playing ? "Pause" : "Play");
  playButton.innerHTML = next.playing
    ? '<svg viewBox="0 0 32 32"><path d="M9 6h5v20H9zm9 0h5v20h-5z"/></svg>'
    : '<svg viewBox="0 0 32 32"><path d="M10 5v22l18-11z"/></svg>';
  render();
}
function connect(): void {
  const url =
    (location.protocol === "https:" ? "wss://" : "ws://") +
    location.host +
    "/ws";
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    connected = true;
    disconnectedAt = null;
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: "HELLO", role: "display", protocol: 1 }));
    render();
  };
  ws.onmessage = (event) => {
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "SERVER_STATE") receive(msg as Snapshot);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    connected = false;
    disconnectedAt = Date.now();
    render();
    reconnectTimer = setTimeout(connect, reconnectDelay + Math.random() * 500);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  };
  ws.onerror = () => ws.close();
}
function reveal(): void {
  controls.classList.add("visible");
  if (controlsTimer) clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => controls.classList.remove("visible"), 4500);
}
document.body.addEventListener("click", reveal);
controls.addEventListener("click", (event) => event.stopPropagation());
for (const button of Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-command]"),
)) {
  button.addEventListener("click", () => {
    reveal();
    const command = button.dataset.command as Command;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: "CONTROL_COMMAND",
          command,
          id: String(Date.now()) + "-" + Math.random().toString(36).slice(2),
        }),
      );
  });
}
connect();

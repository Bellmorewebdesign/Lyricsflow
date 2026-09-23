import {
  PROTOCOL_VERSION,
  type Snapshot,
  type Command,
} from "../../shared/protocol.js";
import { ArtworkView, showTrackMetadata } from "./artwork.js";
import { VolumeSlider } from "./volume.js";
import {
  displayState,
  effectivePosition,
  lineIndex,
  type DisplayState,
} from "./model.js";
const scene = document.querySelector<HTMLElement>("#scene")!;
const artistEl = document.querySelector<HTMLElement>("#artist")!;
const titleEl = document.querySelector<HTMLElement>("#title")!;
const coverEl = document.querySelector<HTMLImageElement>("#cover")!;
const coverTitleEl = document.querySelector<HTMLElement>("#cover-title")!;
const coverArtistEl = document.querySelector<HTMLElement>("#cover-artist")!;
const coverAlbumEl = document.querySelector<HTMLElement>("#cover-album")!;
const lyricEls = Array.from(document.querySelectorAll<HTMLElement>(".line"));
const controls = document.querySelector<HTMLElement>("#controls")!;
const playButton = document.querySelector<HTMLButtonElement>("#play")!;
const volumeEl = document.querySelector<HTMLInputElement>("#volume")!;
const artEls = [
  document.querySelector<HTMLElement>("#art-a")!,
  document.querySelector<HTMLElement>("#art-b")!,
];
const artwork = new ArtworkView(coverEl, artEls, location.href);
let socket: WebSocket | null = null;
let snapshot: Snapshot | null = null;
let receipt = performance.now();
let connected = false;
let reconnectDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let standbyTimer: ReturnType<typeof setTimeout> | null = null;
let controlsTimer: ReturnType<typeof setTimeout> | null = null;
let volumeSlider: VolumeSlider;
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
    next === "NO_LYRICS" ||
    next === "HOLDING" ||
    (next === "DISCONNECTED" &&
      disconnectedAt !== null &&
      Date.now() - disconnectedAt < 10000 &&
      scene.classList.contains("visible"));
  scene.classList.toggle("visible", visible);
  scene.classList.toggle(
    "paused",
    next === "PAUSED" || (next === "NO_LYRICS" && !snapshot?.playing),
  );
  if (next !== "HOLDING" && next !== "DISCONNECTED")
    scene.classList.toggle("no-lyrics", next === "NO_LYRICS");
  document.body.classList.toggle("black", !visible);
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
  if (
    (next === "PAUSED" || next === "NO_LYRICS") &&
    !snapshot?.playing &&
    pausedAt !== null
  )
    standbyTimer = setTimeout(render, Math.max(1, pausedAt + 60000 - now));
  if (
    next === "DISCONNECTED" &&
    disconnectedAt !== null &&
    now - disconnectedAt < 10000
  )
    standbyTimer = setTimeout(render, 10000 - (now - disconnectedAt));
  if (!snapshot?.track || next === "STANDBY") return;
  if (snapshot.version !== trackVersion) {
    trackVersion = snapshot.version;
    activeLine = -99;
  }
  showTrackMetadata(snapshot.track, {
    title: titleEl,
    artist: artistEl,
    coverTitle: coverTitleEl,
    coverArtist: coverArtistEl,
    coverAlbum: coverAlbumEl,
  });
  artwork.show(snapshot.track.artwork || "", snapshot.version);
  if (next === "NO_LYRICS" || !snapshot.lyrics?.lines.length) return;
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
  volumeSlider.receive(next.volume, next.muted, connected);
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
    ws.send(
      JSON.stringify({
        type: "HELLO",
        role: "display",
        protocol: PROTOCOL_VERSION,
      }),
    );
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
    if (msg.type === "CONTROL_ACK")
      volumeSlider.acknowledge(msg.id, msg.delivered);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    connected = false;
    disconnectedAt = Date.now();
    volumeSlider.receive(null, null, false);
    render();
    reconnectTimer = setTimeout(connect, reconnectDelay + Math.random() * 500);
    reconnectDelay = Math.min(30000, reconnectDelay * 2);
  };
  ws.onerror = () => ws.close();
}
function reveal(): void {
  controls.classList.add("visible");
  if (controlsTimer) clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => {
    if (volumeSlider.interacting) reveal();
    else controls.classList.remove("visible");
  }, 4500);
}
function sendVolume(value: number): string | null {
  if (socket?.readyState !== WebSocket.OPEN) return null;
  const id = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  socket.send(
    JSON.stringify({ type: "SET_VOLUME", volume: Math.min(0.75, value), id }),
  );
  return id;
}
volumeSlider = new VolumeSlider(volumeEl, sendVolume, reveal);
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

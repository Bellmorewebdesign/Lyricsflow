import { PROTOCOL_VERSION, type SourceState } from "../../shared/protocol.js";
const log = document.querySelector<HTMLElement>("#status")!;
let ws: WebSocket | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let index = 0,
  position = 0,
  playing = false,
  noLyrics = false;
let volume = 1;
let muted = false;
const tracks = [
  {
    title: "Afterglow",
    artist: "Demo Ensemble",
    durationMs: 125000,
    videoId: "lyricsflow-demo-1",
    artwork: "/display/demo-art.svg",
  },
  {
    title: "Night Drive",
    artist: "Demo Ensemble",
    durationMs: 110000,
    videoId: "lyricsflow-demo-2",
    artwork: "/display/demo-art.svg",
  },
];
function state(seek = false): SourceState {
  return {
    type: "SOURCE_STATE",
    track: noLyrics
      ? {
          ...tracks[index]!,
          title: "Untimed Sample",
          videoId: "lyricsflow-demo-no-lyrics",
        }
      : tracks[index]!,
    positionMs: position,
    playing,
    ended: false,
    rate: 1,
    volume,
    muted,
    seek,
  };
}
function send(seek = false): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(state(seek)));
}
function connect(): void {
  ws = new WebSocket(
    (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host +
      "/ws",
  );
  ws.onopen = () => {
    log.textContent = "Connected to Atlas";
    ws!.send(
      JSON.stringify({
        type: "HELLO",
        role: "source",
        protocol: PROTOCOL_VERSION,
      }),
    );
    send(true);
  };
  ws.onclose = () => {
    log.textContent = "Disconnected";
    ws = null;
  };
  ws.onmessage = (event) => {
    let msg: any;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "SET_VOLUME") {
      volume = Math.max(0, Math.min(1, msg.volume));
      if (volume > 0) muted = false;
      send();
      ws?.send(
        JSON.stringify({ type: "CONTROL_ACK", id: msg.id, delivered: true }),
      );
      return;
    }
    if (msg.type !== "CONTROL_COMMAND") return;
    if (msg.command === "NEXT" || msg.command === "PREVIOUS") {
      index =
        (index + (msg.command === "NEXT" ? 1 : tracks.length - 1)) %
        tracks.length;
      position = 0;
      noLyrics = false;
    } else if (msg.command === "PLAY_PAUSE") playing = !playing;
    send(true);
    ws?.send(
      JSON.stringify({ type: "CONTROL_ACK", id: msg.id, delivered: true }),
    );
  };
}
connect();
timer = setInterval(() => {
  if (playing && ws?.readyState === WebSocket.OPEN) {
    position += 1000;
    if (position >= tracks[index]!.durationMs) {
      index = (index + 1) % tracks.length;
      position = 0;
    }
    send();
  }
}, 1000);
for (const button of Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-action]"),
))
  button.addEventListener("click", () => {
    switch (button.dataset.action) {
      case "play":
        playing = true;
        send();
        break;
      case "pause":
        playing = false;
        send();
        break;
      case "next":
        index = (index + 1) % tracks.length;
        noLyrics = false;
        position = 0;
        playing = true;
        send(true);
        break;
      case "seek":
        position = 55000;
        send(true);
        break;
      case "missing":
        noLyrics = true;
        position = 0;
        playing = true;
        send(true);
        break;
      case "standby":
        playing = false;
        ws?.send(
          JSON.stringify({
            type: "SOURCE_STATE",
            track: null,
            positionMs: 0,
            playing: false,
            ended: true,
            rate: 1,
            volume,
            muted,
          }),
        );
        break;
      case "disconnect":
        ws?.close();
        break;
      case "connect":
        if (!ws) connect();
        break;
    }
  });

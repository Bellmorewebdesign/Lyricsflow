import {
  parseIncoming,
  PROTOCOL_VERSION,
  type SourceState,
} from "../../shared/protocol.js";
declare const chrome: any;
const DEFAULT_URL = "ws://192.168.1.14:8766/ws";
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retry = 1000;
let selectedTab: number | null = null;
let lastState: SourceState | null = null;
let lastReport = 0;
function connect(): void {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  )
    return;
  chrome.storage.sync.get(
    { serverUrl: DEFAULT_URL },
    (settings: { serverUrl: string }) => {
      try {
        const url = new URL(settings.serverUrl);
        if (!["ws:", "wss:"].includes(url.protocol) || url.pathname !== "/ws")
          return;
        const ws = new WebSocket(url.href);
        socket = ws;
        ws.onopen = () => {
          retry = 1000;
          ws.send(
            JSON.stringify({
              type: "HELLO",
              role: "source",
              protocol: PROTOCOL_VERSION,
            }),
          );
          if (lastState && Date.now() - lastReport < 15000)
            ws.send(JSON.stringify(lastState));
          if (selectedTab !== null)
            chrome.tabs
              .sendMessage(selectedTab, { type: "REPORT_NOW" })
              .catch(() => {});
        };
        ws.onmessage = (event) => {
          const msg = parseIncoming(event.data);
          if (msg?.type !== "CONTROL_COMMAND" && msg?.type !== "SET_VOLUME")
            return;
          if (selectedTab === null) {
            ws.send(
              JSON.stringify({
                type: "CONTROL_ACK",
                id: msg.id,
                delivered: false,
              }),
            );
            return;
          }
          chrome.tabs
            .sendMessage(
              selectedTab,
              msg.type === "SET_VOLUME"
                ? { type: "SET_VOLUME", volume: msg.volume }
                : { type: "CONTROL", command: msg.command },
            )
            .then((answer: { delivered?: boolean }) => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(
                  JSON.stringify({
                    type: "CONTROL_ACK",
                    id: msg.id,
                    delivered: !!answer?.delivered,
                  }),
                );
            })
            .catch(() => {
              if (ws.readyState === WebSocket.OPEN)
                ws.send(
                  JSON.stringify({
                    type: "CONTROL_ACK",
                    id: msg.id,
                    delivered: false,
                  }),
                );
            });
        };
        ws.onclose = () => {
          if (socket === ws) {
            socket = null;
            scheduleReconnect();
          }
        };
        ws.onerror = () => ws.close();
      } catch {
        /* invalid setting: options page explains format */
      }
    },
  );
}
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(
    () => {
      reconnectTimer = null;
      connect();
    },
    retry + Math.random() * 500,
  );
  retry = Math.min(retry * 2, 30000);
}
function report(state: SourceState, tabId: number): void {
  if (
    selectedTab !== null &&
    selectedTab !== tabId &&
    !state.playing &&
    lastState?.playing
  )
    return;
  if (state.playing || selectedTab === null || selectedTab === tabId)
    selectedTab = tabId;
  if (selectedTab !== tabId) return;
  lastState = state;
  lastReport = Date.now();
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(state));
  else connect();
}
chrome.runtime.onMessage.addListener((message: any, sender: any) => {
  if (
    message?.type === "SOURCE_STATE" &&
    sender.tab?.id !== undefined &&
    sender.url?.startsWith("https://music.youtube.com/")
  )
    report(message.state, sender.tab.id);
});
chrome.tabs.onRemoved.addListener((tabId: number) => {
  if (tabId !== selectedTab) return;
  const volume = lastState?.volume ?? 1;
  const muted = lastState?.muted ?? false;
  selectedTab = null;
  lastState = null;
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(
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
});
chrome.storage.onChanged.addListener((changes: any) => {
  if (changes.serverUrl) {
    socket?.close();
    socket = null;
    retry = 1000;
    connect();
  }
});
// Chrome 116+ resets a service worker's idle timer on WebSocket activity.
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "PING" }));
  else connect();
}, 20000);
connect();

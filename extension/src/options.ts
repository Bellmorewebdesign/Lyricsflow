declare const chrome: any;
const input = document.querySelector<HTMLInputElement>("#server")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
chrome.storage.sync.get(
  { serverUrl: "ws://192.168.1.14:8766/ws" },
  (settings: { serverUrl: string }) => {
    input.value = settings.serverUrl;
  },
);
document.querySelector("form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const url = new URL(input.value.trim());
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname !== "/ws"
    )
      throw Error();
    chrome.storage.sync.set({ serverUrl: url.href }, () => {
      statusEl.textContent = "Saved. The extension will reconnect.";
    });
  } catch {
    statusEl.textContent = "Use ws://HOST:PORT/ws (or wss://…/ws).";
  }
});

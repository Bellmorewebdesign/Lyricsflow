import type { Command } from "../../shared/protocol.js";
import { readTrack } from "./metadata.js";
import { ReportGate } from "./report-gate.js";
declare const chrome: any;
let media: HTMLMediaElement | null = null;
let lastSignature = "";
let lastPosition = -1;
let observerTimer: ReturnType<typeof setTimeout> | null = null;
const $ = (selector: string): HTMLElement | null =>
  document.querySelector(selector);
const gate = new ReportGate();
function findMedia(): void {
  const next = document.querySelector(
    "video, audio",
  ) as HTMLMediaElement | null;
  if (next === media) return;
  if (media)
    for (const event of events) media.removeEventListener(event, mediaChanged);
  media = next;
  if (media)
    for (const event of events) media.addEventListener(event, mediaChanged);
  report(true);
}
const events = [
  "play",
  "playing",
  "pause",
  "seeking",
  "seeked",
  "ended",
  "loadedmetadata",
  "durationchange",
  "ratechange",
  "emptied",
];
function mediaChanged(event: Event): void {
  report(event.type === "seeking" || event.type === "seeked", true);
}
function report(seek = false, force = false): void {
  const bar = $("ytmusic-player-bar");
  const url = new URL(location.href);
  const track = readTrack(
    bar,
    media?.duration || 0,
    url.searchParams.get("v") || undefined,
  );
  const positionMs =
    media && Number.isFinite(media.currentTime)
      ? Math.max(0, Math.round(media.currentTime * 1000))
      : 0;
  const titlePresent = !!bar?.querySelector(".title")?.textContent?.trim();
  const bylinePresent = !!bar?.querySelector(".byline")?.textContent?.trim();
  const state = gate.accept(
    {
      track,
      positionMs,
      playing: !!media && !media.paused && !media.ended,
      rate: media?.playbackRate || 1,
      seek,
      clearEvidence: !titlePresent && !bylinePresent && (!media || media.ended),
    },
    Date.now(),
  );
  if (!state) return;
  const signature = JSON.stringify([
    track,
    state.playing,
    state.ended,
    state.rate,
  ]);
  if (
    !force &&
    !seek &&
    signature === lastSignature &&
    Math.abs(positionMs - lastPosition) < 4500
  )
    return;
  lastSignature = signature;
  lastPosition = positionMs;
  chrome.runtime.sendMessage({ type: "SOURCE_STATE", state }).catch(() => {});
}
function control(command: Command): boolean {
  const bar = $("ytmusic-player-bar");
  const selector =
    command === "NEXT"
      ? ".next-button, #next"
      : command === "PREVIOUS"
        ? ".previous-button, #previous"
        : ".play-pause-button, #play-pause-button";
  const button = bar?.querySelector(selector) as HTMLElement | null;
  if (!button || (button as HTMLButtonElement).disabled) return false;
  button.click();
  setTimeout(() => report(true, true), 250);
  return true;
}
chrome.runtime.onMessage.addListener(
  (message: any, _sender: any, respond: (answer: any) => void) => {
    if (message?.type === "REPORT_NOW") {
      findMedia();
      report(false, true);
    }
    if (message?.type === "CONTROL")
      respond({
        delivered:
          ["NEXT", "PREVIOUS", "PLAY_PAUSE"].includes(message.command) &&
          control(message.command),
      });
  },
);
function observeBar(): void {
  const bar = $("ytmusic-player-bar");
  if (!bar) {
    setTimeout(observeBar, 1000);
    return;
  }
  new MutationObserver(() => {
    if (observerTimer) return;
    observerTimer = setTimeout(() => {
      observerTimer = null;
      findMedia();
      report();
    }, 250);
  }).observe(bar, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src", "href", "title"],
  });
  findMedia();
  report(false, true);
}
observeBar();
// YT Music is an SPA. This also finds replacement media elements and corrects drift.
setInterval(() => {
  findMedia();
  report(false, true);
}, 5000);
window.addEventListener("popstate", () =>
  setTimeout(() => report(false, true), 100),
);

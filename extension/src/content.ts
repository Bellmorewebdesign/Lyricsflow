import type { Command } from "../../shared/protocol.js";
import { readTrack } from "./metadata.js";
import { ReportGate } from "./report-gate.js";
import {
  chooseMedia,
  MediaVolumeTracker,
  observeVolume,
  setMediaVolume,
} from "./volume.js";
declare const chrome: any;
declare const __DEBUG_VOLUME__: boolean;
let media: HTMLMediaElement | null = null;
let stopVolume: (() => void) | null = null;
const volumes = new MediaVolumeTracker();
let lastSignature = "";
let lastPosition = -1;
let observerTimer: ReturnType<typeof setTimeout> | null = null;
const $ = (selector: string): HTMLElement | null =>
  document.querySelector(selector);
const gate = new ReportGate();
function findMedia(): void {
  const next = chooseMedia(
    Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio")),
    media,
    document.querySelector("ytmusic-player"),
  );
  if (next === media) return;
  const before = volumes.known;
  const after = volumes.replace(next);
  if (__DEBUG_VOLUME__)
    console.debug("Media element changed:", {
      before,
      after,
      selected: !!next,
    });
  stopVolume?.();
  if (media)
    for (const event of events) media.removeEventListener(event, mediaChanged);
  media = next;
  if (media)
    for (const event of events) media.addEventListener(event, mediaChanged);
  stopVolume = media
    ? observeVolume(media, () => {
        if (__DEBUG_VOLUME__)
          console.debug("Media volumechange:", volumes.observe(media));
        report(false, true);
      })
    : null;
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
      ...(volumes.observe(media) || { volume: null, muted: null }),
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
    state.volume,
    state.muted,
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
    if (message?.type === "SET_VOLUME") {
      findMedia();
      if (__DEBUG_VOLUME__)
        console.debug("SET_VOLUME requested (Galaxy):", message.volume);
      const delivered = setMediaVolume(media, message.volume);
      if (delivered) {
        const applied = volumes.observe(media);
        if (__DEBUG_VOLUME__)
          console.debug("SET_VOLUME applied (Galaxy):", applied);
        report(false, true);
      }
      respond({ delivered });
    }
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
// Media can be created outside the player bar. Adopt it as soon as it becomes usable.
const mediaNode = (node: Node): boolean =>
  node instanceof HTMLMediaElement ||
  (node instanceof Element && !!node.querySelector("video, audio"));
new MutationObserver((changes) => {
  if (
    changes.some(
      (change) =>
        (change.type === "attributes" &&
          (change.target instanceof HTMLMediaElement ||
            change.target.parentElement instanceof HTMLMediaElement)) ||
        Array.from(change.addedNodes).some(mediaNode) ||
        Array.from(change.removedNodes).some(mediaNode),
    )
  )
    findMedia();
}).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src"],
});
document.addEventListener("loadedmetadata", findMedia, true);
document.addEventListener("play", findMedia, true);
// YT Music is an SPA. This also finds replacement media elements and corrects drift.
setInterval(() => {
  findMedia();
  report(false, true);
}, 5000);
window.addEventListener("popstate", () =>
  setTimeout(() => report(false, true), 100),
);

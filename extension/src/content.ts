import type { Command } from "../../shared/protocol.js";
import {
  PlayerDurationTracker,
  readPlayerMetadata,
  readTrack,
} from "./metadata.js";
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
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lastBarIdentity = "";
let lastVideoId = "";
let lastMediaSrc = "";
const $ = (selector: string): HTMLElement | null =>
  document.querySelector(selector);
const gate = new ReportGate();
const durations = new PlayerDurationTracker();
function noteTransition(bar: Element | null, videoId: string): void {
  const metadata = readPlayerMetadata(bar);
  const identity = metadata
    ? JSON.stringify([metadata.title, metadata.artist])
    : "";
  const src = media?.currentSrc || media?.getAttribute("src") || "";
  if (
    (identity && lastBarIdentity && identity !== lastBarIdentity) ||
    (videoId && lastVideoId && videoId !== lastVideoId) ||
    (src && lastMediaSrc && src !== lastMediaSrc)
  )
    volumes.beginTransition();
  if (identity) lastBarIdentity = identity;
  if (videoId) lastVideoId = videoId;
  if (src) lastMediaSrc = src;
}
function findMedia(): void {
  const next = chooseMedia(
    Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio")),
    media,
    document.querySelector("ytmusic-player"),
  );
  if (next === media) {
    noteTransition(
      $("ytmusic-player-bar"),
      new URL(location.href).searchParams.get("v") || "",
    );
    volumes.observe(media);
    return;
  }
  if (media && next) volumes.beginTransition();
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
        noteTransition(
          $("ytmusic-player-bar"),
          new URL(location.href).searchParams.get("v") || "",
        );
        const before = volumes.known;
        const reported = volumes.observe(media);
        if (__DEBUG_VOLUME__)
          console.debug("Media volumechange:", {
            before,
            reported,
            actual: media?.volume,
          });
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
  "loadstart",
  "loadedmetadata",
  "durationchange",
  "ratechange",
  "emptied",
];
function mediaChanged(event: Event): void {
  if (["ended", "emptied", "loadstart", "loadedmetadata"].includes(event.type))
    volumes.beginTransition();
  volumes.observe(media);
  report(event.type === "seeking" || event.type === "seeked", true);
}
function report(seek = false, force = false): void {
  const bar = $("ytmusic-player-bar");
  const url = new URL(location.href);
  const videoId = url.searchParams.get("v") || "";
  noteTransition(bar, videoId);
  const metadata = readPlayerMetadata(bar);
  const duration = durations.resolve(
    JSON.stringify([metadata?.title, metadata?.artist, videoId]),
    bar,
    media?.duration || 0,
    Date.now(),
  );
  const track = readTrack(bar, duration, videoId || undefined);
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
  if (!state) {
    if (gate.needsRecheck && !settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = null;
        findMedia();
        report();
      }, 800);
    return;
  }
  const signature = JSON.stringify([
    state.track,
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
  if (command === "NEXT" || command === "PREVIOUS") volumes.beginTransition();
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
      if (
        typeof message.volume !== "number" ||
        !Number.isFinite(message.volume) ||
        message.volume < 0 ||
        message.volume > 1
      ) {
        respond({ delivered: false });
        return;
      }
      if (__DEBUG_VOLUME__)
        console.debug("SET_VOLUME requested (Galaxy):", message.volume);
      volumes.authorizeRequestedVolume(message.volume);
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
// A gesture at 50% is not permission for the player to reset to 100%.
// Only a trusted desktop input explicitly at its maximum authorizes it.
function desktopVolumeGesture(event: Event): void {
  if (!event.isTrusted) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const slider = target.closest(
    "ytmusic-player-bar #volume-slider, ytmusic-player-bar .volume-slider, ytmusic-player-bar .volume, ytmusic-player-bar [aria-label*='volume' i]",
  );
  if (!slider) return;
  if (event instanceof KeyboardEvent && event.key === "End") {
    volumes.authorizeRequestedVolume(1);
    return;
  }
  if (event.type !== "input" && event.type !== "change") return;
  const control = target.closest("input, [role='slider']");
  if (!control) return;
  const current = Number(
    control instanceof HTMLInputElement
      ? control.value
      : control.getAttribute("aria-valuenow"),
  );
  const maximum = Number(
    control instanceof HTMLInputElement
      ? control.max
      : control.getAttribute("aria-valuemax"),
  );
  if (maximum > 0 && Number.isFinite(current))
    volumes.authorizeRequestedVolume(current >= maximum ? 1 : 0);
}
document.addEventListener("input", desktopVolumeGesture, true);
document.addEventListener("change", desktopVolumeGesture, true);
document.addEventListener("keydown", desktopVolumeGesture, true);
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
const mediaNodes = (node: Node): HTMLMediaElement[] => [
  ...(node instanceof HTMLMediaElement ? [node] : []),
  ...(node instanceof Element
    ? Array.from(node.querySelectorAll<HTMLMediaElement>("video, audio"))
    : []),
];
new MutationObserver((changes) => {
  for (const change of changes)
    for (const node of Array.from(change.addedNodes))
      for (const candidate of mediaNodes(node))
        if (candidate !== media) volumes.prepare(candidate);
  if (
    changes.some(
      (change) =>
        (change.type === "attributes" &&
          (change.target instanceof HTMLMediaElement ||
            change.target.parentElement instanceof HTMLMediaElement)) ||
        Array.from(change.addedNodes).some((node) => mediaNodes(node).length) ||
        Array.from(change.removedNodes).some((node) => mediaNodes(node).length),
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
document.addEventListener(
  "volumechange",
  (event) => {
    if (event.target instanceof HTMLMediaElement && event.target !== media)
      volumes.prepare(event.target);
  },
  true,
);
// YT Music is an SPA. This also finds replacement media elements and corrects drift.
setInterval(() => {
  findMedia();
  report(false, true);
}, 5000);
window.addEventListener("popstate", () =>
  setTimeout(() => report(false, true), 100),
);

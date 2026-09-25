import type { Track } from "../../shared/protocol.js";

export interface BylineLink {
  text: string;
  href: string;
}
export interface PlayerMetadata {
  title: string;
  artist: string;
  album?: string;
}
const visible = (value: string): string =>
  value
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const isYear = (value: string): boolean => /^(?:19|20)\d{2}$/.test(value);
const isArtistLink = (href: string): boolean =>
  /\/(?:channel\/|browse\/UC)/i.test(href);
const isAlbumLink = (href: string): boolean =>
  /\/browse\/MPRE|[?&]list=OLAK/i.test(href);

/** Prefer identified artist links. The text fallback only uses the first byline field. */
export function parsePlayerMetadata(
  titleText: string,
  bylineText: string,
  links: BylineLink[],
): PlayerMetadata | null {
  const title = visible(titleText);
  const fields = bylineText.split(/[•·]/).map(visible).filter(Boolean);
  const artistLinks = links
    .filter((link) => isArtistLink(link.href))
    .map((link) => visible(link.text))
    .filter(Boolean);
  const uniqueArtists = artistLinks.filter(
    (name, index) => artistLinks.indexOf(name) === index,
  );
  const artist = uniqueArtists.length
    ? uniqueArtists.join(", ")
    : fields[0] || visible(links[0]?.text || "");
  if (!title || !artist) return null;
  const linkedAlbum = links.find((link) => isAlbumLink(link.href));
  const album =
    visible(linkedAlbum?.text || "") ||
    fields
      .slice(1)
      .find((field) => !isYear(field) && !uniqueArtists.includes(field));
  return { title, artist, ...(album ? { album } : {}) };
}

export function readPlayerMetadata(bar: Element | null): PlayerMetadata | null {
  if (!bar) return null;
  const byline = bar.querySelector(".byline");
  const anchors = Array.from(byline?.querySelectorAll("a") || []).map(
    (anchor) => ({
      text: anchor.textContent || "",
      href: anchor.getAttribute("href") || "",
    }),
  );
  return parsePlayerMetadata(
    bar.querySelector(".title")?.textContent || "",
    byline?.textContent || "",
    anchors,
  );
}

function parseClock(value: string): number {
  const parts = value.trim().split(":");
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => !/^\d{1,3}$/.test(part))
  )
    return 0;
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((part) => part >= 60)) return 0;
  const seconds = numbers.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 && seconds < 12 * 3600 ? seconds : 0;
}

/** The player's end-time is more reliable than streaming media.duration. */
export function readPlayerDuration(bar: Element | null): number {
  const label = bar?.querySelector(".time-info")?.textContent || "";
  const clock =
    (label.split("/").pop() || "").match(/\d{1,3}:\d{2}(?::\d{2})?/g)?.pop() ||
    "";
  const labeled = parseClock(clock);
  if (labeled) return labeled;
  const slider =
    bar?.querySelector("#progress-bar #sliderBar[aria-valuemax]") ||
    bar?.querySelector("#progress-bar [role='slider'][aria-valuemax]") ||
    bar?.querySelector("#progress-bar[aria-valuemax]");
  const max = Number(slider?.getAttribute("aria-valuemax"));
  // 100 is also the default percentage range on some progress controls.
  return Number.isFinite(max) && max > 100 && max < 12 * 3600 ? max : 0;
}

/** Read the clock that YouTube Music shows to its listener, if it is present. */
export function readPlayerPosition(bar: Element | null): number | null {
  const label = bar?.querySelector(".time-info")?.textContent || "";
  const clock = (label.split("/")[0] || "").match(
    /\d{1,3}:\d{2}(?::\d{2})?/g,
  )?.[0];
  if (clock) {
    const value = parseClock(clock);
    if (value || /^0+:0{2}(?::0{2})?$/.test(clock)) return value * 1000;
  }
  const slider =
    bar?.querySelector("#progress-bar #sliderBar[aria-valuenow]") ||
    bar?.querySelector("#progress-bar [role='slider'][aria-valuenow]");
  const max = Number(slider?.getAttribute("aria-valuemax"));
  const current = Number(slider?.getAttribute("aria-valuenow"));
  // A max of 100 may describe percentage, not playback seconds.
  return Number.isFinite(max) &&
    max > 100 &&
    Number.isFinite(current) &&
    current >= 0 &&
    current <= max
    ? Math.round(current * 1000)
    : null;
}

/** Trust the visible clock, but ignore a stopped UI clock while media plays. */
export class PlayerPositionTracker {
  private clock: number | null = null;
  private since = 0;
  private transitionUntil = 0;
  private lastMediaMs: number | null = null;
  private mediaAtClock = 0;
  private awaitingNewClock = false;
  private followPlayer = false;
  /** The player bar confirmed the new audio while the media clock did not restart. */
  followPlayerClock(value: boolean): void {
    this.followPlayer = value;
  }
  beginTransition(now: number): void {
    // The player bar may still show the outgoing song's clock after the
    // media element has already restarted for the next song.
    this.transitionUntil = now + 10000;
    this.awaitingNewClock = true;
  }
  resolve(
    bar: Element | null,
    mediaMs: number,
    playing: boolean,
    now: number,
    seek = false,
  ): number {
    // Autoplay can restart the media well after the URL and title change.
    // Restart the clock handoff at the actual rewind, not only at the DOM edit.
    if (
      this.lastMediaMs !== null &&
      mediaMs <= 30000 &&
      mediaMs < this.lastMediaMs - 3000
    )
      this.beginTransition(now);
    this.lastMediaMs = mediaMs;
    const clock = readPlayerPosition(bar);
    if (clock === null) {
      if (this.followPlayer && this.clock !== null)
        return (
          this.clock +
          (mediaMs >= this.mediaAtClock ? mediaMs - this.mediaAtClock : 0)
        );
      this.clock = null;
      return mediaMs;
    }
    if (clock !== this.clock) {
      this.clock = clock;
      this.since = now;
      this.mediaAtClock = mediaMs;
    }
    // The visible player time only has whole-second precision. Carry its
    // position forward by actual media progress between UI clock repaints,
    // even when media.currentTime has a different absolute origin.
    const mediaProgress = mediaMs - this.mediaAtClock;
    const elapsed = Math.max(0, now - this.since);
    const fractionalProgress =
      !seek && mediaProgress >= 0 && mediaProgress <= elapsed * 2.5 + 500
        ? mediaProgress
        : 0;
    // After a confirmed player-clock restart, the underlying media clock may
    // be continuous. Never silently jump the displayed lyrics back to it.
    if (this.followPlayer) {
      // If the visible seconds stop repainting in a background tab, carry
      // their last known position forward by actual media progress only.
      if (now - this.since > 2500 && mediaMs >= this.mediaAtClock)
        return clock + (mediaMs - this.mediaAtClock);
      return clock + fractionalProgress;
    }
    const difference = Math.abs(clock - mediaMs);
    if (
      difference <= 1500 ||
      (now >= this.transitionUntil && difference <= 10000)
    )
      this.awaitingNewClock = false;
    if (
      playing &&
      (now < this.transitionUntil || this.awaitingNewClock) &&
      difference > 10000
    )
      return mediaMs;
    if (playing && (now - this.since > 2500 || seek) && difference > 1500)
      return mediaMs;
    // Absolute media time can be several seconds away from the player bar;
    // its small increments still restore sub-second timing for dense lyrics.
    return difference <= 1500
      ? clock + (mediaMs % 1000)
      : clock + fractionalProgress;
  }
}

/** Confirm a duration before matching lyrics; changing media durations are ignored. */
export class PlayerDurationTracker {
  private identity = "";
  private candidate = 0;
  private since = 0;
  private confirmed = 0;
  resolve(
    identity: string,
    bar: Element | null,
    mediaDuration: number,
    now: number,
  ): number {
    if (identity !== this.identity) {
      this.identity = identity;
      this.candidate = 0;
      this.confirmed = 0;
    }
    const playerDuration = readPlayerDuration(bar);
    const raw =
      playerDuration ||
      (Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : 0);
    if (raw > 0 && Math.abs(raw - this.confirmed) > 1) {
      if (Math.abs(raw - this.candidate) > 0.5) {
        this.candidate = raw;
        this.since = now;
      } else if (now - this.since >= (playerDuration ? 650 : 2000)) {
        this.confirmed = raw;
      }
    }
    return this.confirmed;
  }
}

export function readTrack(
  bar: Element | null,
  duration: number,
  videoId?: string,
): Track | null {
  const metadata = readPlayerMetadata(bar);
  if (!metadata) return null;
  const image = bar?.querySelector(
    "img.image, .thumbnail img, img",
  ) as HTMLImageElement | null;
  const inlineBackground =
    (bar?.querySelector(".image, .thumbnail") as HTMLElement | null)?.style
      .backgroundImage || "";
  const backgroundUrl = /^url\(["']?(.*?)["']?\)$/.exec(inlineBackground)?.[1];
  return {
    ...metadata,
    durationMs: Math.round(duration * 1000),
    artwork: image?.currentSrc || image?.src || backgroundUrl || undefined,
    videoId,
  };
}

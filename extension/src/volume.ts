export interface MediaVolume {
  volume: number;
  muted: boolean;
}

/** A missing or invalid media element is unknown, never an assumed 100%. */
export function readMediaVolume(
  media: Pick<HTMLMediaElement, "volume" | "muted"> | null,
): MediaVolume | null {
  if (
    !media ||
    !Number.isFinite(media.volume) ||
    media.volume < 0 ||
    media.volume > 1 ||
    typeof media.muted !== "boolean"
  )
    return null;
  return { volume: media.volume, muted: media.muted };
}

/** The known source volume survives short gaps in the YouTube Music DOM. */
export class MediaVolumeTracker {
  private last: MediaVolume | null = null;
  private transitionUntil = 0;
  private userMaximumUntil = 0;

  get known(): MediaVolume | null {
    return this.last;
  }

  /** A player may reset even the same media element to its default during a song change. */
  beginTransition(now = Date.now()): void {
    if (this.last) {
      this.transitionUntil = now + 4000;
      this.userMaximumUntil = 0;
    }
  }

  /** Only an explicit request for maximum may authorize a 100% reading. */
  authorizeRequestedVolume(value: number, now = Date.now()): void {
    this.userMaximumUntil = value === 1 ? now + 4000 : 0;
  }

  /** Prepare an inserted playback element before it becomes audible. */
  prepare(media: HTMLMediaElement): boolean {
    const incoming = readMediaVolume(media);
    if (
      !this.last ||
      !incoming ||
      incoming.volume !== 1 ||
      this.last.volume >= 1
    )
      return false;
    media.volume = this.last.volume;
    media.muted = this.last.muted;
    return true;
  }

  observe(
    media: HTMLMediaElement | null,
    now = Date.now(),
  ): MediaVolume | null {
    const value = readMediaVolume(media);
    if (
      media &&
      value &&
      this.last &&
      value.volume === 1 &&
      this.last.volume < 1 &&
      now >= this.userMaximumUntil
    ) {
      // Default 1.0 must never erase a known lower level without a user gesture.
      media.volume = this.last.volume;
      media.muted = this.last.muted;
      return this.last;
    }
    if (
      media &&
      value &&
      this.last &&
      now < this.transitionUntil &&
      value.volume === this.last.volume &&
      this.last.muted &&
      !value.muted &&
      now >= this.userMaximumUntil
    ) {
      media.muted = true;
      return this.last;
    }
    if (value) {
      if (value.volume < 1) this.userMaximumUntil = 0;
      this.last = value;
    }
    return this.last;
  }

  replace(next: HTMLMediaElement | null): MediaVolume | null {
    // A detached element can reset to 1. Keep its last observed value.
    if (!next) return this.last;
    this.beginTransition();
    const incoming = readMediaVolume(next);
    if (this.last && incoming) {
      // New HTMLMediaElements default to 1. Restore the known level before playback.
      if (
        !this.prepare(next) &&
        incoming.volume === this.last.volume &&
        this.last.muted &&
        !incoming.muted
      ) {
        next.muted = true;
      }
      // A nondefault value may be a genuine desktop adjustment.
    }
    return this.observe(next);
  }
}

export function mediaIsUsable(media: HTMLMediaElement): boolean {
  return (
    (Number.isFinite(media.duration) && media.duration > 0) ||
    !!media.currentSrc ||
    (!media.paused && !media.ended && media.readyState >= 1)
  );
}

/** Keep the known player unless another eligible element actually starts. */
export function chooseMedia(
  candidates: readonly HTMLMediaElement[],
  current: HTMLMediaElement | null,
  player: Element | null,
): HTMLMediaElement | null {
  const eligible = candidates.filter(
    (candidate) => candidate.isConnected && mediaIsUsable(candidate),
  );
  const playing = (candidate: HTMLMediaElement): boolean =>
    !candidate.paused && !candidate.ended;
  if (
    current &&
    eligible.includes(current) &&
    (playing(current) || !eligible.some(playing))
  )
    return current;
  let best: HTMLMediaElement | null = null;
  let bestScore = -1;
  for (const candidate of eligible) {
    const score =
      (playing(candidate) ? 100 : 0) +
      (player?.contains(candidate) ? 20 : 0) +
      (Number.isFinite(candidate.duration) && candidate.duration > 0 ? 10 : 0) +
      (candidate.currentSrc ? 5 : 0) +
      (candidate === current ? 2 : 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function setMediaVolume(
  media: HTMLMediaElement | null,
  value: number,
): boolean {
  if (
    !media ||
    !Number.isFinite(value) ||
    !media.isConnected ||
    !mediaIsUsable(media)
  )
    return false;
  media.volume = Math.max(0, Math.min(1, value));
  if (media.volume > 0 && media.muted) media.muted = false;
  return true;
}

export function observeVolume(
  media: HTMLMediaElement,
  notify: () => void,
): () => void {
  media.addEventListener("volumechange", notify);
  return () => media.removeEventListener("volumechange", notify);
}

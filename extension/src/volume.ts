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

  get known(): MediaVolume | null {
    return this.last;
  }

  observe(media: HTMLMediaElement | null): MediaVolume | null {
    const value = readMediaVolume(media);
    if (value) this.last = value;
    return this.last;
  }

  replace(next: HTMLMediaElement | null): MediaVolume | null {
    // A detached element can reset to 1. Keep its last observed value.
    if (!next) return this.last;
    const incoming = readMediaVolume(next);
    if (this.last && incoming) {
      // New HTMLMediaElements default to 1. Restore the known level before playback.
      if (incoming.volume === 1 && this.last.volume < 1) {
        next.volume = this.last.volume;
        next.muted = this.last.muted;
      } else if (
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

/** The media element owns volume and mute; commands report its resulting values. */
export function readMediaVolume(
  media: Pick<HTMLMediaElement, "volume" | "muted"> | null,
): {
  volume: number;
  muted: boolean;
} {
  return {
    volume:
      media && Number.isFinite(media.volume)
        ? Math.max(0, Math.min(1, media.volume))
        : 1,
    muted: !!media?.muted,
  };
}

export function setMediaVolume(
  media: HTMLMediaElement | null,
  value: number,
): boolean {
  if (!media || !Number.isFinite(value)) return false;
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

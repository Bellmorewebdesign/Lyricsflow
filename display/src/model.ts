import type { Snapshot } from "../../shared/protocol.js";
export type DisplayState =
  "STANDBY" | "PLAYING" | "PAUSED" | "NO_LYRICS" | "HOLDING" | "DISCONNECTED";
export function effectivePosition(
  snapshot: Snapshot,
  receiptTime: number,
  now: number,
): number {
  return Math.max(
    0,
    Math.min(
      snapshot.track?.durationMs || Infinity,
      snapshot.positionMs +
        (snapshot.playing ? Math.max(0, now - receiptTime) * snapshot.rate : 0),
    ),
  );
}
export function lineIndex(
  lines: { startMs: number }[],
  position: number,
): number {
  let low = 0,
    high = lines.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lines[middle]!.startMs <= position) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}
/** Schedule the next lyric from its timestamp, including densely timed lines. */
export function nextLineDelay(
  lines: { startMs: number }[],
  index: number,
  position: number,
  rate: number,
): number | null {
  const next = lines[index + 1];
  if (!next || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.max(1, Math.min((next.startMs - position) / rate, 10000));
}
export function displayState(
  snapshot: Snapshot | null,
  connected: boolean,
  now: number,
  pausedAt: number | null,
  lastActive: number,
): DisplayState {
  if (!connected || !snapshot?.sourceConnected) return "DISCONNECTED";
  if (!snapshot.track)
    return lastActive && now - lastActive < 8000 ? "HOLDING" : "STANDBY";
  if (!snapshot.playing && pausedAt !== null && now - pausedAt >= 60000)
    return "STANDBY";
  if (!snapshot.lyrics?.lines.length) return "NO_LYRICS";
  if (snapshot.playing) return "PLAYING";
  return "PAUSED";
}

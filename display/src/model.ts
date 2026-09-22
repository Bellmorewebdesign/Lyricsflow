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
  if (!snapshot.lyrics?.lines.length) return "NO_LYRICS";
  if (snapshot.playing) return "PLAYING";
  if (pausedAt !== null && now - pausedAt < 60000) return "PAUSED";
  if (lastActive && now - lastActive < 8000 && pausedAt === null)
    return "PAUSED";
  return "STANDBY";
}

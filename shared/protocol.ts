export const PROTOCOL_VERSION = 2;
export type Command = "PREVIOUS" | "PLAY_PAUSE" | "NEXT";
export interface Track {
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  videoId?: string;
  durationMs: number;
}
export interface Line {
  startMs: number;
  text: string;
}
export interface Lyrics {
  provider: string;
  lines: Line[];
}
export interface SourceState {
  type: "SOURCE_STATE";
  track: Track | null;
  positionMs: number;
  playing: boolean;
  ended: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  seek?: boolean;
}
export interface Snapshot {
  type: "SERVER_STATE";
  version: number;
  track: Track | null;
  positionMs: number;
  playing: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  lyrics: Lyrics | null;
  sourceConnected: boolean;
  updatedAt: number;
  seek?: boolean;
}
export type Incoming =
  | { type: "HELLO"; role: "source" | "display"; protocol: 2 }
  | SourceState
  | { type: "CONTROL_COMMAND"; command: Command; id: string }
  | { type: "SET_VOLUME"; volume: number; id: string }
  | { type: "CONTROL_ACK"; id: string; delivered: boolean }
  | { type: "PING" };
export type Outgoing =
  | Snapshot
  | { type: "CONTROL_COMMAND"; command: Command; id: string }
  | { type: "SET_VOLUME"; volume: number; id: string }
  | { type: "CONTROL_ACK"; id: string; delivered: boolean }
  | { type: "PONG" };
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const number = (v: unknown, max = 86_400_000): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
const id = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 80;
export function parseIncoming(raw: string): Incoming | null {
  if (raw.length > 16_384) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record(v)) return null;
  if (
    v.type === "HELLO" &&
    v.protocol === PROTOCOL_VERSION &&
    (v.role === "source" || v.role === "display")
  )
    return { type: "HELLO", role: v.role, protocol: PROTOCOL_VERSION };
  if (v.type === "PING") return { type: "PING" };
  if (v.type === "CONTROL_ACK" && id(v.id) && typeof v.delivered === "boolean")
    return { type: "CONTROL_ACK", id: v.id, delivered: v.delivered };
  if (
    v.type === "CONTROL_COMMAND" &&
    (v.command === "PREVIOUS" ||
      v.command === "PLAY_PAUSE" ||
      v.command === "NEXT") &&
    id(v.id)
  )
    return { type: "CONTROL_COMMAND", command: v.command, id: v.id };
  if (v.type === "SET_VOLUME" && number(v.volume, 1) && id(v.id))
    return { type: "SET_VOLUME", volume: v.volume, id: v.id };
  if (
    v.type === "SOURCE_STATE" &&
    number(v.positionMs) &&
    typeof v.playing === "boolean" &&
    typeof v.ended === "boolean" &&
    number(v.rate, 8) &&
    v.rate > 0 &&
    number(v.volume, 1) &&
    typeof v.muted === "boolean" &&
    (v.seek === undefined || typeof v.seek === "boolean")
  ) {
    if (v.track === null)
      return {
        type: "SOURCE_STATE",
        track: null,
        positionMs: v.positionMs,
        playing: v.playing,
        ended: v.ended,
        rate: v.rate,
        volume: v.volume,
        muted: v.muted,
        seek: v.seek,
      };
    if (
      record(v.track) &&
      typeof v.track.title === "string" &&
      v.track.title.length <= 300 &&
      typeof v.track.artist === "string" &&
      v.track.artist.length <= 300 &&
      number(v.track.durationMs) &&
      ["album", "artwork", "videoId"].every(
        (k) =>
          v.track &&
          record(v.track) &&
          (v.track[k] === undefined ||
            (typeof v.track[k] === "string" && v.track[k].length <= 2048)),
      )
    ) {
      const t = v.track;
      return {
        type: "SOURCE_STATE",
        track: {
          title: t.title as string,
          artist: t.artist as string,
          durationMs: t.durationMs as number,
          ...(typeof t.album === "string" ? { album: t.album } : {}),
          ...(typeof t.artwork === "string" ? { artwork: t.artwork } : {}),
          ...(typeof t.videoId === "string" ? { videoId: t.videoId } : {}),
        },
        positionMs: v.positionMs,
        playing: v.playing,
        ended: v.ended,
        rate: v.rate,
        volume: v.volume,
        muted: v.muted,
        seek: v.seek,
      };
    }
  }
  return null;
}

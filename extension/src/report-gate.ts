import type { SourceState, Track } from "../../shared/protocol.js";
export interface PlaybackRead {
  track: Track | null;
  positionMs: number;
  playing: boolean;
  rate: number;
  clearEvidence: boolean;
  seek: boolean;
}
/** Invalid DOM reads are silent. Only a sustained empty player can clear a known track. */
export class ReportGate {
  private lastTrack: Track | null = null;
  private emptySince: number | null = null;
  constructor(private readonly graceMs = 8000) {}
  accept(read: PlaybackRead, now: number): SourceState | null {
    if (read.track) {
      this.lastTrack = read.track;
      this.emptySince = null;
      return {
        type: "SOURCE_STATE",
        track: read.track,
        positionMs: read.positionMs,
        playing: read.playing,
        ended: false,
        rate: read.rate,
        seek: read.seek,
      };
    }
    if (!this.lastTrack || !read.clearEvidence) {
      this.emptySince = null;
      return null;
    }
    if (this.emptySince === null) this.emptySince = now;
    if (now - this.emptySince < this.graceMs) return null;
    this.lastTrack = null;
    this.emptySince = null;
    return {
      type: "SOURCE_STATE",
      track: null,
      positionMs: 0,
      playing: false,
      ended: true,
      rate: 1,
    };
  }
}

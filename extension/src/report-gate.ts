import type { SourceState, Track } from "../../shared/protocol.js";
export interface PlaybackRead {
  track: Track | null;
  positionMs: number;
  playing: boolean;
  rate: number;
  volume: number | null;
  muted: boolean | null;
  clearEvidence: boolean;
  seek: boolean;
}
/** Invalid DOM reads are silent. Only a sustained empty player can clear a known track. */
export class ReportGate {
  private lastTrack: Track | null = null;
  private emptySince: number | null = null;
  private pendingTrack = "";
  private pendingSince = 0;
  private lastPositionMs = 0;
  get needsRecheck(): boolean {
    return !!this.pendingTrack;
  }
  constructor(
    private readonly graceMs = 8000,
    private readonly settleMs = 700,
  ) {}
  accept(read: PlaybackRead, now: number): SourceState | null {
    if (read.track) {
      let acceptedTrack = read.track;
      const sameRecording =
        this.lastTrack?.title === acceptedTrack.title &&
        this.lastTrack.artist === acceptedTrack.artist &&
        (this.lastTrack.videoId || "") === (acceptedTrack.videoId || "");
      // A streaming duration may grow throughout playback. Keep the first
      // confirmed length until an actual recording change, not every heartbeat.
      if (sameRecording && this.lastTrack?.durationMs)
        acceptedTrack = {
          ...acceptedTrack,
          durationMs: this.lastTrack.durationMs,
        };
      const key = JSON.stringify([
        acceptedTrack.title,
        acceptedTrack.artist,
        acceptedTrack.durationMs,
        acceptedTrack.videoId || "",
      ]);
      const previous =
        this.lastTrack &&
        JSON.stringify([
          this.lastTrack.title,
          this.lastTrack.artist,
          this.lastTrack.durationMs,
          this.lastTrack.videoId || "",
        ]);
      if (this.lastTrack && key !== previous) {
        if (key !== this.pendingTrack) {
          this.pendingTrack = key;
          this.pendingSince = now;
        }
        const changedRecording = !sameRecording;
        // The bar and watch URL can update before the actual playback media.
        // Never pair a new song's lyrics with the outgoing song's currentTime.
        const playbackRestarted =
          read.positionMs <= 10000 ||
          read.positionMs < this.lastPositionMs - 3000;
        const sameMetadata =
          this.lastTrack.title === acceptedTrack.title &&
          this.lastTrack.artist === acceptedTrack.artist;
        const settle =
          changedRecording && sameMetadata
            ? Math.max(2500, this.settleMs)
            : this.settleMs;
        if (
          now - this.pendingSince < settle ||
          (changedRecording && read.playing && !playbackRestarted)
        )
          return null;
      }
      const changedRecording = !!this.lastTrack && !sameRecording;
      this.pendingTrack = "";
      this.lastTrack = acceptedTrack;
      this.lastPositionMs = read.positionMs;
      this.emptySince = null;
      return {
        type: "SOURCE_STATE",
        track: acceptedTrack,
        positionMs: read.positionMs,
        playing: read.playing,
        ended: false,
        rate: read.rate,
        volume: read.volume,
        muted: read.muted,
        seek: read.seek || changedRecording,
      };
    }
    this.pendingTrack = "";
    if (!this.lastTrack || !read.clearEvidence) {
      this.emptySince = null;
      return null;
    }
    if (this.emptySince === null) this.emptySince = now;
    if (now - this.emptySince < this.graceMs) return null;
    this.lastTrack = null;
    this.lastPositionMs = 0;
    this.emptySince = null;
    return {
      type: "SOURCE_STATE",
      track: null,
      positionMs: 0,
      playing: false,
      ended: true,
      rate: 1,
      volume: read.volume,
      muted: read.muted,
    };
  }
}

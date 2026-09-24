import type { SourceState, Track } from "../../shared/protocol.js";
export interface PlaybackRead {
  track: Track | null;
  positionMs: number;
  mediaPositionMs?: number;
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
  private lastMediaMs: number | null = null;
  private mediaRestartedAt: number | null = null;
  get needsRecheck(): boolean {
    return !!this.pendingTrack;
  }
  constructor(
    private readonly graceMs = 8000,
    private readonly settleMs = 700,
  ) {}
  accept(read: PlaybackRead, now: number): SourceState | null {
    const actualMediaMs = read.mediaPositionMs ?? read.positionMs;
    if (
      read.playing &&
      this.lastMediaMs !== null &&
      actualMediaMs <= 30000 &&
      actualMediaMs < this.lastMediaMs - 3000
    )
      this.mediaRestartedAt = now;
    if (read.playing) this.lastMediaMs = actualMediaMs;
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
          actualMediaMs <= 10000 ||
          actualMediaMs < this.lastPositionMs - 3000 ||
          (this.mediaRestartedAt !== null &&
            now - this.mediaRestartedAt < 30000);
        const sameMetadata =
          this.lastTrack.title === acceptedTrack.title &&
          this.lastTrack.artist === acceptedTrack.artist;
        const settle =
          changedRecording && sameMetadata
            ? Math.max(15000, this.settleMs)
            : this.settleMs;
        if (
          now - this.pendingSince < settle ||
          (changedRecording && read.playing && !playbackRestarted)
        ) {
          // A repeated song can restart before the bar identifies the next URL.
          // Advance the known song from its fresh media clock without binding
          // a new URL (possibly another song) to stale title/artist metadata.
          if (
            changedRecording &&
            sameMetadata &&
            this.mediaRestartedAt !== null &&
            now - this.mediaRestartedAt < 30000
          ) {
            this.lastPositionMs = actualMediaMs;
            return {
              type: "SOURCE_STATE",
              track: this.lastTrack,
              positionMs: actualMediaMs,
              playing: read.playing,
              ended: false,
              rate: read.rate,
              volume: read.volume,
              muted: read.muted,
              seek: read.seek || now === this.mediaRestartedAt,
            };
          }
          return null;
        }
      }
      const changedRecording = !!this.lastTrack && !sameRecording;
      const changedMetadata =
        !!this.lastTrack &&
        (this.lastTrack.title !== acceptedTrack.title ||
          this.lastTrack.artist !== acceptedTrack.artist);
      // If the player bar still shows the outgoing clock at the instant the
      // new media starts, publish the fresh media clock until the bar catches up.
      const positionMs =
        changedRecording &&
        read.mediaPositionMs !== undefined &&
        Math.abs(read.positionMs - read.mediaPositionMs) > 2000
          ? read.mediaPositionMs
          : read.positionMs;
      this.pendingTrack = "";
      this.lastTrack = acceptedTrack;
      this.lastPositionMs = read.mediaPositionMs ?? read.positionMs;
      // A URL-only transition can still carry the previous song's title.
      // Keep the rewind evidence until the real title arrives (or it ages out).
      if (changedRecording && changedMetadata) this.mediaRestartedAt = null;
      this.emptySince = null;
      return {
        type: "SOURCE_STATE",
        track: acceptedTrack,
        positionMs,
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
    this.lastMediaMs = null;
    this.mediaRestartedAt = null;
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

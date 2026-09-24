import type { SourceState, Track } from "../../shared/protocol.js";
export interface PlaybackRead {
  track: Track | null;
  positionMs: number;
  mediaPositionMs?: number;
  /** Raw clock in the YouTube Music player bar, independent of media.currentTime. */
  playerPositionMs?: number | null;
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
  private lastPlayerMs: number | null = null;
  private playerRestartedAt: number | null = null;
  private mediaAtPlayerRestart = 0;
  private playerAdvancedAt: number | null = null;
  private playerClockIsSource = false;
  get followsPlayerClock(): boolean {
    return this.playerClockIsSource;
  }
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
    const playerMs = read.playerPositionMs;
    if (read.playing && playerMs != null) {
      if (
        this.lastPlayerMs !== null &&
        playerMs <= 30000 &&
        playerMs < this.lastPlayerMs - 500
      ) {
        this.playerRestartedAt = now;
        this.mediaAtPlayerRestart = actualMediaMs;
        this.playerAdvancedAt = null;
      } else if (
        this.playerRestartedAt !== null &&
        this.lastPlayerMs !== null &&
        playerMs >= this.lastPlayerMs + 500 &&
        playerMs <= 30000
      ) {
        this.playerAdvancedAt = now;
      }
      this.lastPlayerMs = playerMs;
    }
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
        // YT Music can keep a continuous HTMLMediaElement clock across autoplay.
        // A reset AND advancement of its own clock confirms the new audio has
        // started; a newly rendered title or URL alone does not.
        const barClockAdvanced =
          this.playerRestartedAt !== null &&
          this.playerAdvancedAt !== null &&
          this.playerAdvancedAt >= this.playerRestartedAt &&
          now - this.playerRestartedAt < 30000 &&
          playerMs !== null &&
          playerMs !== undefined &&
          playerMs <= 30000;
        const playerRestarted =
          barClockAdvanced ||
          (this.playerRestartedAt !== null &&
            now - this.playerRestartedAt >= 3000 &&
            now - this.playerRestartedAt < 30000 &&
            actualMediaMs - this.mediaAtPlayerRestart >= 2000 &&
            playerMs != null &&
            playerMs <= 30000 &&
            this.lastTrack.videoId !== acceptedTrack.videoId &&
            !sameMetadata);
        const settle =
          changedRecording && sameMetadata
            ? Math.max(15000, this.settleMs)
            : this.settleMs;
        if (
          now - this.pendingSince < settle ||
          (changedRecording &&
            read.playing &&
            !playbackRestarted &&
            !playerRestarted)
        ) {
          // A repeated song can restart before the bar identifies the next URL.
          // Advance the known song from its fresh media clock without binding
          // a new URL (possibly another song) to stale title/artist metadata.
          if (
            changedRecording &&
            sameMetadata &&
            ((this.mediaRestartedAt !== null &&
              now - this.mediaRestartedAt < 30000) ||
              playerRestarted)
          ) {
            const repeatPosition = playerRestarted ? playerMs! : actualMediaMs;
            this.lastPositionMs = actualMediaMs;
            return {
              type: "SOURCE_STATE",
              track: this.lastTrack,
              positionMs: repeatPosition,
              playing: read.playing,
              ended: false,
              rate: read.rate,
              volume: read.volume,
              muted: read.muted,
              seek:
                read.seek ||
                now === this.mediaRestartedAt ||
                now === this.playerAdvancedAt,
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
      const playerRestarted =
        changedRecording &&
        this.playerRestartedAt !== null &&
        now - this.playerRestartedAt < 30000 &&
        playerMs != null &&
        playerMs <= 30000 &&
        ((this.playerAdvancedAt !== null &&
          this.playerAdvancedAt >= this.playerRestartedAt) ||
          (changedMetadata &&
            this.lastTrack?.videoId !== acceptedTrack.videoId &&
            now - this.playerRestartedAt >= 3000 &&
            actualMediaMs - this.mediaAtPlayerRestart >= 2000));
      const playerClockStalled =
        playerRestarted && this.playerAdvancedAt === null;
      if (changedRecording)
        this.playerClockIsSource =
          !!playerRestarted && Math.abs(playerMs! - actualMediaMs) > 2000;
      // If the player bar still shows the outgoing clock at the instant the
      // new media starts, publish the fresh media clock until the bar catches up.
      const positionMs =
        this.playerClockIsSource && playerMs != null
          ? changedRecording
            ? playerMs +
              (playerClockStalled
                ? Math.max(0, actualMediaMs - this.mediaAtPlayerRestart)
                : 0)
            : read.positionMs
          : changedRecording &&
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
      if (changedRecording && changedMetadata) {
        this.playerRestartedAt = null;
        this.playerAdvancedAt = null;
      }
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
    this.lastPlayerMs = null;
    this.playerRestartedAt = null;
    this.playerAdvancedAt = null;
    this.playerClockIsSource = false;
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

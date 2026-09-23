import type {
  Lyrics,
  Snapshot,
  SourceState,
  MasterVolumeState,
  Track,
} from "../../shared/protocol.js";
export function identity(track: Track | null): string {
  return track
    ? JSON.stringify([
        track.title,
        track.artist,
        track.videoId || "",
        track.durationMs > 0,
      ])
    : "";
}
export class StateStore {
  private master: MasterVolumeState | null = null;
  private current: Snapshot = {
    type: "SERVER_STATE",
    version: 0,
    track: null,
    positionMs: 0,
    playing: false,
    rate: 1,
    volume: null,
    muted: null,
    lyrics: null,
    sourceConnected: false,
    updatedAt: Date.now(),
  };
  get snapshot(): Snapshot {
    const s = this.current;
    return {
      ...s,
      // The tablet shows only Windows master volume. Browser media reports
      // must never overwrite it or become a substitute when the agent leaves.
      volume: this.master?.volume ?? null,
      muted: this.master?.muted ?? null,
      positionMs: s.playing
        ? Math.min(
            s.track?.durationMs || Infinity,
            s.positionMs + (Date.now() - s.updatedAt) * s.rate,
          )
        : s.positionMs,
      updatedAt: Date.now(),
    };
  }
  setMasterVolume(state: MasterVolumeState | null): void {
    this.master = state;
  }
  connect(): void {
    this.current = {
      ...this.current,
      sourceConnected: true,
      updatedAt: Date.now(),
    };
  }
  disconnect(): void {
    this.current = {
      ...this.snapshot,
      sourceConnected: false,
      playing: false,
      updatedAt: Date.now(),
    };
  }
  clear(): void {
    this.current = {
      type: "SERVER_STATE",
      version: this.current.version + 1,
      track: null,
      positionMs: 0,
      playing: false,
      rate: 1,
      volume: null,
      muted: null,
      lyrics: null,
      sourceConnected: this.current.sourceConnected,
      updatedAt: Date.now(),
    };
  }
  update(message: SourceState): boolean {
    const changed =
      identity(message.ended ? null : message.track) !==
      identity(this.current.track);
    if (changed) this.current.version++;
    this.current = {
      type: "SERVER_STATE",
      version: this.current.version,
      track: message.ended ? null : message.track,
      positionMs: message.positionMs,
      playing: !message.ended && message.playing,
      rate: message.rate,
      volume: message.volume,
      muted: message.muted,
      lyrics: changed || message.ended ? null : this.current.lyrics,
      sourceConnected: true,
      updatedAt: Date.now(),
      seek: message.seek,
    };
    return changed;
  }
  setLyrics(version: number, lyrics: Lyrics | null): boolean {
    if (version !== this.current.version) return false;
    this.current = { ...this.current, lyrics };
    return true;
  }
}

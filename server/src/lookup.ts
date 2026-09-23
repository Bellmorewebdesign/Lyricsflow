import type { Lyrics, Track } from "../../shared/protocol.js";
import type { StateStore } from "./state.js";

/** Retry transient provider errors only while the same song is still active. */
export class TrackLyricsLookup {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly state: StateStore,
    private readonly fetchLyrics: (track: Track) => Promise<Lyrics | null>,
    private readonly publish: (track: Track, lyrics: Lyrics | null) => void,
    private readonly warn: (track: Track, error: unknown) => void,
    private readonly delays = [2000, 5000, 15000, 30000],
  ) {}
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  start(version: number, track: Track): void {
    this.stop();
    // An exact title and artist can still identify lyrics when duration is missing.
    void this.attempt(version, track, 0);
  }
  private active(version: number): boolean {
    const snapshot = this.state.snapshot;
    return (
      snapshot.sourceConnected &&
      snapshot.version === version &&
      !!snapshot.track
    );
  }
  private async attempt(
    version: number,
    track: Track,
    retry: number,
  ): Promise<void> {
    if (!this.active(version)) return;
    try {
      const lyrics = await this.fetchLyrics(track);
      if (this.active(version) && this.state.setLyrics(version, lyrics))
        this.publish(track, lyrics);
    } catch (error) {
      if (!this.active(version)) return;
      this.warn(track, error);
      const delay = this.delays[Math.min(retry, this.delays.length - 1)]!;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.attempt(version, track, retry + 1);
      }, delay);
    }
  }
}

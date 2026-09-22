import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Lyrics, Line, Track } from "../../shared/protocol.js";

export function cleanTitle(value: string): string {
  return value
    .replace(
      /\s*[\[(](?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyric(?:s)?(?:\s+video)?|remaster(?:ed)?(?:\s+\d{4})?)[^\])]*[\])]/gi,
      "",
    )
    .replace(
      /\s*[-–|]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyrics?)(?:\s+video)?\s*$/gi,
      "",
    )
    .replace(/\s*(?:\(|\[)?(?:feat\.?|ft\.?)\s+[^)\]]+(?:\)|\])?/gi, "")
    .trim();
}
export function normalize(value: string): string {
  return cleanTitle(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
export function normalizeArtist(value: string): string {
  return normalize(
    value
      .replace(/\s+(?:feat\.?|ft\.?)\s+.*$/i, "")
      .split(/\s*[,;&]\s*|\s+and\s+/i)[0] || value,
  );
}
export function parseLrc(raw: string): Line[] {
  const lines: Line[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const re = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const matches = [...row.matchAll(re)];
    const text = row.replace(re, "").trim();
    if (!text) continue;
    for (const m of matches) {
      const minutes = Number(m[1]),
        seconds = Number(m[2]);
      if (seconds >= 60) continue;
      const fraction = m[3] || "0";
      const startMs =
        (minutes * 60 + seconds) * 1000 +
        Number(fraction.padEnd(3, "0").slice(0, 3));
      lines.push({ startMs, text });
    }
  }
  return lines
    .sort((a, b) => a.startMs - b.startMs)
    .filter((l, i, arr) => i === 0 || l.startMs !== arr[i - 1]?.startMs);
}
interface Result {
  trackName: string;
  artistName: string;
  duration: number;
  syncedLyrics: string | null;
  instrumental?: boolean;
}
export function matchScore(track: Track, item: Result): number {
  if (!item.syncedLyrics || item.instrumental) return -1;
  const title = normalize(track.title),
    candidate = normalize(item.trackName);
  const artist = normalizeArtist(track.artist),
    candidateArtist = normalizeArtist(item.artistName);
  if (!title || !artist || title !== candidate || artist !== candidateArtist)
    return -1;
  // Allow modest encoding/player rounding errors, but reject alternate cuts and live versions.
  const difference =
    track.durationMs > 0
      ? Math.abs(track.durationMs / 1000 - item.duration)
      : 0;
  if (
    track.durationMs > 0 &&
    difference > Math.max(4, Math.min(8, item.duration * 0.025))
  )
    return -1;
  return 100 - difference;
}
export interface LyricsProvider {
  name: string;
  getSyncedLyrics(track: Track): Promise<Lyrics | null>;
}
export class LrclibProvider implements LyricsProvider {
  name = "LRCLIB";
  async getSyncedLyrics(track: Track): Promise<Lyrics | null> {
    if (!normalize(track.title) || !normalizeArtist(track.artist)) return null;
    const url = new URL("https://lrclib.net/api/search");
    url.searchParams.set("track_name", cleanTitle(track.title));
    url.searchParams.set(
      "artist_name",
      track.artist.replace(/\s+(?:feat\.?|ft\.?)\s+.*$/i, ""),
    );
    const response = await fetch(url, {
      signal: AbortSignal.timeout(7000),
      headers: {
        "User-Agent":
          "Lyricsflow/1.0 (personal LAN lyric display; https://github.com/Bellmorewebdesign/Lyricsflow)",
        Accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`LRCLIB HTTP ${response.status}`);
    const items: unknown = await response.json();
    if (!Array.isArray(items)) throw new Error("Invalid LRCLIB response");
    const results = items.filter(
      (v): v is Result =>
        v &&
        typeof v.trackName === "string" &&
        typeof v.artistName === "string" &&
        typeof v.duration === "number" &&
        (typeof v.syncedLyrics === "string" || v.syncedLyrics === null),
    );
    const best = results
      .map((item) => ({ item, score: matchScore(track, item) }))
      .sort((a, b) => b.score - a.score)[0];
    if (!best || best.score < 0 || !best.item.syncedLyrics) return null;
    const lines = parseLrc(best.item.syncedLyrics);
    return lines.length ? { provider: this.name, lines } : null;
  }
}
interface CacheEntry {
  expires: number;
  lyrics: Lyrics | null;
}
export class LyricsService {
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<Lyrics | null>>();
  constructor(
    private provider: LyricsProvider,
    private directory: string,
  ) {}
  async get(track: Track): Promise<Lyrics | null> {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          normalize(track.title),
          normalizeArtist(track.artist),
          Math.round(track.durationMs / 1000),
        ]),
      )
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.lyrics;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const job = this.lookup(key, track).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }
  private async lookup(key: string, track: Track): Promise<Lyrics | null> {
    const path = join(this.directory, `${key}.json`);
    try {
      const entry = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
      if (
        entry.expires > Date.now() &&
        (entry.lyrics === null ||
          (entry.lyrics?.provider === this.provider.name &&
            Array.isArray(entry.lyrics.lines)))
      ) {
        this.cache.set(key, entry);
        return entry.lyrics;
      }
    } catch {
      /* absent or damaged cache */
    }
    // Provider failures are not cached as missing lyrics.
    const lyrics = await this.provider.getSyncedLyrics(track);
    const entry = {
      lyrics,
      expires: Date.now() + (lyrics ? 30 * 86400_000 : 6 * 3600_000),
    };
    this.cache.set(key, entry);
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(entry));
      await rename(`${path}.tmp`, path);
    } catch (error) {
      console.warn("Lyrics cache write failed:", error);
    }
    return lyrics;
  }
}

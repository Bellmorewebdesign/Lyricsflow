import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Lyrics, Line, Track } from "../../shared/protocol.js";

export function cleanTitle(value: string): string {
  return value
    .replace(/\s*[\[(]\d{4}\s+remaster(?:ed)?[\])]/gi, "")
    .replace(
      /\s*[\[(](?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyric(?:s)?(?:\s+video)?|remaster(?:ed)?(?:\s+\d{4})?|explicit|clean)[^\])]*[\])]/gi,
      "",
    )
    .replace(
      /\s*[-–|]\s*(?:official\s+)?(?:music\s+)?(?:video|audio|visualizer|lyrics?)(?:\s+video)?\s*$/gi,
      "",
    )
    .replace(
      /\s*(?:\(|\[)?(?:feat\.?|ft\.?|featuring)\s+[^)\]]+(?:\)|\])?/gi,
      "",
    )
    .replace(/\s*🅴\s*$/u, "")
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
  // A comma or ampersand may be part of a real stage name, so preserve it.
  return normalize(
    value
      .split(/[•·]/)[0]!
      .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, ""),
  );
}
function primaryArtist(value: string): string {
  // A comma can credit collaborators, except for established "Name, The ..." names.
  const withoutFeature = value.replace(
    /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i,
    "",
  );
  return normalizeArtist(
    /,\s+the\b/i.test(withoutFeature)
      ? withoutFeature
      : withoutFeature.split(/,\s+/)[0]!,
  );
}
export function parseLrc(raw: string): Line[] {
  const lines: Line[] = [];
  const offsetTag = raw.match(/^\s*\[offset:\s*([+-]?\d{1,5})\s*\]/im);
  const offsetMs = offsetTag ? Number(offsetTag[1]) : 0;
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
      // LRC's positive offset advances the lyrics. Ignoring this tag can
      // shift every line of an otherwise correct match by several seconds.
      lines.push({ startMs: Math.max(0, startMs - offsetMs), text });
    }
  }
  return lines
    .sort((a, b) => a.startMs - b.startMs)
    .filter((l, i, arr) => i === 0 || l.startMs !== arr[i - 1]?.startMs);
}
export interface Result {
  trackName: string;
  artistName: string;
  albumName?: string;
  duration: number;
  syncedLyrics: string | null;
  instrumental?: boolean;
}
export function assessMatch(
  track: Track,
  item: Result,
): { score: number; reason: string } {
  if (!item.syncedLyrics || item.instrumental)
    return { score: -1, reason: "no syncedLyrics" };
  const title = normalize(track.title),
    candidate = normalize(item.trackName);
  if (!title || title !== candidate)
    return { score: -1, reason: "title mismatch" };
  const artist = normalizeArtist(track.artist),
    candidateArtist = normalizeArtist(item.artistName);
  const primary = primaryArtist(track.artist),
    candidatePrimary = primaryArtist(item.artistName);
  const fullArtistMatch = !!artist && artist === candidateArtist;
  const safePrimaryMatch =
    !!primary &&
    primary.length >= 4 &&
    primary === candidatePrimary &&
    (artist === primary || candidateArtist === candidatePrimary);
  if (!fullArtistMatch && !safePrimaryMatch)
    return { score: -1, reason: "artist mismatch" };
  if (!track.durationMs && !fullArtistMatch)
    return { score: -1, reason: "unknown duration requires full artist" };
  // The correct recording should agree within a few seconds. A 5-second
  // alternate edit can have otherwise identical title and artist metadata.
  const difference =
    track.durationMs > 0
      ? Math.abs(track.durationMs / 1000 - item.duration)
      : 0;
  if (track.durationMs > 0 && difference > 3)
    return { score: -1, reason: "duration mismatch" };
  return {
    score: (fullArtistMatch ? 110 : 100) - difference,
    reason: "accepted",
  };
}
export function matchScore(track: Track, item: Result): number {
  return assessMatch(track, item).score;
}
export interface LyricsProvider {
  name: string;
  getSyncedLyrics(track: Track): Promise<Lyrics | null>;
}
export class LrclibProvider implements LyricsProvider {
  name = "LRCLIB";
  constructor(private readonly debug = process.env.DEBUG_LYRICS === "true") {}
  async getSyncedLyrics(track: Track): Promise<Lyrics | null> {
    if (!normalize(track.title) || !normalizeArtist(track.artist)) return null;
    const queryTitle = cleanTitle(track.title);
    const queryArtist = track.artist
      .split(/[•·]/)[0]!
      .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, "")
      .trim();
    if (this.debug)
      console.info(
        `LRCLIB query: ${JSON.stringify(queryTitle)} — ${JSON.stringify(queryArtist)} [${(track.durationMs / 1000).toFixed(1)}s]`,
      );
    const candidates: Result[] = [];
    let searchError: unknown = null;
    // LRCLIB search is capped at 20 records. Try the specific get endpoint
    // with album and duration first, then a focused keyword search.
    if (track.durationMs > 0) {
      const exactQuery = {
        track_name: queryTitle,
        artist_name: queryArtist,
        duration: String(Math.round(track.durationMs / 1000)),
      };
      for (const params of track.album
        ? [{ ...exactQuery, album_name: track.album }, exactQuery]
        : [exactQuery]) {
        try {
          const exact = await this.getExact(params);
          if (exact) {
            const result = this.select(track, [exact]);
            if (result) return result;
          }
        } catch (error) {
          searchError = error;
          if (this.debug)
            console.info(
              "LRCLIB exact lookup failed:",
              error instanceof Error ? error.message : error,
            );
        }
      }
    }
    const searches: {
      track_name?: string;
      artist_name?: string;
      q?: string;
    }[] = [
      { track_name: queryTitle, artist_name: queryArtist },
      { q: `${queryTitle} ${queryArtist}` },
      { track_name: queryTitle },
    ];
    const normalizedQuery = `${normalize(queryTitle)} ${normalizeArtist(track.artist)}`;
    if (normalize(queryTitle) !== queryTitle.toLowerCase())
      searches.push({ q: normalizedQuery });
    for (const params of searches) {
      let results: Result[];
      try {
        results = await this.search(params);
      } catch (error) {
        searchError = error;
        if (this.debug)
          console.info(
            "LRCLIB search failed:",
            params,
            error instanceof Error ? error.message : error,
          );
        continue;
      }
      const ranked = results
        .map((item) => ({ item, ...assessMatch(track, item) }))
        .sort((a, b) => b.score - a.score);
      if (this.debug) {
        console.info(
          `LRCLIB results: ${results.length} for ${JSON.stringify(params)}`,
        );
        for (const candidate of ranked.slice(0, 5))
          console.info(
            `LRCLIB candidate: ${JSON.stringify(candidate.item.trackName)} — ${JSON.stringify(candidate.item.artistName)} [${candidate.item.duration.toFixed(1)}s]: ${candidate.reason}`,
          );
      }
      candidates.push(...results);
      // With a confirmed length, local title/artist/duration scoring is safe.
      if (track.durationMs > 0) {
        const matched = this.select(track, results);
        if (matched) return matched;
      }
    }
    // An incomplete set of searches must not be cached as a definitive miss.
    if (!track.durationMs && searchError) throw searchError;
    const matched = this.select(track, candidates);
    if (!matched && searchError) throw searchError;
    return matched;
  }
  private select(track: Track, items: Result[]): Lyrics | null {
    let ranked = items
      .map((item) => ({ item, ...assessMatch(track, item) }))
      .filter(
        (candidate) =>
          candidate.score >= 0 &&
          parseLrc(candidate.item.syncedLyrics || "").length,
      )
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;
    if (!track.durationMs) {
      const album = normalize(track.album || "");
      const sameAlbum = album
        ? ranked.filter(
            (candidate) => normalize(candidate.item.albumName || "") === album,
          )
        : [];
      if (sameAlbum.length) ranked = sameAlbum;
      // Without a trusted duration, distinct recordings are ambiguous.
      if (
        ranked.some(
          (candidate) =>
            Math.abs(candidate.item.duration - ranked[0]!.item.duration) > 4,
        )
      ) {
        if (this.debug)
          console.info("LRCLIB candidates rejected: ambiguous durations");
        return null;
      }
    }
    if (this.debug)
      console.info(
        `LRCLIB selected: ${JSON.stringify(ranked[0]!.item.trackName)} — ${JSON.stringify(ranked[0]!.item.artistName)} [${ranked[0]!.item.duration.toFixed(1)}s], offset=${ranked[0]!.item.syncedLyrics?.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/im)?.[1] || 0}ms`,
      );
    return {
      provider: this.name,
      lines: parseLrc(ranked[0]!.item.syncedLyrics!),
    };
  }
  private async getExact(params: {
    track_name: string;
    artist_name: string;
    album_name?: string;
    duration: string;
  }): Promise<Result | null> {
    const url = new URL("https://lrclib.net/api/get");
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    const response = await this.request(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`LRCLIB HTTP ${response.status}`);
    const item: unknown = await response.json();
    return isResult(item) ? item : null;
  }
  private async search(params: {
    track_name?: string;
    artist_name?: string;
    q?: string;
  }): Promise<Result[]> {
    const url = new URL("https://lrclib.net/api/search");
    for (const [key, value] of Object.entries(params))
      if (value) url.searchParams.set(key, value);
    const response = await this.request(url);
    if (!response.ok) throw new Error(`LRCLIB HTTP ${response.status}`);
    const items: unknown = await response.json();
    if (!Array.isArray(items)) throw new Error("Invalid LRCLIB response");
    return items.filter(isResult);
  }
  private request(url: URL): Promise<Response> {
    return fetch(url, {
      signal: AbortSignal.timeout(7000),
      headers: {
        "User-Agent":
          "Lyricsflow/1.0 (personal LAN lyric display; https://github.com/Bellmorewebdesign/Lyricsflow)",
        Accept: "application/json",
      },
    });
  }
}
function isResult(v: unknown): v is Result {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Result).trackName === "string" &&
    typeof (v as Result).artistName === "string" &&
    typeof (v as Result).duration === "number" &&
    Number.isFinite((v as Result).duration) &&
    (v as Result).duration > 0 &&
    (typeof (v as Result).syncedLyrics === "string" ||
      (v as Result).syncedLyrics === null)
  );
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
      .update("lyrics-match-v5\0")
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

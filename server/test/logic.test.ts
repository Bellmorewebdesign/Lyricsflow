import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanTitle,
  normalize,
  normalizeArtist,
  parseLrc,
  matchScore,
  assessMatch,
  LrclibProvider,
} from "../src/lyrics.js";
import {
  parsePlayerMetadata,
  PlayerDurationTracker,
  PlayerPositionTracker,
  readPlayerDuration,
  readPlayerPosition,
  readTrack,
} from "../../extension/src/metadata.js";
import { ReportGate } from "../../extension/src/report-gate.js";
import { setYouTubePlayerVolume } from "../../extension/src/player-volume.js";
import { CommandQueue } from "../../extension/src/command-queue.js";
import {
  chooseMedia,
  MediaVolumeTracker,
  observeVolume,
  readMediaVolume,
  setMediaVolume,
} from "../../extension/src/volume.js";
import { StateStore } from "../src/state.js";
import { TrackLyricsLookup } from "../src/lookup.js";
import { parseIncoming } from "../../shared/protocol.js";
import {
  displayState,
  effectivePosition,
  lineIndex,
} from "../../display/src/model.js";
import { ArtworkView, showTrackMetadata } from "../../display/src/artwork.js";
import { VolumeSlider, VolumeThrottle } from "../../display/src/volume.js";
const track = {
  title: "Song (Official Video)",
  artist: "The Band feat. Guest",
  durationMs: 201000,
};
test("title and artist cleanup", () => {
  assert.equal(cleanTitle("Song [Official Music Video]"), "Song");
  assert.equal(normalize("Sóng (Remastered 2012)"), "song");
  assert.equal(normalizeArtist(track.artist), "the band");
  assert.equal(cleanTitle("Song (2012 Remaster)"), "Song");
  assert.equal(normalize("Monëy so big"), normalize("Money so big"));
  assert.equal(normalizeArtist("Tyler, The Creator"), "tyler the creator");
  assert.equal(
    cleanTitle("Monëy so big [Explicit] (Official Audio)"),
    "Monëy so big",
  );
});
test("YouTube Music byline keeps album and year out of artist", () => {
  const metadata = parsePlayerMetadata(
    " Monëy so big ",
    "Yeat • Up 2 Më • 2021",
    [
      { text: "Yeat", href: "/channel/UCArtist" },
      { text: "Up 2 Më", href: "/browse/MPREalbum" },
    ],
  );
  assert.deepEqual(metadata, {
    title: "Monëy so big",
    artist: "Yeat",
    album: "Up 2 Më",
  });
  assert.deepEqual(
    parsePlayerMetadata("Plot Twist", "Yeat · Up 2 Më · 2021", []),
    { title: "Plot Twist", artist: "Yeat", album: "Up 2 Më" },
  );
  assert.deepEqual(
    parsePlayerMetadata("Song", "Artist A • Artist B • Album • 2023", [
      { text: "Artist A", href: "/channel/UC1" },
      { text: "Artist B", href: "/channel/UC2" },
      { text: "Album", href: "/browse/MPRE3" },
    ]),
    { title: "Song", artist: "Artist A, Artist B", album: "Album" },
  );
  assert.deepEqual(
    parsePlayerMetadata(
      "Song",
      "Earth, Wind & Fire • Greatest Hits • 2000",
      [],
    ),
    { title: "Song", artist: "Earth, Wind & Fire", album: "Greatest Hits" },
  );
});
test("incomplete metadata during a player transition never clears a valid track", () => {
  const gate = new ReportGate(8000);
  const songA = { title: "Song A", artist: "Yeat", durationMs: 120000 };
  const songB = { title: "Song B", artist: "Yeat", durationMs: 130000 };
  const valid = (song: typeof songA) => ({
    track: song,
    positionMs: 0,
    playing: true,
    rate: 1,
    volume: 0.37,
    muted: false,
    clearEvidence: false,
    seek: false,
  });
  const invalid = {
    track: null,
    positionMs: 0,
    playing: false,
    rate: 1,
    volume: 0.37,
    muted: false,
    clearEvidence: true,
    seek: true,
  };
  assert.equal(gate.accept(valid(songA), 0)?.track?.title, "Song A");
  assert.equal(gate.accept(invalid, 100), null);
  assert.equal(gate.accept(invalid, 5000), null);
  assert.equal(gate.accept(valid(songB), 6000), null);
  assert.equal(gate.needsRecheck, true);
  assert.equal(gate.accept(valid(songB), 6800)?.track?.title, "Song B");
  assert.equal(gate.accept(invalid, 7000), null);
  assert.equal(gate.accept(invalid, 15000)?.track, null);
});
test("streaming media duration cannot turn one song into repeated track changes", () => {
  const clock = { textContent: "1:07 / 3:07" };
  const bar = {
    querySelector(selector: string) {
      if (selector === ".time-info") return clock;
      if (selector === ".title")
        return { textContent: "Back to the Old House" };
      if (selector === ".byline")
        return { textContent: "The Smiths", querySelectorAll: () => [] };
      return null;
    },
  } as unknown as Element;
  const durations = new PlayerDurationTracker();
  const store = new StateStore();
  store.connect();
  assert.equal(readPlayerDuration(bar), 187);
  clock.textContent = "1:07 / 3:07  • time remaining";
  assert.equal(readPlayerDuration(bar), 187);
  for (let i = 0; i < 30; i++) {
    const now = i * 250;
    const mediaDuration = 187 + now / 1000; // the reported production drift
    const stable = durations.resolve("smiths-song", bar, mediaDuration, now);
    const read = readTrack(bar, stable);
    assert.ok(read);
    store.update({
      type: "SOURCE_STATE",
      track: read,
      positionMs: now,
      playing: true,
      ended: false,
      rate: 1,
      volume: 0.31,
      muted: false,
    });
  }
  assert.equal(store.snapshot.track?.durationMs, 187000);
  assert.equal(store.snapshot.version, 2); // initial metadata, then confirmed duration
  clock.textContent = "1:08 / 3:07";
  assert.equal(durations.resolve("smiths-song", bar, 300.8, 8000), 187);
  assert.equal(durations.resolve("smiths-song", null, 301.5, 8800), 187);
});
test("percentage progress bars cannot invent a 100 second song", () => {
  const bar = {
    querySelector(selector: string) {
      if (selector === ".time-info") return { textContent: "loading" };
      if (selector === "#progress-bar[aria-valuemax]")
        return { getAttribute: () => "100" };
      return null;
    },
  } as unknown as Element;
  assert.equal(readPlayerDuration(bar), 0);
  const withRealSlider = {
    querySelector(selector: string) {
      if (selector === ".time-info") return { textContent: "loading" };
      if (selector === "#progress-bar #sliderBar[aria-valuemax]")
        return { getAttribute: () => "187" };
      if (selector === "#progress-bar[aria-valuemax]")
        return { getAttribute: () => "100" };
      return null;
    },
  } as unknown as Element;
  assert.equal(readPlayerDuration(withRealSlider), 187);
});
test("lyrics follow the YouTube Music clock when media currentTime drifts", () => {
  const clock = { textContent: "1:07 / 3:07" };
  const bar = {
    querySelector(selector: string) {
      return selector === ".time-info" ? clock : null;
    },
  } as unknown as Element;
  const tracker = new PlayerPositionTracker();
  assert.equal(readPlayerPosition(bar), 67000);
  assert.equal(tracker.resolve(bar, 72000, true, 1000), 67000);
  clock.textContent = "1:08 / 3:07";
  assert.equal(tracker.resolve(bar, 73000, true, 2000), 68000);
  assert.equal(tracker.resolve(bar, 68050, true, 2200), 68050);
  clock.textContent = "0:00 / 3:07";
  assert.equal(readPlayerPosition(bar), 0);
  // A seek must use the new media time if the visible clock has not caught up.
  assert.equal(tracker.resolve(bar, 101000, true, 2300, true), 101000);
  assert.equal(tracker.resolve(bar, 102000, true, 5100), 102000);
  clock.textContent = "live";
  assert.equal(tracker.resolve(bar, 104000, true, 5200), 104000);
});
test("incoming song uses its restarted media clock while the player bar still shows the old song", () => {
  const clock = { textContent: "2:37 / 3:07" };
  const bar = {
    querySelector(selector: string) {
      return selector === ".time-info" ? clock : null;
    },
  } as unknown as Element;
  const tracker = new PlayerPositionTracker();
  assert.equal(tracker.resolve(bar, 157000, true, 1000), 157000);
  tracker.beginTransition(1200);
  assert.equal(tracker.resolve(bar, 800, true, 1800), 800);
  assert.equal(tracker.resolve(bar, 1200, true, 2200), 1200);
  clock.textContent = "0:03 / 3:22";
  assert.equal(tracker.resolve(bar, 3100, true, 2800), 3100);
});
test("LRCLIB exact album and duration lookup finds a song beyond search limits", async () => {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    return {
      ok: true,
      json: async () => ({
        trackName: "Back to the Old House",
        artistName: "The Smiths",
        albumName: "Hatful of Hollow",
        duration: 187,
        syncedLyrics: "[00:01.00]found",
      }),
    } as Response;
  };
  try {
    const lyrics = await new LrclibProvider(false).getSyncedLyrics({
      title: "Back to the Old House",
      artist: "The Smiths",
      album: "Hatful of Hollow",
      durationMs: 187000,
    });
    assert.equal(lyrics?.lines[0]?.text, "found");
    assert.equal(urls.length, 1);
    assert.equal(urls[0]?.pathname, "/api/get");
    assert.equal(urls[0]?.searchParams.get("album_name"), "Hatful of Hollow");
    assert.equal(urls[0]?.searchParams.get("duration"), "187");
  } finally {
    globalThis.fetch = original;
  }
});
test("LRCLIB retries exact duration without album when YouTube album differs", async () => {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.searchParams.has("album_name"))
      return { ok: false, status: 404 } as Response;
    if (url.pathname.endsWith("/search"))
      return { ok: true, json: async () => [] } as Response;
    return {
      ok: true,
      json: async () => ({
        trackName: "Back to the Old House",
        artistName: "The Smiths",
        albumName: "Another Album",
        duration: 187,
        syncedLyrics: "[00:01.00]found",
      }),
    } as Response;
  };
  try {
    const lyrics = await new LrclibProvider(false).getSyncedLyrics({
      title: "Back to the Old House",
      artist: "The Smiths",
      album: "YouTube Compilation",
      durationMs: 187000,
    });
    assert.equal(lyrics?.lines[0]?.text, "found");
    assert.ok(urls.length >= 3);
    assert.equal(urls[1]?.searchParams.has("album_name"), false);
  } finally {
    globalThis.fetch = original;
  }
});
test("matching album recording beats a same-title alternate release", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/get") && url.searchParams.has("album_name"))
      return { ok: false, status: 404 } as Response;
    const record = url.pathname.endsWith("/get")
      ? {
          trackName: "Song",
          artistName: "Artist",
          albumName: "Extended Edition",
          duration: 200,
          syncedLyrics: "[00:03.00]wrong",
        }
      : [
          {
            trackName: "Song",
            artistName: "Artist",
            albumName: "Original Album",
            duration: 200,
            syncedLyrics: "[00:03.00]right",
          },
        ];
    return { ok: true, json: async () => record } as Response;
  };
  try {
    const lyrics = await new LrclibProvider(false).getSyncedLyrics({
      title: "Song",
      artist: "Artist",
      album: "Original Album",
      durationMs: 200000,
    });
    assert.equal(lyrics?.lines[0]?.text, "right");
    assert.equal(
      assessMatch(
        { title: "Song", artist: "Artist", durationMs: 200000 },
        {
          trackName: "Song",
          artistName: "Artist",
          duration: 200,
          syncedLyrics: "[03:23.00]impossible",
        },
      ).reason,
      "lyrics run past track end",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("unknown duration uses exact artist and rejects conflicting recordings", async () => {
  const original = globalThis.fetch;
  const records = [
    {
      trackName: "Popular Song",
      artistName: "The Band",
      albumName: "Album",
      duration: 180,
      syncedLyrics: "[00:01.00]correct",
    },
    {
      trackName: "Popular Song",
      artistName: "The Band",
      albumName: "Live",
      duration: 230,
      syncedLyrics: "[00:01.00]other version",
    },
    {
      trackName: "Popular Song",
      artistName: "Other Band",
      albumName: "Album",
      duration: 180,
      syncedLyrics: "[00:01.00]wrong artist",
    },
  ];
  globalThis.fetch = async () =>
    ({ ok: true, json: async () => records }) as Response;
  try {
    const provider = new LrclibProvider(false);
    const input = { title: "Popular Song", artist: "The Band", durationMs: 0 };
    assert.equal(await provider.getSyncedLyrics(input), null);
    const matched = await provider.getSyncedLyrics({
      ...input,
      album: "Album",
    });
    assert.equal(matched?.lines[0]?.text, "correct");
  } finally {
    globalThis.fetch = original;
  }
});
test("a wrong transitional duration is held until the final candidate settles", () => {
  const gate = new ReportGate(8000, 700);
  const read = (title: string, durationMs: number) => ({
    track: { title, artist: "The Smiths", durationMs },
    positionMs: 0,
    playing: true,
    rate: 1,
    volume: 0.31,
    muted: false,
    clearEvidence: false,
    seek: false,
  });
  gate.accept(read("Song A", 187000), 0);
  assert.equal(gate.accept(read("Song B", 187000), 100), null);
  assert.equal(gate.accept(read("Song B", 205000), 400), null);
  assert.equal(
    gate.accept(read("Song B", 205000), 1150)?.track?.durationMs,
    205000,
  );
});
test("autoplay waits for the new media clock and does not attach a new URL to old lyrics", () => {
  const gate = new ReportGate(8000, 700);
  const store = new StateStore();
  store.connect();
  const read = (title: string, videoId: string, positionMs: number) => ({
    track: { title, artist: "The Smiths", videoId, durationMs: 187000 },
    positionMs,
    playing: true,
    rate: 1,
    volume: 0.5,
    muted: false,
    clearEvidence: false,
    seek: false,
  });
  store.update(gate.accept(read("Song A", "a", 180000), 0)!);
  store.setLyrics(store.snapshot.version, {
    provider: "test",
    lines: [{ startMs: 180000, text: "end of A" }],
  });
  // YouTube changes the URL first, then title, then the media clock.
  assert.equal(gate.accept(read("Song A", "b", 181000), 200), null);
  assert.equal(gate.accept(read("Song B", "b", 182000), 500), null);
  assert.equal(gate.accept(read("Song B", "b", 184000), 1400), null);
  assert.equal(store.snapshot.lyrics?.lines[0]?.text, "end of A");
  const next = read("Song B", "b", 0);
  next.positionMs = 67000; // stale player bar when the new media starts
  const switched = gate.accept({ ...next, mediaPositionMs: 1200 }, 1650)!;
  assert.equal(switched.track?.title, "Song B");
  assert.equal(switched.positionMs, 1200);
  assert.equal(switched.seek, true);
  assert.equal(store.update(switched), true);
  assert.equal(store.snapshot.lyrics, null);
  assert.equal(store.snapshot.version, 2);
});
test("a URL-only change waits for metadata but a settled repeat can still start", () => {
  const gate = new ReportGate(8000, 700);
  const read = (videoId: string, positionMs: number) => ({
    track: {
      title: "Song A",
      artist: "The Smiths",
      videoId,
      durationMs: 187000,
    },
    positionMs,
    playing: true,
    rate: 1,
    volume: 0.5,
    muted: false,
    clearEvidence: false,
    seek: false,
  });
  gate.accept(read("first", 180000), 0);
  assert.equal(gate.accept(read("second", 1000), 100), null);
  assert.equal(gate.accept(read("second", 2000), 900), null);
  assert.equal(
    gate.accept(read("second", 3500), 2700)?.track?.videoId,
    "second",
  );
});
test("repeated duration drift never clears lyrics for the same recording", () => {
  const gate = new ReportGate(8000, 700);
  const store = new StateStore();
  store.connect();
  for (const [index, durationMs] of [
    187000, 191000, 195100, 260800, 300800,
  ].entries()) {
    const reported = gate.accept(
      {
        track: {
          title: "Back to the Old House",
          artist: "The Smiths",
          videoId: "song-video",
          durationMs,
        },
        positionMs: index * 4000,
        playing: true,
        rate: 1,
        volume: 0.31,
        muted: false,
        clearEvidence: false,
        seek: false,
      },
      index * 4000,
    );
    assert.ok(reported);
    store.update(reported);
    if (index === 0)
      store.setLyrics(store.snapshot.version, {
        provider: "test",
        lines: [{ startMs: 0, text: "still here" }],
      });
  }
  assert.equal(store.snapshot.version, 1);
  assert.equal(store.snapshot.lyrics?.lines[0]?.text, "still here");
  assert.equal(store.snapshot.track?.durationMs, 187000);
  // Atlas also protects lyrics if an old extension still reports a drifting length.
  store.update({
    type: "SOURCE_STATE",
    track: {
      title: "Back to the Old House",
      artist: "The Smiths",
      videoId: "song-video",
      durationMs: 305000,
    },
    positionMs: 40000,
    playing: true,
    ended: false,
    rate: 1,
    volume: 0.31,
    muted: false,
  });
  assert.equal(store.snapshot.version, 1);
  assert.equal(store.snapshot.lyrics?.lines[0]?.text, "still here");
});
test("duration loss does not make an otherwise valid player bar a clear signal", () => {
  const gate = new ReportGate(8000);
  gate.accept(
    {
      track,
      positionMs: 1000,
      playing: true,
      rate: 1,
      volume: 0.37,
      muted: false,
      clearEvidence: false,
      seek: false,
    },
    0,
  );
  assert.equal(
    gate.accept(
      {
        track: null,
        positionMs: 0,
        playing: false,
        rate: 1,
        volume: 0.37,
        muted: false,
        clearEvidence: false,
        seek: true,
      },
      20000,
    ),
    null,
  );
});
test("LRC multiple timestamps, fractions, duplicates and malformed lines", () => {
  assert.deepEqual(
    parseLrc(
      "[00:02.5][00:05.050] Hello\n[00:03.12] World\n[xx:03] ignored\n[00:02.50] Dup",
    ),
    [
      { startMs: 2500, text: "Hello" },
      { startMs: 3120, text: "World" },
      { startMs: 5050, text: "Hello" },
    ],
  );
});
test("LRC global offsets align lyrics without modifying the playback clock", () => {
  assert.deepEqual(parseLrc("[offset:+5000]\n[00:12.00] On time"), [
    { startMs: 7000, text: "On time" },
  ]);
  assert.deepEqual(parseLrc("[offset:-5000]\n[00:12.00] Later"), [
    { startMs: 17000, text: "Later" },
  ]);
});
test("matches cleaned title, primary artist and close duration only", () => {
  const candidate = {
    trackName: "Song",
    artistName: "The Band",
    duration: 200,
    syncedLyrics: "[00:01.00]hi",
  };
  assert.ok(matchScore(track, candidate) > 0);
  assert.equal(matchScore(track, { ...candidate, duration: 230 }), -1);
  assert.equal(
    matchScore(track, { ...candidate, trackName: "Other Song" }),
    -1,
  );
  assert.equal(
    matchScore(track, { ...candidate, artistName: "Other Band" }),
    -1,
  );
});
test("LRCLIB scoring accepts safe metadata variants and rejects false versions", () => {
  const input = {
    title: "Monëy so big (Official Video)",
    artist: "Yeat feat. Guest",
    durationMs: 150000,
  };
  const record = {
    trackName: "Money so big",
    artistName: "Yeat",
    duration: 150,
    syncedLyrics: "[00:01.00]hi",
  };
  assert.ok(matchScore(input, record) > 0);
  assert.ok(matchScore({ ...input, artist: "Yeat, Guest" }, record) > 0);
  assert.equal(
    assessMatch(input, { ...record, duration: 180 }).reason,
    "duration mismatch",
  );
  assert.equal(
    assessMatch(input, { ...record, duration: 155 }).reason,
    "duration mismatch",
  );
  assert.equal(
    assessMatch(input, { ...record, trackName: "Money so big live" }).reason,
    "title mismatch",
  );
  assert.equal(
    assessMatch(input, { ...record, artistName: "Another Artist" }).reason,
    "artist mismatch",
  );
  assert.equal(
    assessMatch(input, { ...record, syncedLyrics: null }).reason,
    "no syncedLyrics",
  );
  assert.equal(
    matchScore(
      { ...input, artist: "Tyler, The Creator" },
      { ...record, artistName: "Tyler" },
    ),
    -1,
  );
});
test("LRCLIB retries title-only search but still scores candidates locally", async () => {
  const original = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("/get"))
      return { ok: false, status: 404 } as Response;
    const records =
      url.searchParams.has("artist_name") || url.searchParams.has("q")
        ? []
        : [
            {
              trackName: "Money so big",
              artistName: "Wrong Artist",
              duration: 150,
              syncedLyrics: "[00:01.00]wrong",
            },
            {
              trackName: "Money so big",
              artistName: "Yeat",
              duration: 150,
              syncedLyrics: "[00:01.00]right",
            },
          ];
    return { ok: true, json: async () => records } as Response;
  };
  try {
    const lyrics = await new LrclibProvider(false).getSyncedLyrics({
      title: "Monëy so big",
      artist: "Yeat",
      durationMs: 150000,
    });
    assert.equal(lyrics?.lines[0]?.text, "right");
    assert.equal(urls[0]?.pathname, "/api/get");
    assert.equal(urls[0]?.searchParams.get("artist_name"), "Yeat");
    assert.equal(urls[1]?.searchParams.get("artist_name"), "Yeat");
    assert.equal(urls[2]?.searchParams.get("q"), "Monëy so big Yeat");
    assert.equal(urls[3]?.searchParams.get("artist_name"), null);
  } finally {
    globalThis.fetch = original;
  }
});
test("failed LRCLIB searches do not masquerade as a cacheable no-match", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary network error");
    return { ok: true, json: async () => [] } as Response;
  };
  try {
    await assert.rejects(
      new LrclibProvider(false).getSyncedLyrics(track),
      /temporary network error/,
    );
    assert.ok(attempts >= 2); // another query is tried before scheduling a retry
  } finally {
    globalThis.fetch = original;
  }
});
test("Atlas retries transient lyric errors and never applies an obsolete response", async () => {
  const store = new StateStore();
  store.connect();
  store.update({
    type: "SOURCE_STATE",
    track,
    positionMs: 0,
    playing: true,
    ended: false,
    rate: 1,
    volume: 0.31,
    muted: false,
  });
  let attempts = 0;
  let warnings = 0;
  let published = 0;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const lookup = new TrackLyricsLookup(
    store,
    async () => {
      if (++attempts === 1) throw new Error("timeout");
      return { provider: "test", lines: [{ startMs: 1000, text: "line" }] };
    },
    () => {
      published++;
      done();
    },
    () => {
      warnings++;
    },
    [1],
  );
  lookup.start(store.snapshot.version, track);
  await finished;
  lookup.stop();
  assert.equal(attempts, 2);
  assert.equal(warnings, 1);
  assert.equal(published, 1);
  assert.equal(store.snapshot.lyrics?.lines[0]?.text, "line");
  const noDuration = { ...track, durationMs: 0 };
  store.update({
    type: "SOURCE_STATE",
    track: noDuration,
    positionMs: 0,
    playing: true,
    ended: false,
    rate: 1,
    volume: 0.31,
    muted: false,
  });
  lookup.start(store.snapshot.version, noDuration);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.snapshot.track?.title, track.title);
  assert.equal(attempts, 3);
  assert.equal(store.snapshot.lyrics?.lines[0]?.text, "line");
  lookup.stop();
});
test("explicit Galaxy volume also updates YouTube Music's player setting", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const saved: number[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: () => ({
        setVolume: (value: number) => saved.push(value),
      }),
    },
  });
  try {
    assert.equal(setYouTubePlayerVolume(0.5), true);
    assert.equal(setYouTubePlayerVolume(1), true); // deliberate maximum is permitted
    assert.equal(setYouTubePlayerVolume(-1), false);
    assert.equal(setYouTubePlayerVolume(NaN), false);
    assert.deepEqual(saved, [50, 100]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
test("slow player injection cannot overwrite a later final slider value", async () => {
  const queue = new CommandQueue();
  const applied: number[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(async () => {
    await blocked;
    applied.push(1);
  });
  const last = queue.run(async () => {
    applied.push(0.5);
  });
  assert.deepEqual(applied, []);
  release();
  await Promise.all([first, last]);
  assert.deepEqual(applied, [1, 0.5]);
});
test("new preload element inherits known lower volume before playback", () => {
  const tracker = new MediaVolumeTracker();
  tracker.observe({ volume: 0.5, muted: false } as HTMLMediaElement);
  const next = { volume: 1, muted: false } as HTMLMediaElement;
  assert.equal(tracker.prepare(next), true);
  assert.equal(next.volume, 0.5);
  assert.equal(tracker.known?.volume, 0.5);
  const desktopUserVolume = { volume: 0.3, muted: false } as HTMLMediaElement;
  assert.equal(tracker.prepare(desktopUserVolume), false);
  assert.equal(desktopUserVolume.volume, 0.3);
});
test("message validation rejects malformed and unknown commands", () => {
  assert.equal(parseIncoming("{"), null);
  assert.equal(
    parseIncoming(
      JSON.stringify({ type: "CONTROL_COMMAND", command: "SHELL", id: "x" }),
    ),
    null,
  );
  assert.equal(
    parseIncoming(
      JSON.stringify({ type: "HELLO", role: "display", protocol: 3 }),
    )?.type,
    "HELLO",
  );
  assert.equal(
    parseIncoming(
      JSON.stringify({ type: "HELLO", role: "display", protocol: 2 }),
    ),
    null,
  );
  assert.deepEqual(
    parseIncoming(
      JSON.stringify({
        type: "HELLO",
        role: "source",
        protocol: 3,
        build: "1.0.5",
      }),
    ),
    { type: "HELLO", role: "source", protocol: 3, build: "1.0.5" },
  );
  assert.equal(
    parseIncoming(
      JSON.stringify({ type: "HELLO", role: "volume", protocol: 3 }),
    )?.type,
    "HELLO",
  );
});
test("volume protocol accepts only finite unit values and short nonempty ids", () => {
  assert.deepEqual(
    parseIncoming(
      JSON.stringify({
        type: "MASTER_VOLUME_STATE",
        volume: 0.92,
        muted: false,
      }),
    ),
    { type: "MASTER_VOLUME_STATE", volume: 0.92, muted: false },
  );
  for (const volume of [-1, 1.01, "0.5", null])
    assert.equal(
      parseIncoming(
        JSON.stringify({ type: "MASTER_VOLUME_STATE", volume, muted: false }),
      ),
      null,
    );
  for (const volume of [-0.01, 1.01, null, "0.5", Infinity, NaN])
    assert.equal(
      parseIncoming(JSON.stringify({ type: "SET_VOLUME", volume, id: "v" })),
      null,
    );
  assert.equal(
    parseIncoming(JSON.stringify({ type: "SET_VOLUME", volume: 0.37, id: "" })),
    null,
  );
  assert.equal(
    parseIncoming(
      JSON.stringify({ type: "SET_VOLUME", volume: 0.37, id: "a".repeat(81) }),
    ),
    null,
  );
  assert.deepEqual(
    parseIncoming(
      JSON.stringify({ type: "SET_VOLUME", volume: 0.37, id: "v" }),
    ),
    { type: "SET_VOLUME", volume: 0.37, id: "v" },
  );
  for (const volume of [-1, 2])
    assert.equal(
      parseIncoming(
        JSON.stringify({
          type: "SOURCE_STATE",
          track: null,
          positionMs: 0,
          playing: false,
          ended: true,
          rate: 1,
          volume,
          muted: false,
        }),
      ),
      null,
    );
  assert.equal(
    parseIncoming(
      JSON.stringify({
        type: "SOURCE_STATE",
        track: null,
        positionMs: 0,
        playing: false,
        ended: true,
        rate: 1,
        volume: null,
        muted: null,
      }),
    )?.type,
    "SOURCE_STATE",
  );
  assert.equal(
    parseIncoming(
      JSON.stringify({
        type: "SOURCE_STATE",
        track: null,
        positionMs: 0,
        playing: false,
        ended: true,
        rate: 1,
        volume: null,
        muted: false,
      }),
    ),
    null,
  );
});
test("media volume reports desktop changes and unmute on positive tablet input", () => {
  const media = new EventTarget() as HTMLMediaElement;
  media.volume = 0.37;
  media.muted = true;
  Object.assign(media, {
    isConnected: true,
    duration: 120,
    currentSrc: "song",
    paused: false,
    ended: false,
    readyState: 4,
  });
  const observed: { volume: number; muted: boolean }[] = [];
  const stop = observeVolume(media, () => {
    const volume = readMediaVolume(media);
    if (volume) observed.push(volume);
  });
  media.volume = 0.42;
  media.dispatchEvent(new Event("volumechange"));
  assert.deepEqual(observed, [{ volume: 0.42, muted: true }]);
  assert.equal(setMediaVolume(media, 0.65), true);
  assert.deepEqual(readMediaVolume(media), { volume: 0.65, muted: false });
  assert.equal(setMediaVolume(media, 3), true);
  assert.equal(media.volume, 1);
  assert.equal(setMediaVolume(media, -3), true);
  assert.equal(media.volume, 0);
  stop();
  media.dispatchEvent(new Event("volumechange"));
  assert.equal(observed.length, 1);
});
test("unknown media preserves prior observed volume and never assumes maximum", () => {
  const tracker = new MediaVolumeTracker();
  assert.equal(readMediaVolume(null), null);
  assert.equal(tracker.observe(null), null);
  const old = { volume: 0.31, muted: false } as HTMLMediaElement;
  assert.deepEqual(tracker.observe(old), { volume: 0.31, muted: false });
  assert.deepEqual(tracker.replace(null), { volume: 0.31, muted: false });
  assert.deepEqual(tracker.observe(null), { volume: 0.31, muted: false });
  assert.equal(setMediaVolume(null, 1), false);
});
test("media replacement restores prior volume before adopting a fresh default", () => {
  const tracker = new MediaVolumeTracker();
  const old = { volume: 0.42, muted: true } as HTMLMediaElement;
  const next = { volume: 1, muted: false } as HTMLMediaElement;
  tracker.observe(old);
  Object.assign(old, { volume: 1 }); // detached element resetting cannot erase 0.42
  assert.deepEqual(tracker.replace(next), { volume: 0.42, muted: true });
  assert.equal(next.volume, 0.42);
  assert.equal(next.muted, true);
  const desktopChanged = { volume: 0.28, muted: false } as HTMLMediaElement;
  tracker.replace(desktopChanged);
  assert.deepEqual(tracker.known, { volume: 0.28, muted: false });
});
test("song changes on the same media element cannot silently reset to 100%", () => {
  const tracker = new MediaVolumeTracker();
  const media = { volume: 0.34, muted: false } as HTMLMediaElement;
  assert.equal(tracker.observe(media, 1000)?.volume, 0.34);
  tracker.beginTransition(2000);
  media.volume = 1;
  assert.equal(tracker.observe(media, 2100)?.volume, 0.34);
  assert.equal(media.volume, 0.34);
  media.volume = 1; // late reset, even after the short transition window
  assert.equal(tracker.observe(media, 9000)?.volume, 0.34);
  assert.equal(media.volume, 0.34);
  tracker.authorizeRequestedVolume(0.5, 10000); // a 50% drag cannot permit 100%
  media.volume = 1;
  assert.equal(tracker.observe(media, 10001)?.volume, 0.34);
  assert.equal(media.volume, 0.34);
  tracker.authorizeRequestedVolume(1, 10002); // explicit desktop or Galaxy maximum
  media.volume = 1;
  assert.equal(tracker.observe(media, 10003)?.volume, 1);
  media.volume = 0.42;
  assert.equal(tracker.observe(media, 10100)?.volume, 0.42);
  tracker.beginTransition(11000);
  media.volume = 1;
  assert.equal(tracker.observe(media, 11001)?.volume, 0.42);
});
test("media selection retains the real player over transient preload media", () => {
  const old = {
    isConnected: true,
    paused: false,
    ended: false,
    duration: 120,
    currentSrc: "song-a",
    readyState: 4,
  } as HTMLMediaElement;
  const preload = {
    isConnected: true,
    paused: true,
    ended: false,
    duration: NaN,
    currentSrc: "",
    readyState: 0,
  } as HTMLMediaElement;
  assert.equal(chooseMedia([preload, old], old, null), old);
  assert.equal(chooseMedia([preload], null, null), null);
  const next = {
    isConnected: true,
    paused: false,
    ended: false,
    duration: 130,
    currentSrc: "song-b",
    readyState: 4,
  } as HTMLMediaElement;
  Object.assign(old, { paused: true });
  assert.equal(chooseMedia([preload, old, next], old, null), next);
});
test("Atlas publishes only Windows master volume; source changes cannot overwrite it", () => {
  const store = new StateStore();
  store.connect();
  const first = {
    type: "SOURCE_STATE" as const,
    track,
    positionMs: 1000,
    playing: true,
    ended: false,
    rate: 1,
    volume: 0.37,
    muted: false,
  };
  assert.equal(store.update(first), true);
  store.setLyrics(store.snapshot.version, {
    provider: "test",
    lines: [{ startMs: 0, text: "line" }],
  });
  assert.equal(store.snapshot.volume, null);
  store.setMasterVolume({
    type: "MASTER_VOLUME_STATE",
    volume: 0.92,
    muted: false,
  });
  assert.equal(store.snapshot.volume, 0.92);
  assert.equal(store.update({ ...first, volume: 0.65, muted: true }), false);
  assert.equal(store.snapshot.volume, 0.92);
  assert.equal(store.snapshot.muted, false);
  store.setMasterVolume(null);
  assert.equal(store.snapshot.volume, null);
  assert.equal(
    displayState(store.snapshot, true, Date.now(), null, Date.now()),
    "PLAYING",
  );
});
test("slider bounds drag traffic and sends the exact final value", async () => {
  const values: number[] = [];
  const sender = new VolumeThrottle(
    (value) => values.push(value),
    Date.now,
    150,
  );
  for (let i = 0; i < 100; i++) sender.input(i / 100);
  assert.deepEqual(values, [0]);
  sender.finish(0.37);
  assert.deepEqual(values, [0, 0.37]);
  sender.finish(1); // Galaxy cannot command Windows above 75%
  assert.deepEqual(values, [0, 0.37, 0.75]);
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.deepEqual(values, [0, 0.37, 0.75]);
});
test("Galaxy volume changes require a trusted gesture; snapshots and reconnect never send", () => {
  class Input extends EventTarget {
    value = "100";
    disabled = false;
    nextElementSibling = { textContent: "" };
    parentElement = { classList: { toggle() {} } };
    setAttribute(_key: string, _value: string): void {}
  }
  const input = new Input();
  const trusted = new WeakSet<Event>();
  const commands: number[] = [];
  const slider = new VolumeSlider(
    input as unknown as HTMLInputElement,
    (volume) => {
      commands.push(volume);
      return String(commands.length);
    },
    () => {},
    (event) => trusted.has(event),
    input,
    false,
  );
  const fire = (type: string, value?: number, real = false) => {
    if (value !== undefined) input.value = String(value);
    const event = new Event(type);
    if (real) trusted.add(event);
    input.dispatchEvent(event);
  };
  assert.equal(input.disabled, true);
  assert.equal(input.value, "0");
  fire("input", 100);
  fire("change", 100);
  assert.deepEqual(commands, []);
  slider.receive(0.28, false, true);
  assert.equal(input.disabled, false);
  assert.equal(input.value, "28");
  fire("input", 100); // synthetic/programmatic change without a gesture
  fire("mousedown", undefined, false);
  fire("input", 100, true);
  assert.deepEqual(commands, []);
  slider.receive(0.28, false, true);
  assert.equal(input.value, "28");
  fire("mousedown", undefined, true);
  fire("input", 63, true);
  fire("mouseup", undefined, true);
  assert.deepEqual(commands, [0.63]);
  slider.receive(0.63, false, true); // authoritative echo, not a new command
  assert.equal(input.value, "63");
  fire("mousedown", undefined, true);
  fire("input", 100, true);
  fire("mouseup", undefined, true);
  assert.equal(commands[commands.length - 1], 0.75);
  slider.receive(0.75, false, true);
  slider.receive(0.92, false, true); // desktop can exceed Galaxy cap
  assert.equal(input.value, "75");
  assert.equal(input.nextElementSibling.textContent, "92%");
  slider.receive(null, null, false);
  assert.equal(input.disabled, true);
  fire("mousedown", undefined, true);
  fire("input", 100, true);
  assert.equal(commands.length, 2);
  slider.receive(0.42, false, true); // reconnect or track change is display-only
  assert.equal(input.value, "42");
  assert.equal(commands.length, 2);
  fire("mousedown", undefined, true);
  fire("blur"); // blur cancels without setting any volume
  assert.equal(commands.length, 2);
});
test("failed or absent cover fades out while track metadata remains available", () => {
  const makeLayer = () => ({
    style: { backgroundImage: "" },
    classList: {
      active: false,
      add() {
        this.active = true;
      },
      remove() {
        this.active = false;
      },
    },
  });
  const layers = [makeLayer(), makeLayer()];
  const cover = {
    style: { display: "" },
    src: "",
    onload: null as null | (() => void),
    onerror: null as null | (() => void),
    removeAttribute() {
      this.src = "";
    },
  };
  const view = new ArtworkView(
    cover as unknown as HTMLImageElement,
    layers as unknown as HTMLElement[],
    "http://atlas.local/display",
  );
  const fields = Object.fromEntries(
    ["title", "artist", "coverTitle", "coverArtist", "coverAlbum"].map(
      (key) => [key, { textContent: "" }],
    ),
  ) as unknown as Parameters<typeof showTrackMetadata>[1];
  showTrackMetadata({ ...track, album: "Album" }, fields);
  view.show("https://example.com/old.jpg", 1);
  cover.onload?.();
  assert.equal(cover.style.display, "block");
  view.show("https://example.com/broken.jpg", 2);
  assert.equal(cover.style.display, "none");
  cover.onerror?.();
  assert.equal(layers[0]?.style.backgroundImage, "none");
  assert.equal(fields.coverTitle.textContent, track.title);
  assert.equal(fields.coverArtist.textContent, track.artist);
  view.show("", 3);
  assert.equal(cover.style.display, "none");
  assert.equal(cover.src, "");
  assert.equal(layers[1]?.style.backgroundImage, "none");
  showTrackMetadata(
    { ...track, title: "Next", artist: "Other", artwork: "" },
    fields,
  );
  assert.equal(fields.coverTitle.textContent, "Next");
  assert.equal(fields.coverArtist.textContent, "Other");
  assert.equal(fields.coverAlbum.textContent, "");
});
test("track stays visible through lyric loading, empty lines and provider error", () => {
  const store = new StateStore();
  store.connect();
  store.update({
    type: "SOURCE_STATE",
    track,
    positionMs: 0,
    playing: true,
    ended: false,
    rate: 1,
    volume: 0.5,
    muted: false,
  });
  const version = store.snapshot.version;
  assert.equal(displayState(store.snapshot, true, 0, null, 0), "NO_LYRICS");
  // A rejected provider request leaves the snapshot lyrics null.
  assert.equal(displayState(store.snapshot, true, 1000, null, 0), "NO_LYRICS");
  store.setLyrics(version, { provider: "test", lines: [] });
  assert.equal(displayState(store.snapshot, true, 2000, null, 0), "NO_LYRICS");
  store.setLyrics(version, {
    provider: "test",
    lines: [{ startMs: 1000, text: "line" }],
  });
  assert.equal(displayState(store.snapshot, true, 3000, null, 0), "PLAYING");
});
test("state versions and stale lyrics", () => {
  const store = new StateStore();
  store.connect();
  assert.equal(
    store.update({
      type: "SOURCE_STATE",
      track,
      positionMs: 1000,
      playing: true,
      ended: false,
      rate: 1,
      volume: 0.37,
      muted: false,
    }),
    true,
  );
  assert.equal(
    store.update({
      type: "SOURCE_STATE",
      track,
      positionMs: 2000,
      playing: true,
      ended: false,
      rate: 1,
      volume: 0.37,
      muted: false,
    }),
    false,
  );
  assert.equal(store.setLyrics(0, { provider: "demo", lines: [] }), false);
  store.update({
    type: "SOURCE_STATE",
    track,
    positionMs: 90000,
    playing: false,
    ended: false,
    rate: 1,
    volume: 0.37,
    muted: false,
    seek: true,
  });
  assert.ok(store.snapshot.positionMs === 90000);
});
test("interpolation, seeking, pause and lyric selection", () => {
  const store = new StateStore();
  store.connect();
  store.update({
    type: "SOURCE_STATE",
    track,
    positionMs: 4000,
    playing: true,
    ended: false,
    rate: 1,
    volume: 0.37,
    muted: false,
  });
  const snap = store.snapshot;
  assert.equal(effectivePosition(snap, 100, 2100), 6000);
  assert.equal(lineIndex([{ startMs: 2000 }, { startMs: 5000 }], 6000), 1);
  assert.equal(lineIndex([{ startMs: 2000 }], 1000), -1);
  store.update({
    type: "SOURCE_STATE",
    track,
    positionMs: 9000,
    playing: false,
    ended: false,
    rate: 1,
    volume: 0.37,
    muted: false,
    seek: true,
  });
  assert.equal(effectivePosition(store.snapshot, 100, 2100), 9000);
});
test("pause timeout and silent disconnect", () => {
  const store = new StateStore();
  store.connect();
  store.update({
    type: "SOURCE_STATE",
    track,
    positionMs: 4000,
    playing: false,
    ended: false,
    rate: 1,
    volume: 0.37,
    muted: false,
  });
  store.setLyrics(1, { provider: "test", lines: [{ startMs: 0, text: "hi" }] });
  assert.equal(displayState(store.snapshot, true, 59999, 0, 0), "PAUSED");
  assert.equal(displayState(store.snapshot, true, 60000, 0, 0), "STANDBY");
  assert.equal(displayState(store.snapshot, false, 0, null, 0), "DISCONNECTED");
  store.setLyrics(1, null);
  assert.equal(displayState(store.snapshot, true, 59999, 0, 0), "NO_LYRICS");
  assert.equal(displayState(store.snapshot, true, 60000, 0, 0), "STANDBY");
  assert.equal(displayState(store.snapshot, true, 0, null, 0), "NO_LYRICS");
  assert.equal(
    displayState(
      { ...store.snapshot, track: { ...track, artwork: "" } },
      true,
      59999,
      0,
      0,
    ),
    "NO_LYRICS",
  );
  assert.equal(
    displayState({ ...store.snapshot, track: null }, true, 10000, null, 0),
    "STANDBY",
  );
});

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
import { parsePlayerMetadata } from "../../extension/src/metadata.js";
import { ReportGate } from "../../extension/src/report-gate.js";
import { StateStore } from "../src/state.js";
import { parseIncoming } from "../../shared/protocol.js";
import {
  displayState,
  effectivePosition,
  lineIndex,
} from "../../display/src/model.js";
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
    clearEvidence: false,
    seek: false,
  });
  const invalid = {
    track: null,
    positionMs: 0,
    playing: false,
    rate: 1,
    clearEvidence: true,
    seek: true,
  };
  assert.equal(gate.accept(valid(songA), 0)?.track?.title, "Song A");
  assert.equal(gate.accept(invalid, 100), null);
  assert.equal(gate.accept(invalid, 5000), null);
  assert.equal(gate.accept(valid(songB), 6000)?.track?.title, "Song B");
  assert.equal(gate.accept(invalid, 7000), null);
  assert.equal(gate.accept(invalid, 15000)?.track, null);
});
test("duration loss does not make an otherwise valid player bar a clear signal", () => {
  const gate = new ReportGate(8000);
  gate.accept(
    {
      track,
      positionMs: 1000,
      playing: true,
      rate: 1,
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
    urls.push(new URL(String(input)));
    const records =
      urls.length === 1
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
    assert.equal(urls[0]?.searchParams.get("artist_name"), "Yeat");
    assert.equal(urls[1]?.searchParams.get("artist_name"), null);
  } finally {
    globalThis.fetch = original;
  }
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
      JSON.stringify({ type: "HELLO", role: "display", protocol: 1 }),
    )?.type,
    "HELLO",
  );
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
  });
  store.setLyrics(1, { provider: "test", lines: [{ startMs: 0, text: "hi" }] });
  assert.equal(displayState(store.snapshot, true, 59999, 0, 0), "PAUSED");
  assert.equal(displayState(store.snapshot, true, 60000, 0, 0), "STANDBY");
  assert.equal(displayState(store.snapshot, false, 0, null, 0), "DISCONNECTED");
  store.setLyrics(1, null);
  assert.equal(displayState(store.snapshot, true, 59999, 0, 0), "NO_LYRICS");
  assert.equal(displayState(store.snapshot, true, 60000, 0, 0), "STANDBY");
});

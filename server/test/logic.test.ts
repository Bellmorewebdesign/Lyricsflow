import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanTitle,
  normalize,
  normalizeArtist,
  parseLrc,
  matchScore,
} from "../src/lyrics.js";
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
});

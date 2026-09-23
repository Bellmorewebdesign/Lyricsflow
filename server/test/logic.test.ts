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
import {
  chooseMedia,
  MediaVolumeTracker,
  observeVolume,
  readMediaVolume,
  setMediaVolume,
} from "../../extension/src/volume.js";
import { StateStore } from "../src/state.js";
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
});
test("volume protocol accepts only finite unit values and short nonempty ids", () => {
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
test("Atlas publishes only reported media volume; changes do not reset lyrics", () => {
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
  assert.equal(store.snapshot.volume, 0.37);
  assert.equal(store.update({ ...first, volume: 0.65, muted: true }), false);
  assert.equal(store.snapshot.volume, 0.65);
  assert.equal(store.snapshot.muted, true);
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
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.deepEqual(values, [0, 0.37]);
});
test("Galaxy volume changes require a trusted gesture; snapshots and reconnect never send", () => {
  class Input extends EventTarget {
    value = "100";
    disabled = false;
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
  assert.equal(commands[commands.length - 1], 1);
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

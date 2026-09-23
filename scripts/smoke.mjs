import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import assert from "node:assert/strict";
const port = 22000 + Math.floor(Math.random() * 10000);
const child = spawn(process.execPath, ["dist/server/index.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    SIMULATOR: "true",
  },
  stdio: "pipe",
});
let display, source, volumeAgent;
const waitFor = (ws, predicate) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("Timed out waiting for message"));
    }, 3000);
    function onMessage(raw) {
      const data = JSON.parse(raw);
      if (predicate(data)) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        resolve(data);
      }
    }
    ws.on("message", onMessage);
  });
const open = (url) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, "server started");
  const displayResponse = await fetch(`http://127.0.0.1:${port}/display`);
  assert.equal(displayResponse.status, 200);
  const html = await displayResponse.text();
  assert.ok(
    html.includes('id="cover-title"') &&
      html.includes('id="cover"') &&
      html.includes('id="volume"') &&
      html.includes('max="75"') &&
      html.includes("disabled"),
    "artwork-only track view exists",
  );
  assert.equal((await fetch(`http://127.0.0.1:${port}/simulator`)).status, 200);
  display = await open(`ws://127.0.0.1:${port}/ws`);
  display.send(JSON.stringify({ type: "HELLO", role: "display", protocol: 3 }));
  source = await open(`ws://127.0.0.1:${port}/ws`);
  source.send(JSON.stringify({ type: "HELLO", role: "source", protocol: 3 }));
  volumeAgent = await open(`ws://127.0.0.1:${port}/ws`);
  volumeAgent.send(
    JSON.stringify({ type: "HELLO", role: "volume", protocol: 3 }),
  );
  const state = {
    type: "SOURCE_STATE",
    track: {
      title: "Demo",
      artist: "Ensemble",
      videoId: "lyricsflow-demo-1",
      durationMs: 120000,
    },
    positionMs: 55000,
    playing: true,
    ended: false,
    rate: 1,
    volume: 0.37,
    muted: false,
  };
  const lyricsResult = waitFor(
    display,
    (msg) =>
      msg.type === "SERVER_STATE" && msg.lyrics?.provider === "Simulator",
  );
  let unsolicitedVolumeCommand = false;
  const unexpectedCommand = (raw) => {
    if (JSON.parse(raw).type === "SET_VOLUME") unsolicitedVolumeCommand = true;
  };
  source.on("message", unexpectedCommand);
  source.send(JSON.stringify(state));
  const snap = await lyricsResult;
  assert.equal(snap.positionMs >= 55000, true);
  assert.ok(snap.lyrics.lines.length);
  // Music metadata and Windows output volume are independent sources.
  const confirmedMaster = waitFor(
    display,
    (msg) => msg.type === "SERVER_STATE" && msg.volume === 0.37,
  );
  volumeAgent.send(
    JSON.stringify({ type: "MASTER_VOLUME_STATE", volume: 0.37, muted: false }),
  );
  const master = await confirmedMaster;
  assert.equal(master.volume, 0.37);
  assert.equal(
    unsolicitedVolumeCommand,
    false,
    "SOURCE_STATE never produces SET_VOLUME",
  );
  source.off("message", unexpectedCommand);
  const command = waitFor(
    source,
    (msg) => msg.type === "CONTROL_COMMAND" && msg.command === "NEXT",
  );
  display.send(
    JSON.stringify({ type: "CONTROL_COMMAND", command: "NEXT", id: "smoke" }),
  );
  assert.equal((await command).id, "smoke");
  const ack = waitFor(
    display,
    (msg) => msg.type === "CONTROL_ACK" && msg.id === "smoke",
  );
  source.send(
    JSON.stringify({ type: "CONTROL_ACK", id: "smoke", delivered: true }),
  );
  assert.equal((await ack).delivered, true);
  const volumeCommand = waitFor(
    volumeAgent,
    (msg) => msg.type === "SET_VOLUME" && msg.id === "volume-smoke",
  );
  source.on("message", unexpectedCommand);
  display.send(
    JSON.stringify({ type: "SET_VOLUME", volume: 0.65, id: "volume-smoke" }),
  );
  assert.equal((await volumeCommand).volume, 0.65);
  assert.equal(unsolicitedVolumeCommand, false);
  source.off("message", unexpectedCommand);
  const volumeAck = waitFor(
    display,
    (msg) => msg.type === "CONTROL_ACK" && msg.id === "volume-smoke",
  );
  volumeAgent.send(
    JSON.stringify({
      type: "CONTROL_ACK",
      id: "volume-smoke",
      delivered: true,
    }),
  );
  assert.equal((await volumeAck).delivered, true);
  const volumeState = waitFor(
    display,
    (msg) => msg.type === "SERVER_STATE" && msg.volume === 0.65,
  );
  volumeAgent.send(
    JSON.stringify({ type: "MASTER_VOLUME_STATE", volume: 0.65, muted: false }),
  );
  assert.equal((await volumeState).volume, 0.65);
  const sourceChangesNothing = waitFor(
    display,
    (msg) =>
      msg.type === "SERVER_STATE" &&
      msg.positionMs >= 55000 &&
      msg.volume === 0.65,
  );
  source.send(JSON.stringify({ ...state, volume: 1 }));
  assert.equal((await sourceChangesNothing).volume, 0.65);
  const desktopLouder = waitFor(
    display,
    (msg) => msg.type === "SERVER_STATE" && msg.volume === 0.92,
  );
  volumeAgent.send(
    JSON.stringify({ type: "MASTER_VOLUME_STATE", volume: 0.92, muted: false }),
  );
  assert.equal((await desktopLouder).volume, 0.92);
  let invalidForwarded = false;
  const onInvalid = (raw) => {
    if (JSON.parse(raw).type === "SET_VOLUME") invalidForwarded = true;
  };
  source.on("message", onInvalid);
  volumeAgent.on("message", onInvalid);
  display.send(
    JSON.stringify({ type: "SET_VOLUME", volume: 1.1, id: "invalid" }),
  );
  display.send(
    JSON.stringify({ type: "SET_VOLUME", volume: -0.1, id: "invalid2" }),
  );
  const capped = waitFor(
    display,
    (msg) => msg.type === "CONTROL_ACK" && msg.id === "too-loud",
  );
  display.send(
    JSON.stringify({ type: "SET_VOLUME", volume: 0.76, id: "too-loud" }),
  );
  assert.equal((await capped).delivered, false);
  const missing = waitFor(
    display,
    (msg) =>
      msg.type === "SERVER_STATE" &&
      msg.track?.title === "Untimed Sample" &&
      msg.lyrics === null,
  );
  source.send(
    JSON.stringify({
      ...state,
      volume: 0.65,
      track: {
        ...state.track,
        title: "Untimed Sample",
        videoId: "lyricsflow-demo-no-lyrics",
      },
    }),
  );
  assert.equal((await missing).track.artist, "Ensemble");
  assert.equal(invalidForwarded, false);
  source.off("message", onInvalid);
  volumeAgent.off("message", onInvalid);
  const masterGone = waitFor(
    display,
    (msg) => msg.type === "SERVER_STATE" && msg.track && msg.volume === null,
  );
  volumeAgent.close();
  await masterGone;
  const noFallback = waitFor(
    display,
    (msg) => msg.type === "CONTROL_ACK" && msg.id === "offline",
  );
  display.send(
    JSON.stringify({ type: "SET_VOLUME", volume: 0.5, id: "offline" }),
  );
  assert.equal((await noFallback).delivered, false);
  assert.equal(
    child.exitCode,
    null,
    "server is still running with open clients",
  );
  const stopped = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("SIGTERM did not drain connected clients")),
      3000,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
    child.kill("SIGTERM");
  });
  assert.deepEqual(stopped, { code: 0, signal: null });
  console.log(
    "Smoke passed: HTTP, timed and missing lyrics, artwork view, controls, volume round trip, ACK and clean shutdown",
  );
} finally {
  display?.terminate();
  source?.terminate();
  volumeAgent?.terminate();
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}

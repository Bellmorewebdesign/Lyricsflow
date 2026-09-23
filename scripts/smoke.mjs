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
let display, source;
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
    html.includes('id="cover-title"') && html.includes('id="cover"'),
    "artwork-only track view exists",
  );
  assert.equal((await fetch(`http://127.0.0.1:${port}/simulator`)).status, 200);
  display = await open(`ws://127.0.0.1:${port}/ws`);
  display.send(JSON.stringify({ type: "HELLO", role: "display", protocol: 1 }));
  source = await open(`ws://127.0.0.1:${port}/ws`);
  source.send(JSON.stringify({ type: "HELLO", role: "source", protocol: 1 }));
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
  };
  const lyricsResult = waitFor(
    display,
    (msg) =>
      msg.type === "SERVER_STATE" && msg.lyrics?.provider === "Simulator",
  );
  source.send(JSON.stringify(state));
  const snap = await lyricsResult;
  assert.equal(snap.positionMs >= 55000, true);
  assert.ok(snap.lyrics.lines.length);
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
      track: {
        ...state.track,
        title: "Untimed Sample",
        videoId: "lyricsflow-demo-no-lyrics",
      },
    }),
  );
  assert.equal((await missing).track.artist, "Ensemble");
  console.log(
    "Smoke passed: HTTP, timed and missing lyrics, artwork view, control routing and ACK",
  );
} finally {
  display?.close();
  source?.close();
  child.kill("SIGTERM");
}

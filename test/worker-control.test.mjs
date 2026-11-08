import assert from "node:assert/strict";
import { test } from "node:test";
import { workerFixture } from "./fixtures/browser.mjs";
import { memoryLocks, memoryStorage, stream } from "./fixtures/opfs.mjs";
import { STATE } from "../public/ring-buffer.js";
const settle = () => new Promise(setImmediate);
const started = { type: "stream-started", ...stream };

function pcm() {
  const buffer = new ArrayBuffer(32), view = new DataView(buffer);
  view.setUint32(8, 2, true);
  view.setUint16(12, 2, true);
  [0.25, -0.5, 0.75, -1].forEach((value, i) => view.setFloat32(16 + i * 4, value, true));
  return buffer;
}

test("malformed and unsupported control frames preserve valid stream and PCM", async (t) => {
  let allocations = 0;
  const NativeSAB = SharedArrayBuffer;
  const f = await workerFixture(t, { SharedArrayBuffer: class extends NativeSAB {
    constructor(...args) { super(...args); allocations++; }
  } });
  f.socket.emit("message", JSON.stringify(started));
  const buffer = f.messages.find((m) => m.type === "shared-buffer").sharedBuffer;
  const bad = ["{", "null", "[]", "42", JSON.stringify({ type: "unknown" }),
    JSON.stringify({ type: "stream-error", code: [], message: {} }),
    JSON.stringify({ type: "native-input-stats", source: "sine", atFrame: -1 }),
    " ".repeat(4097)];
  for (const field of ["sampleRate", "channels", "framesPerBlock"]) {
    for (const value of [0, -1, 1.5, 2 ** 40, null, "2"]) {
      bad.push(JSON.stringify({ ...started, [field]: value }));
    }
  }
  bad.push(JSON.stringify({ ...started, sampleFormat: "s16" }));
  bad.push(JSON.stringify({ ...started, channels: 64, sampleRate: 384000 }));
  for (const control of bad) {
    const before = f.messages.length;
    assert.doesNotThrow(() => f.socket.emit("message", control));
    assert.equal(f.messages.length, before + 1);
    assert.equal(f.messages.at(-1).type, "error");
    assert.ok(f.messages.at(-1).message.length < 200);
    assert.equal(allocations, 1);
  }
  f.socket.emit("message", pcm());
  const state = new Int32Array(buffer);
  assert.equal(state[STATE.RECEIVED_BLOCKS], 1);
  assert.equal(state[STATE.CHANNELS], 2);
  f.socket.emit("message", JSON.stringify({ type: "native-input-stats", source: "sine",
    nativeDroppedBlocks: 0, nativeDroppedFrames: 0, nativeDropEvents: 0,
    bridgeQueueCapacityBlocks: 0, atFrame: 2 }));
  assert.equal(f.messages.at(-1).type, "native-input-stats");
  f.socket.emit("message", JSON.stringify({ type: "stream-error", code: "server-client-lagged", message: "Synthetic lag" }));
  assert.equal(f.messages.at(-1).message, "Synthetic lag");
});

for (const pending of [false, true]) {
  test(`shape refusal during ${pending ? "pending start" : "recording"} blocks PCM and persists integrity evidence`, async (t) => {
    const root = memoryStorage();
    const f = await workerFixture(t, { navigator: {
      storage: { getDirectory: async () => root, persist: async () => true }, locks: memoryLocks(),
    } });
    f.socket.emit("message", JSON.stringify(started));
    f.send("recording-start");
    if (!pending) {
      await settle();
      f.socket.emit("message", pcm());
    }
    f.socket.emit("message", JSON.stringify({ ...started, sampleRate: 44100 }));
    assert.equal(f.messages.at(-1).type, "error");
    await settle();
    f.socket.emit("message", JSON.stringify(started)); // Cannot clear refusal during recording.
    f.socket.emit("message", pcm());
    assert.equal(f.messages.filter((m) => m.type === "shared-buffer").length, 1);
    f.send("recording-stop");
    await settle(); await settle();
    const status = f.messages.filter((m) => m.type === "recording-status").at(-1).status;
    assert.equal(status.state, "stopped");
    assert.equal(status.recordedFrames, pending ? 0 : 2);
    f.send("export-manifest");
    await settle();
    const manifest = JSON.parse(await f.messages.filter((m) => m.type === "download").at(-1).blob.text());
    assert.equal(manifest.sampleRate, 48000);
    assert.equal(manifest.integrity.invalidBlocks.length, 1);
    assert.match(manifest.integrity.invalidBlocks[0].reason, /geometry changed/);
    assert.equal(manifest.totalRecordedFrames, pending ? 0 : 2);
  });
}

import { readFileSync } from "node:fs";
import { pcmBlock } from "./fixtures/pcm.mjs";
const geometryCases = JSON.parse(readFileSync(new URL("./fixtures/stream-geometry.json", import.meta.url)));

test("producer and worker share geometry limits including rounded ring byte ceiling", async (t) => {
  const f = await workerFixture(t);
  for (const { accepted, ...geometry } of geometryCases) {
    const start = f.messages.length;
    f.socket.emit("message", JSON.stringify({ type: "stream-started", ...geometry, sampleFormat: "f32-interleaved" }));
    const result = f.messages.slice(start);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, accepted ? "shared-buffer" : "error", JSON.stringify(geometry));
    if (accepted) {
      assert.ok(result[0].sharedBuffer.byteLength <= 64 * 1024 * 1024);
      // Exercise full maximum block geometry with synthetic finite samples.
      const samples = Array(geometry.channels * geometry.framesPerBlock).fill(0.25);
      f.socket.emit("message", pcmBlock({ frameCount: geometry.framesPerBlock,
        channels: geometry.channels, samples }));
      assert.equal(new Int32Array(result[0].sharedBuffer)[STATE.RECEIVED_BLOCKS], 1);
    }
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { appFixture, workerFixture } from "./fixtures/browser.mjs";
import { memoryLocks, memoryStorage, stream } from "./fixtures/opfs.mjs";
import { STATE } from "../public/ring-buffer.js";
const settle = () => new Promise(setImmediate);
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("Synthetic lifecycle did not settle");
}
function pcm(frameStart) {
  const buffer = new ArrayBuffer(32), view = new DataView(buffer);
  view.setBigUint64(0, BigInt(frameStart), true);
  view.setUint32(8, 2, true); view.setUint16(12, 2, true);
  [0.25, -0.5, 0.75, -1].forEach((v, i) => view.setFloat32(16 + i * 4, v, true));
  return buffer;
}
for (const event of ["close", "error"]) {
  test(`${event} interrupts recording once, flushes PCM and permits reconnect`, async (t) => {
    const root = memoryStorage();
    let chunkCloses = 0;
    root.beforeClose = async (name) => { if (name.endsWith(".f32")) chunkCloses++; };
    const f = await workerFixture(t, { navigator: {
      storage: { getDirectory: async () => root, persist: async () => true }, locks: memoryLocks(),
    } });
    const configure = (socket) => {
      socket.emit("open");
      socket.emit("message", JSON.stringify({ type: "stream-started", ...stream }));
    };
    configure(f.socket);
    const stats = (count) => JSON.stringify({ type: "native-input-stats", source: "input",
      nativeDroppedBlocks: count, nativeDroppedFrames: count * 2, nativeDropEvents: count,
      bridgeQueueCapacityBlocks: 64, atFrame: 100 });
    f.socket.emit("message", stats(5));
    const buffer = f.messages.find((m) => m.type === "shared-buffer").sharedBuffer;
    f.send("recording-start");
    const status = () => f.messages.filter((m) => m.type === "recording-status").at(-1)?.status;
    await until(() => status()?.state === "recording");
    for (const frame of [0, 2, 4]) f.socket.emit("message", pcm(frame));
    f.socket.emit(event);
    f.socket.emit("close"); f.socket.emit("error");
    assert.equal(new Int32Array(buffer)[STATE.CONNECTED], 0);
    // Reconnect before the queued interruption drains: counters/session ownership must survive.
    f.send("connect");
    const current = f.sockets[1]; configure(current);
    current.emit("message", stats(99));
    current.emit("message", JSON.stringify({ type: "stream-error", code: "server-client-lagged", message: "New connection lag" }));
    await until(() => status()?.state === "interrupted");
    await until(() => f.messages.filter((m) => m.type === "shared-buffer").length === 2);
    current.emit("message", JSON.stringify({ type: "stream-error", code: "server-client-lagged", message: "New configured connection lag" }));
    current.emit("message", new ArrayBuffer(1));
    const wrongChannels = pcm(0);
    const wrongView = new DataView(wrongChannels);
    wrongView.setUint16(12, 1, true);
    wrongView.setUint32(8, 4, true); // Four mono frames retain the 32-byte wire length.
    current.emit("message", wrongChannels);
    assert.deepEqual(f.messages.at(-1), {
      type: "error", message: "PCM block channel mismatch: expected 2, got 1",
    });
    assert.equal(status().recordedFrames, 6);
    assert.equal(chunkCloses, 1);
    assert.match(status().lastError, /transport/i);
    f.send("export-manifest");
    await until(() => f.messages.some((m) => m.type === "download"));
    const manifest = JSON.parse(await f.messages.filter((m) => m.type === "download").at(-1).blob.text());
    assert.equal(manifest.state, "interrupted");
    assert.equal(manifest.stoppedAt, null);
    assert.ok(manifest.interruptedAt);
    assert.equal(manifest.totalRecordedFrames, 6);
    assert.equal(manifest.nativeInputStats.latest.nativeDroppedBlocks, 5);
    assert.deepEqual(manifest.nativeInputStats.events, []);
    assert.deepEqual(manifest.integrity.websocketLagEvents, []);
    assert.deepEqual(manifest.integrity.invalidBlocks, []);
    assert.deepEqual(manifest.integrity.channelMismatches, []);
    assert.equal(manifest.chunks[0].bytes, 48);
    assert.ok(manifest.chunks[0].completedAt);
    assert.equal(root.files.get(manifest.chunks[0].fileName).byteLength, 48);
    const count = f.messages.filter((m) => m.type === "download").length;
    f.send("export-selected-wav", { channelIndex: 0 });
    await until(() => f.messages.filter((m) => m.type === "download").length > count);
    const wav = new DataView(await f.messages.filter((m) => m.type === "download").at(-1).blob.arrayBuffer());
    assert.equal(wav.byteLength, 44 + 24);
    assert.deepEqual(Array.from({ length: 6 }, (_, i) => wav.getFloat32(44 + i * 4, true)),
      [0.25, 0.75, 0.25, 0.75, 0.25, 0.75]);
    f.send("recovery-scan");
    await until(() => f.messages.some((m) => m.type === "recovery-sessions"));
    const recovered = f.messages.filter((m) => m.type === "recovery-sessions").at(-1).result.sessions[0];
    assert.equal(recovered.state, "interrupted");
    assert.equal(recovered.exportableWav, true);
    assert.ok(recovered.warnings.some((w) => w.code === "transport-interrupted"));
    f.send("recording-start");
    await until(() => status()?.state === "recording");
    const before = f.messages.length;
    f.socket.emit("error"); f.socket.emit("close"); f.socket.emit("message", pcm(6));
    assert.equal(f.messages.length, before);
    assert.equal(status().state, "recording");
    current.emit("message", pcm(0));
    f.send("recording-stop");
    await until(() => status()?.state === "stopped");
    assert.equal(status().recordedFrames, 2);
  });
}

test("transport close during queued Start excludes pre-session counters and newer native stats", async (t) => {
  const root = memoryStorage();
  const f = await workerFixture(t, { navigator: {
    storage: { getDirectory: async () => root, persist: async () => true }, locks: memoryLocks(),
  } });
  const started = JSON.stringify({ type: "stream-started", ...stream });
  const stats = (count) => JSON.stringify({ type: "native-input-stats", source: "input",
    nativeDroppedBlocks: count, nativeDroppedFrames: count * 2, nativeDropEvents: count,
    bridgeQueueCapacityBlocks: 64, atFrame: 100 });
  f.socket.emit("message", started);
  f.socket.emit("message", stats(5));
  const buffer = f.messages.find((m) => m.type === "shared-buffer").sharedBuffer;
  const state = new Int32Array(buffer);
  state[STATE.UNDERRUN_COUNT] = 2;
  state[STATE.OVERFLOW_COUNT] = 3;
  for (const frame of [0, 2, 4]) f.socket.emit("message", pcm(frame));
  f.send("recording-start");
  f.socket.emit("close");
  f.send("connect");
  f.sockets[1].emit("message", started);
  f.sockets[1].emit("message", stats(99));
  await until(() => f.messages.some((m) => m.type === "recording-status" && m.status.state === "interrupted"));
  const status = f.messages.filter((m) => m.type === "recording-status").at(-1).status;
  for (const field of ["receivedBlocks", "recordedBlocks", "recordedFrames", "underrunsDuringRecording",
    "overflowsDuringRecording", "nativeDroppedBlocksDuringRecording", "nativeDroppedFramesDuringRecording", "nativeDropEventsDuringRecording"]) {
    assert.equal(status[field], 0, field);
  }
  f.send("export-manifest");
  await until(() => f.messages.some((m) => m.type === "download"));
  const manifest = JSON.parse(await f.messages.filter((m) => m.type === "download").at(-1).blob.text());
  assert.equal(manifest.receivedBlocksAtStop, manifest.receivedBlocksAtStart);
  assert.deepEqual(manifest.counterDeltasAtStop, { underrunsDuringRecording: 0, overflowsDuringRecording: 0 });
  assert.equal(manifest.nativeInputStats.stop.nativeDroppedBlocks, manifest.nativeInputStats.start.nativeDroppedBlocks);
});

test("page clears connectivity and exposes interrupted exports and retry", async (t) => {
  const f = await appFixture(t);
  f.stream();
  f.worker.emit({ type: "recording-status", status: { state: "recording", sessionId: "fixture", recordedFrames: 6 } });
  f.worker.emit({ type: "socket-state", state: "closed" });
  f.worker.emit({ type: "recording-status", status: {
    state: "interrupted", sessionId: "fixture", recordedFrames: 6, lastError: "Transport closed",
  } });
  assert.equal(f.elements.get("#record-state").textContent, "interrupted");
  assert.equal(f.elements.get("#record-start").disabled, true);
  assert.equal(f.elements.get("#monitor").disabled, true);
  assert.equal(f.elements.get("#connect").disabled, false);
  assert.equal(f.elements.get("#export-manifest").disabled, false);
  assert.equal(f.elements.get("#export-wav").disabled, false);
  assert.equal(f.elements.get("#wav-channel").disabled, false);
  f.click("#connect");
  assert.equal(f.worker.messages.at(-1).type, "connect");
});

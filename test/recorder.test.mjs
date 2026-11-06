import assert from "node:assert/strict";
import { test } from "node:test";

import { PcmRecorder } from "../public/recorder.js";

test("PcmRecorder starts with explicit unavailable native input stats", () => {
  const recorder = createRecorder();

  assert.deepEqual(recorder.currentNativeInputStats(), {
    available: false,
    source: "unknown",
    nativeDroppedBlocks: 0,
    nativeDroppedFrames: 0,
    nativeDropEvents: 0,
    bridgeQueueCapacityBlocks: 0,
    atFrame: 0,
    receivedAt: null,
  });
});

test("PcmRecorder normalizes native input stats and clamps invalid counters", () => {
  const recorder = createRecorder();

  recorder.setNativeInputStats({
    source: "sine",
    nativeDroppedBlocks: -1,
    nativeDroppedFrames: Number.NaN,
    nativeDropEvents: 0,
    bridgeQueueCapacityBlocks: 0,
    atFrame: 128,
  });

  const stats = recorder.currentNativeInputStats();
  assert.equal(stats.available, true);
  assert.equal(stats.source, "sine");
  assert.equal(stats.nativeDroppedBlocks, 0);
  assert.equal(stats.nativeDroppedFrames, 0);
  assert.equal(stats.nativeDropEvents, 0);
  assert.equal(stats.bridgeQueueCapacityBlocks, 0);
  assert.equal(stats.atFrame, 128);
  assert.equal(typeof stats.receivedAt, "string");
});

test("PcmRecorder posts status when native drop counters increase while idle", () => {
  const messages = [];
  const recorder = createRecorder({ postMessage: (message) => messages.push(message) });

  recorder.setNativeInputStats({
    source: "input",
    nativeDroppedBlocks: 1,
    nativeDroppedFrames: 240,
    nativeDropEvents: 1,
    bridgeQueueCapacityBlocks: 64,
    atFrame: 480,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "recording-status");
  assert.equal(messages[0].status.state, "idle");
  assert.equal(messages[0].status.nativeDroppedBlocksDuringRecording, 0);
  assert.equal(messages[0].status.nativeDroppedFramesDuringRecording, 0);
  assert.equal(messages[0].status.nativeDropEventsDuringRecording, 0);
});

function createRecorder({ postMessage = () => {} } = {}) {
  return new PcmRecorder({
    readCounters: () => ({
      underruns: 0,
      overflows: 0,
      receivedBlocks: 0,
    }),
    postMessage,
  });
}

// Each fixture owns its OPFS map; no browser, storage, or device is used.
import { barrier, memoryStorage, record, stream } from "./fixtures/opfs.mjs";

function storedRecorder(root = memoryStorage()) {
  const recorder = createRecorder();
  recorder.openStorageRoot = async () => root;
  return { recorder, root };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("concurrent starts enter storage once and retain one coherent session", async () => {
  const { recorder, root } = storedRecorder();
  const gate = barrier();
  let opens = 0;
  recorder.openStorageRoot = async () => { opens += 1; await gate.promise; return root; };
  const first = recorder.start(stream);
  const second = recorder.start(stream);
  await turn();
  try { assert.equal(opens, 1); } finally { gate.release(); }
  await Promise.all([first, second]);
  await record(recorder);
  await recorder.stop();
  assert.equal(recorder.state, "stopped");
  assert.equal(recorder.session.recordedBlocks, 1);
  assert.equal([...root.files.keys()].filter((name) => name.endsWith("-manifest.json")).length, 1);
});

test("reset waits for an in-flight start and removes only its artifacts", async () => {
  const { recorder, root } = storedRecorder();
  root.files.set("unrelated", new Uint8Array([7]));
  const gate = barrier();
  recorder.openStorageRoot = async () => { await gate.promise; return root; };
  const start = recorder.start(stream);
  await turn();
  const reset = recorder.clear();
  let resetDone = false;
  reset.then(() => { resetDone = true; });
  await turn();
  try { assert.equal(resetDone, false); } finally { gate.release(); }
  await Promise.all([start, reset]);
  assert.equal(recorder.state, "idle");
  assert.deepEqual([...root.files.keys()].sort(), ["native-pcm-recordings-index.json", "unrelated"]);
});

test("start waits for stop to commit its final chunk", async () => {
  const { recorder, root } = storedRecorder();
  await recorder.start(stream);
  await record(recorder);
  const oldId = recorder.session.sessionId;
  const gate = barrier();
  const entered = barrier();
  root.beforeClose = async (name) => {
    if (name.endsWith(".f32")) { entered.release(); await gate.promise; }
  };
  const stop = recorder.stop();
  await entered.promise;
  const start = recorder.start(stream);
  let startDone = false;
  start.then(() => { startDone = true; });
  await turn();
  try { assert.equal(startDone, false); } finally { gate.release(); }
  await Promise.all([stop, start]);
  assert.equal(recorder.state, "recording");
  assert.equal(root.files.has(`${oldId}-chunk-00000.f32`), false);
  await record(recorder);
  await recorder.stop();
  assert.equal(recorder.session.recordedBlocks, 1);
});

test("a rejected start releases the lifecycle queue for retry", async () => {
  const { recorder, root } = storedRecorder();
  recorder.openStorageRoot = async () => { throw new Error("synthetic storage failure"); };
  await assert.rejects(recorder.start(stream), /synthetic storage failure/);
  assert.equal(recorder.status().state, "idle");
  assert.equal(recorder.status().sessionId, "");
  recorder.openStorageRoot = async () => root;
  await recorder.start(stream);
  await record(recorder);
  await recorder.stop();
  assert.equal(recorder.state, "stopped");
});

test("failed final close is terminal and preserves earlier committed chunks for recovery", async (t) => {
  const { recorder, root } = storedRecorder();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "storage");
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "storage", descriptor);
    else delete navigator.storage;
  });
  await recorder.start(stream);
  await record(recorder);
  await recorder.closeCurrentChunk();
  const committed = recorder.session.chunks[0];
  const committedBytes = root.files.get(committed.fileName).slice();
  await record(recorder, 2);
  const incomplete = recorder.currentChunk;
  root.beforeClose = async (name) => {
    if (name === incomplete.fileName) throw new Error("synthetic quota-close failure");
  };
  await recorder.stop();
  assert.equal(recorder.status().state, "error");
  assert.match(recorder.status().lastError, /synthetic quota-close failure/);
  assert.equal(recorder.session.stoppedAt, null);
  assert.equal(incomplete.completedAt, null);
  assert.match(incomplete.closeError, /synthetic quota-close failure/);
  assert.equal(recorder.currentChunk, incomplete);
  assert.ok(incomplete.writable);
  const manifest = JSON.parse(new TextDecoder().decode(root.files.get(recorder.manifestFileName())));
  assert.equal(manifest.state, "error");
  assert.equal(manifest.stoppedAt, null);
  assert.equal(manifest.chunks[1].completedAt, null);
  assert.match(manifest.chunks[1].closeError, /synthetic quota-close failure/);
  const index = JSON.parse(new TextDecoder().decode(root.files.get("native-pcm-recordings-index.json")));
  assert.equal(index.sessions[manifest.sessionId].state, "error");
  assert.deepEqual(root.files.get(committed.fileName), committedBytes);

  const reloaded = storedRecorder(root).recorder;
  const recovered = (await reloaded.scanRecoverySessions()).sessions[0];
  assert.equal(recovered.state, "error");
  assert.equal(recovered.recoveredFrames, 2);
  assert.equal(recovered.exportableWav, true);
  assert.ok(recovered.warnings.some((warning) => warning.code === "chunk-close-failed"));
  const wav = await reloaded.exportRecoveredSelectedChannelWav(manifest.sessionId, 0);
  assert.equal(wav.blob.size, 44 + 2 * 4);
  await recorder.clear();
  assert.equal(recorder.state, "idle");
  assert.equal(root.files.has(incomplete.fileName), false);
});

test("a queued PCM failure during stop cannot become a clean stop", async () => {
  const { recorder, root } = storedRecorder();
  await recorder.start(stream);
  const gate = barrier();
  const entered = barrier();
  const original = root.getFileHandle;
  root.getFileHandle = async (name, options) => {
    const handle = await original(name, options);
    if (name.endsWith(".f32")) handle.createWritable = async () => ({
      async write() { entered.release(); await gate.promise; throw new Error("synthetic write failure"); },
      async close() {},
    });
    return handle;
  };
  const write = record(recorder);
  await entered.promise;
  const stop = recorder.stop();
  await turn();
  gate.release();
  await Promise.all([write, stop]);
  assert.equal(recorder.state, "error");
  assert.equal(recorder.session.stoppedAt, null);
});

test("independent sessions at the same instant have distinct artifacts and legacy recovery still exports", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
  const root = memoryStorage();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "storage");
  Object.defineProperty(navigator, "storage", { configurable: true, value: { getDirectory: async () => root } });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "storage", descriptor);
    else delete navigator.storage;
  });
  const a = storedRecorder(root).recorder;
  const b = storedRecorder(root).recorder;
  await a.start(stream);
  await record(a);
  await a.stop();
  const aFiles = new Map([...root.files].filter(([name]) => name.startsWith(a.session.sessionId)));
  await b.start(stream);
  await record(b);
  await b.stop();
  assert.notEqual(a.session.sessionId, b.session.sessionId);
  assert.notEqual(a.manifestFileName(), b.manifestFileName());
  assert.notEqual(a.session.chunks[0].fileName, b.session.chunks[0].fileName);
  for (const [name, bytes] of aFiles) assert.deepEqual(root.files.get(name), bytes);

  const legacyId = "native-pcm-2025-01-01T00-00-00-000Z";
  const legacy = a.buildManifest();
  legacy.sessionId = legacyId;
  legacy.manifestFileName = `${legacyId}-manifest.json`;
  legacy.chunkFilePrefix = `${legacyId}-chunk-`;
  legacy.chunks[0].fileName = `${legacyId}-chunk-00000.f32`;
  root.files.set(legacy.chunks[0].fileName, root.files.get(a.session.chunks[0].fileName));
  root.files.set(legacy.manifestFileName, new TextEncoder().encode(JSON.stringify(legacy)));
  const recovery = storedRecorder(root).recorder;
  const scan = await recovery.scanRecoverySessions();
  assert.equal(scan.sessions.length, 3);
  const old = scan.sessions.find((session) => session.sessionId === legacyId);
  assert.equal(old.state, "stopped");
  assert.equal(old.exportableWav, true);
  const wav = await recovery.exportRecoveredSelectedChannelWav(legacyId, 0);
  assert.equal(wav.blob.size, 44 + 2 * 4);
  const manifest = await recovery.exportRecoveredManifest(legacyId);
  assert.equal(JSON.parse(await manifest.blob.text()).sessionId, legacyId);
});

test("start can retry after an initial manifest commit fails", async () => {
  const { recorder, root } = storedRecorder();
  let fail = true;
  root.beforeClose = async (name) => {
    if (fail && name.endsWith("-manifest.json")) {
      fail = false;
      throw new Error("synthetic manifest failure");
    }
  };
  await assert.rejects(recorder.start(stream), /synthetic manifest failure/);
  assert.equal(recorder.state, "error");
  const index = JSON.parse(new TextDecoder().decode(root.files.get("native-pcm-recordings-index.json")));
  assert.equal(index.sessions[recorder.session.sessionId].state, "error");
  const manifest = JSON.parse(new TextDecoder().decode(root.files.get(recorder.manifestFileName())));
  assert.equal(manifest.state, "error");
  await recorder.start(stream);
  await record(recorder);
  await recorder.stop();
  assert.equal(recorder.state, "stopped");
  assert.equal(recorder.session.recordedBlocks, 1);
});

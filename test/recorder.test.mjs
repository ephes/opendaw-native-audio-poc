import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { PcmRecorder } from "../public/recorder.js";
import { inspectManifest } from "../scripts/inspect-recording-manifest.mjs";

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
import { barrier, memoryLocks, memoryStorage, record, stream } from "./fixtures/opfs.mjs";

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
  assert.deepEqual(manifest.chunkMetadata, { format: "per-chunk-v1", count: 1 });
  assert.equal(manifest.chunks.length, 1, "only the unclosed chunk stays inline");
  assert.equal(manifest.chunks[0].completedAt, null);
  assert.match(manifest.chunks[0].closeError, /synthetic quota-close failure/);
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

function navigatorProperty(t, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, key);
  Object.defineProperty(navigator, key, { configurable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, key, descriptor);
    else delete navigator[key];
  });
}

beforeEach((t) => navigatorProperty(t, "locks", memoryLocks()));

function pauseIndexRead(recorder) {
  const entered = barrier(), resume = barrier();
  const read = recorder.readIndex.bind(recorder);
  let paused = false;
  recorder.readIndex = async () => {
    const result = await read();
    if (!paused) { paused = true; entered.release(); await resume.promise; }
    return result;
  };
  return { entered, resume };
}

test("independent recorder index additions reload under an origin-wide lock", async () => {
  const root = memoryStorage();
  const a = storedRecorder(root).recorder, b = storedRecorder(root).recorder;
  const { entered, resume } = pauseIndexRead(a);
  const first = a.start(stream);
  await entered.promise;
  const second = b.start(stream);
  await turn();
  resume.release();
  await Promise.all([first, second]);
  const { index } = await a.readIndex();
  assert.deepEqual(Object.keys(index.sessions).sort(), [a.session.sessionId, b.session.sessionId].sort());
});

test("an index update cannot resurrect a concurrently deleted entry", async () => {
  const root = memoryStorage();
  const a = storedRecorder(root).recorder, b = storedRecorder(root).recorder;
  await a.start(stream); await a.stop();
  await b.start(stream); await b.stop();
  const { entered, resume } = pauseIndexRead(a);
  const update = a.updateIndexSession("stopped");
  await entered.promise;
  const deletion = b.deleteIndexSession(b.session.sessionId);
  await turn();
  resume.release();
  await Promise.all([update, deletion]);
  const { index } = await a.readIndex();
  assert.deepEqual(Object.keys(index.sessions), [a.session.sessionId]);
});

test("a failed index commit releases its lock for another recorder", async () => {
  const root = memoryStorage();
  const a = storedRecorder(root).recorder, b = storedRecorder(root).recorder;
  await a.start(stream); await a.stop();
  const original = root.beforeClose;
  root.beforeClose = async (name) => {
    if (name === "native-pcm-recordings-index.json") {
      root.beforeClose = original;
      throw new Error("synthetic index commit failure");
    }
  };
  await assert.rejects(a.updateIndexSession("stopped"), /synthetic index commit failure/);
  await b.start(stream);
  const { index } = await b.readIndex();
  assert.deepEqual(Object.keys(index.sessions).sort(), [a.session.sessionId, b.session.sessionId].sort());
});

test("missing Web Locks explicitly refuses an unprotected index mutation", async (t) => {
  Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
  const { recorder, root } = storedRecorder();
  await assert.rejects(recorder.start(stream), /Web Locks.*unavailable/);
  assert.equal(root.files.has("native-pcm-recordings-index.json"), false);
});

for (const transition of ["reset", "start", "delete"]) {
  test(`WAV export retains its session while ${transition} waits for file reads`, async (t) => {
    const { recorder, root } = storedRecorder();
    navigatorProperty(t, "storage", { getDirectory: async () => root });
    await recorder.start(stream); await record(recorder); await recorder.stop();
    const oldId = recorder.session.sessionId;
    const entered = barrier(), resume = barrier();
    const getHandle = root.getFileHandle.bind(root);
    let paused = false;
    root.getFileHandle = async (name, options) => {
      const handle = await getHandle(name, options);
      if (name.endsWith(".f32") && !paused) {
        const getFile = handle.getFile.bind(handle);
        handle.getFile = async () => { paused = true; const file = await getFile(); entered.release(); await resume.promise; return file; };
      }
      return handle;
    };
    const exporting = recorder.exportSelectedChannelWav(0);
    await entered.promise;
    const action = transition === "reset" ? recorder.clear()
      : transition === "start" ? recorder.start(stream) : recorder.deleteRecoveredSession(oldId);
    let finished = false;
    action.then(() => { finished = true; });
    await turn();
    try { assert.equal(finished, false); } finally { resume.release(); }
    const [wav] = await Promise.all([exporting, action]);
    assert.equal(wav.filename, `${oldId}-ch01.wav`);
    const buffer = await wav.blob.arrayBuffer();
    assert.equal(new DataView(buffer).getUint32(40, true), 8);
    assert.deepEqual([...new Float32Array(buffer, 44)], [0.25, 0.75]);
  });
}

test("manifest export holds its session until serialization finishes", async () => {
  const { recorder, root } = storedRecorder();
  await recorder.start(stream); await record(recorder); await recorder.stop();
  const oldId = recorder.session.sessionId;
  const entered = barrier(), resume = barrier();
  root.beforeClose = async (name) => {
    if (name.endsWith("-manifest.json")) { entered.release(); await resume.promise; }
  };
  const exporting = recorder.exportManifest();
  await entered.promise;
  const reset = recorder.clear();
  let cleared = false;
  reset.then(() => { cleared = true; });
  await turn();
  try { assert.equal(cleared, false); } finally { resume.release(); }
  const [result] = await Promise.all([exporting, reset]);
  assert.equal(result.filename, `${oldId}-manifest.json`);
  const manifest = JSON.parse(await result.blob.text());
  assert.equal(manifest.sessionId, oldId);
  assert.equal(manifest.totalRecordedFrames, 2);
});

for (const format of ["wav", "manifest"]) {
  test(`recovered ${format} export finishes before queued deletion`, async (t) => {
    const { recorder, root } = storedRecorder();
    navigatorProperty(t, "storage", { getDirectory: async () => root });
    await recorder.start(stream); await record(recorder); await recorder.stop();
    const oldId = recorder.session.sessionId;
    const entered = barrier(), resume = barrier();
    const getHandle = root.getFileHandle.bind(root);
    let paused = false;
    root.getFileHandle = async (name, options) => {
      const handle = await getHandle(name, options);
      if (name.endsWith("-manifest.json") && !paused) {
        const getFile = handle.getFile.bind(handle);
        handle.getFile = async () => {
          paused = true; const file = await getFile(); entered.release(); await resume.promise; return file;
        };
      }
      return handle;
    };
    const exporting = format === "wav" ? recorder.exportRecoveredSelectedChannelWav(oldId, 0)
      : recorder.exportRecoveredManifest(oldId);
    await entered.promise;
    const deletion = recorder.deleteRecoveredSession(oldId);
    let deleted = false;
    deletion.then(() => { deleted = true; });
    await turn();
    try { assert.equal(deleted, false); } finally { resume.release(); }
    const [result] = await Promise.all([exporting, deletion]);
    assert.equal(result.filename, `${oldId}-recovered-${format === "wav" ? "ch01.wav" : "manifest.json"}`);
    if (format === "wav") {
      assert.deepEqual([...new Float32Array(await result.blob.arrayBuffer(), 44)], [0.25, 0.75]);
    } else {
      assert.equal(JSON.parse(await result.blob.text()).sessionId, oldId);
    }
  });
}

test("a rejected export releases the lifecycle queue for reset", async () => {
  const { recorder } = storedRecorder();
  await recorder.start(stream); await record(recorder); await recorder.stop();
  await assert.rejects(recorder.exportSelectedChannelWav(99), /outside/);
  await recorder.clear();
  assert.equal(recorder.state, "idle");
});

for (const action of ["reset", "delete"]) {
  test(`a corrupt discovery index protects ${action} until explicit catalog repair`, async (t) => {
    const { recorder, root } = storedRecorder();
    navigatorProperty(t, "storage", { getDirectory: async () => root });
    await recorder.start(stream); await record(recorder); await recorder.stop();
    const oldId = recorder.session.sessionId;
    root.files.set("native-pcm-recordings-index.json", new TextEncoder().encode("synthetic invalid index"));
    const savedFiles = new Map(root.files);
    await assert.rejects(action === "reset" ? recorder.clear() : recorder.deleteRecoveredSession(oldId), /index is read-only/);
    assert.deepEqual(root.files, savedFiles);
    assert.equal(recorder.state, "stopped");
    // Explicit repair after saving the damaged catalog; never an automatic fallback.
    root.files.delete("native-pcm-recordings-index.json");
    if (action === "reset") await recorder.clear();
    else await recorder.deleteRecoveredSession(oldId);
    assert.equal(recorder.state, "idle");
    assert.equal([...root.files.keys()].some((name) => name.startsWith(oldId)), false);
    await recorder.start(stream);
    assert.equal(root.files.has(`${oldId}-manifest.json`), false);
  });
}

for (const action of ["reset", "delete"]) {
  test(`missing locks refuse ${action} before removing session artifacts`, async (t) => {
    const { recorder, root } = storedRecorder();
    navigatorProperty(t, "storage", { getDirectory: async () => root });
    await recorder.start(stream); await record(recorder); await recorder.stop();
    const files = new Map(root.files);
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await assert.rejects(action === "reset" ? recorder.clear()
      : recorder.deleteRecoveredSession(recorder.session.sessionId), /Web Locks.*unavailable/);
    assert.equal(recorder.state, "stopped");
    assert.deepEqual(root.files, files);
  });
}

for (const format of ["wav", "manifest"]) {
  test(`recovered ${format} export during recording refuses before IO and cannot delay Stop`, async (t) => {
    const root = memoryStorage();
    navigatorProperty(t, "storage", { getDirectory: async () => root });
    const old = storedRecorder(root).recorder, active = storedRecorder(root).recorder;
    await old.start(stream); await record(old); await old.stop();
    await active.start(stream); await record(active);
    const resume = barrier();
    let reads = 0, error;
    const find = active.findRecoveredSession.bind(active);
    active.findRecoveredSession = async (id) => { reads++; await resume.promise; return find(id); };
    const exporting = (format === "wav" ? active.exportRecoveredSelectedChannelWav(old.session.sessionId, 0)
      : active.exportRecoveredManifest(old.session.sessionId)).catch((caught) => { error = caught; });
    const stopping = active.stop();
    await turn();
    const stateBeforeReadReleased = active.state;
    resume.release();
    await Promise.all([exporting, stopping]);
    assert.equal(stateBeforeReadReleased, "stopped");
    assert.equal(reads, 0);
    assert.match(error?.message ?? "", /Stop recording before exporting recovery artifacts/);
    assert.equal(active.session.totalRecordedFrames, 2);
  });
}

test("an index write error aborts the writable and another recorder can proceed", async () => {
  const root = memoryStorage();
  const a = storedRecorder(root).recorder, b = storedRecorder(root).recorder;
  await a.start(stream); await a.stop();
  const getHandle = root.getFileHandle.bind(root);
  let fail = true, aborted = 0;
  root.getFileHandle = async (name, options) => {
    const handle = await getHandle(name, options);
    if (name === "native-pcm-recordings-index.json" && fail) {
      const create = handle.createWritable.bind(handle);
      handle.createWritable = async () => ({
        ...await create(),
        async write() { fail = false; throw new Error("synthetic index write failure"); },
        async abort() { aborted++; },
      });
    }
    return handle;
  };
  await assert.rejects(a.updateIndexSession("stopped"), /synthetic index write failure/);
  assert.equal(aborted, 1);
  await b.start(stream);
  assert.equal(Object.keys((await b.readIndex()).index.sessions).length, 2);
});

for (const failure of ["lock", "index"]) {
  test(`a failed Start ${failure} step preserves the previous stopped recording`, async () => {
    const { recorder, root } = storedRecorder();
    await recorder.start(stream); await record(recorder); await recorder.stop();
    const previousSession = recorder.session;
    const files = new Map(root.files);
    const locks = navigator.locks;
    if (failure === "lock") Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    else root.beforeClose = async (name) => {
      if (name === "native-pcm-recordings-index.json") throw new Error("synthetic index failure");
    };
    await assert.rejects(recorder.start(stream), /Web Locks|synthetic index failure/);
    assert.equal(recorder.session, previousSession);
    assert.equal(recorder.state, "stopped");
    assert.equal(recorder.session.state, "stopped");
    assert.deepEqual(root.files, files);
    Object.defineProperty(navigator, "locks", { configurable: true, value: locks });
    root.beforeClose = undefined;
    await recorder.start(stream);
    assert.equal(recorder.state, "recording");
    assert.notEqual(recorder.session, previousSession);
  });
}

test("pending PCM ceiling refuses overflow and drains admitted audio as incomplete", async () => {
  const { recorder, root } = storedRecorder();
  await recorder.start({ ...stream, channels: 64, framesPerBlock: 65536 });
  recorder.recordBlock({ frameStart: 0, frameCount: 2, channels: 64, receivedBlockIndex: 0,
    dataBytes: new Uint8Array(2 * 64 * 4) });
  await recorder.writeChain;
  await recorder.closeCurrentChunk();
  const committed = root.files.get(recorder.session.chunks[0].fileName).slice();
  const gate = barrier();
  const entered = barrier();
  const getHandle = root.getFileHandle.bind(root);
  root.getFileHandle = async (name, options) => {
    const handle = await getHandle(name, options);
    if (name.endsWith(".f32")) {
      const create = handle.createWritable;
      handle.createWritable = async () => {
        const writer = await create();
        return { ...writer, async write(data) { entered.release(); await gate.promise; await writer.write(data); } };
      };
    }
    return handle;
  };
  const dataBytes = new Uint8Array(65536 * 64 * 4);
  // Valid maximum-size blocks; four fill the 64 MiB pending budget exactly.
  for (let i = 0; i < 4; i++) recorder.recordBlock({ frameStart: 2 + i * 65536,
    frameCount: 65536, channels: 64, receivedBlockIndex: i + 1, dataBytes: dataBytes.slice() });
  await entered.promise;
  assert.equal(recorder.pendingWriteBytes, 64 * 1024 * 1024);
  for (let i = 0; i < 50; i++) recorder.recordBlock({ frameStart: 262146,
    frameCount: 65536, channels: 64, receivedBlockIndex: 5, dataBytes });
  assert.equal(recorder.pendingWriteBytes, 64 * 1024 * 1024);
  assert.notEqual(recorder.state, "recording");
  gate.release();
  await recorder.lifecycleChain;
  await recorder.stop();
  assert.equal(recorder.pendingWriteBytes, 0);
  assert.equal(recorder.pendingWriteBlocks, 0);
  assert.equal(recorder.state, "error");
  assert.equal(recorder.session.stoppedAt, null);
  assert.equal(recorder.currentChunk, null);
  assert.equal(recorder.session.recordedBlocks, 5);
  assert.match(recorder.lastError, /pending PCM.*ceiling/i);
  assert.deepEqual(root.files.get(recorder.session.chunks[0].fileName), committed);
  const saved = JSON.parse(await (await getHandle(recorder.manifestFileName())).getFile().then(f => f.text()));
  assert.equal(saved.state, "error");
  assert.equal(saved.stoppedAt, null);
});

test("integrity diagnostics retain first and recent samples with exact totals", async () => {
  const { recorder } = storedRecorder();
  await recorder.start(stream);
  for (let i = 0; i < 1000; i++) {
    recorder.noteInvalidBlock(`invalid-${i}`);
    recorder.noteChannelMismatch({ frameStart: i, expectedChannels: 2, actualChannels: 3 });
    recorder.noteWebSocketLag({ code: "lag", message: `lag-${i}` });
    recorder.auditTimeline({ frameStart: i * 4, frameCount: 2 });
    recorder.setNativeInputStats({ nativeDroppedBlocks: i + 1 });
  }
  await record(recorder, 4000);
  await recorder.stop();
  const manifest = recorder.buildManifest();
  for (const name of ["invalidBlocks", "channelMismatches", "websocketLagEvents", "gaps", "discontinuities"]) {
    const total = 1000;
    assert.equal(manifest.integrity[name].length, 32);
    assert.equal(manifest.integrity.eventCounts[name], total);
    assert.equal(manifest.integrity.omittedCounts[name], total - 32);
    assert.equal(recorder.status()[name], total);
  }
  assert.equal(manifest.integrity.invalidBlocks[0].reason, "invalid-0");
  assert.equal(manifest.integrity.invalidBlocks.at(-1).reason, "invalid-999");
  assert.equal(manifest.nativeInputStats.events.length, 32);
  assert.equal(manifest.nativeInputStats.eventCounts.events, 1000);
  assert.equal(manifest.nativeInputStats.omittedCounts.events, 968);
  const inspection = inspectManifest(manifest);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.summary.continuity.invalidBlocks, 1000);
});

test("chunk checkpoints serialize each block once and reload complete timeline evidence", async (t) => {
  const { recorder, root } = storedRecorder();
  navigatorProperty(t, "storage", { getDirectory: async () => root });
  const writes = [];
  const original = root.getFileHandle;
  root.getFileHandle = async (name, options) => {
    const handle = await original(name, options);
    const createWritable = handle.createWritable;
    handle.createWritable = async () => {
      const writable = await createWritable();
      const write = writable.write;
      writable.write = async (data) => {
        if (typeof data === "string" && name !== "native-pcm-recordings-index.json") writes.push(data);
        await write(data);
      };
      return writable;
    };
    return handle;
  };
  await recorder.start(stream);
  for (let chunk = 0; chunk < 24; chunk += 1) {
    for (let block = 0; block < 3; block += 1) await record(recorder, (chunk * 3 + block) * 2);
    await recorder.closeCurrentChunk();
  }
  const blockVisits = writes.reduce((sum, json) => sum + (json.match(/"frameCount"/g) ?? []).length, 0);
  assert.equal(blockVisits, 72, "closed block metadata must be serialized only once during checkpoints");
  const expected = recorder.buildManifest().chunks;
  const reloaded = storedRecorder(root).recorder;
  const recovered = (await reloaded.scanRecoverySessions()).sessions[0];
  assert.equal(recovered.state, "abandoned");
  assert.equal(recovered.recoveredFrames, 144);
  assert.equal(recovered.exportableWav, true);
  assert.deepEqual(recovered.originalManifest.chunks, expected);
  await recorder.stop();
  const stopped = JSON.parse(new TextDecoder().decode(root.files.get(recorder.manifestFileName())));
  assert.deepEqual(stopped.chunkMetadata, { format: "per-chunk-v1", count: 24 });
  assert.deepEqual(stopped.chunks, [], "the OPFS stop manifest references committed sidecars");
  const afterStop = (await storedRecorder(root).recorder.scanRecoverySessions()).sessions[0];
  assert.equal(afterStop.state, "stopped");
  assert.deepEqual(afterStop.originalManifest.chunks, expected);
  assert.deepEqual(JSON.parse(await (await recorder.exportManifest()).blob.text()).chunks, expected);
  await recorder.clear();
  assert.deepEqual([...root.files.keys()], ["native-pcm-recordings-index.json"]);
});

test("missing or mismatched checkpoint metadata refuses recovered WAV and leaves healthy siblings accessible", async (t) => {
  const { recorder, root } = storedRecorder();
  navigatorProperty(t, "storage", { getDirectory: async () => root });
  await recorder.start(stream);
  await record(recorder);
  await recorder.closeCurrentChunk();
  const sessionId = recorder.session.sessionId;
  const metadataName = `${recorder.session.chunks[0].fileName}.json`;
  const metadataBytes = root.files.get(metadataName);
  const healthy = storedRecorder(root).recorder;
  await healthy.start(stream);
  await record(healthy);
  await healthy.stop();
  for (const corrupt of [null, new TextEncoder().encode('{"fileName":"unrelated","index":0}')]) {
    if (corrupt) root.files.set(metadataName, corrupt);
    else root.files.delete(metadataName);
    const reloaded = storedRecorder(root).recorder;
    const sessions = (await reloaded.scanRecoverySessions()).sessions;
    const broken = sessions.find((entry) => entry.sessionId === sessionId);
    assert.equal(broken.state, "error");
    assert.equal(broken.exportableWav, false);
    assert.ok(broken.warnings.some((entry) => entry.code === "chunk-metadata-read-error" && entry.fatal));
    await assert.rejects(reloaded.exportRecoveredSelectedChannelWav(sessionId, 0), /metadata could not be read/);
    assert.equal(sessions.find((entry) => entry.sessionId === healthy.session.sessionId).exportableWav, true);
  }
  root.files.set(metadataName, metadataBytes);
  await storedRecorder(root).recorder.deleteRecoveredSession(sessionId);
  assert.equal(root.files.has(metadataName), false);
  assert.equal(root.files.has(healthy.manifestFileName()), true);
});

test("selected-channel WAV export refuses non-integer channel indexes at both boundaries", async (t) => {
  const { recorder, root } = storedRecorder();
  navigatorProperty(t, "storage", { getDirectory: async () => root });
  await recorder.start(stream);
  await record(recorder);
  await recorder.stop();
  const sessionId = recorder.session.sessionId;
  const reloaded = storedRecorder(root).recorder;
  for (const channelIndex of [0.5, 1.5, Number.NaN, -1, 2, "0", null, undefined]) {
    await assert.rejects(recorder.exportSelectedChannelWav(channelIndex), /outside the recorded channel range/,
      String(channelIndex));
    await assert.rejects(reloaded.exportRecoveredSelectedChannelWav(sessionId, channelIndex),
      /outside the recovered channel range/, String(channelIndex));
  }
  const live = await recorder.exportSelectedChannelWav(1);
  const recovered = await reloaded.exportRecoveredSelectedChannelWav(sessionId, 1);
  for (const wav of [live, recovered]) {
    const samples = new Float32Array((await wav.blob.arrayBuffer()).slice(44));
    assert.deepEqual([...samples], [-0.5, -1]);
  }
});

test("monitor counter rebaselines preserve whole-session underrun and overflow totals", async () => {
  const counters = { underruns: 5, overflows: 2, receivedBlocks: 0 };
  const root = memoryStorage();
  const recorder = new PcmRecorder({ readCounters: () => ({ ...counters }), postMessage: () => {} });
  recorder.openStorageRoot = async () => root;
  await recorder.start(stream);
  counters.underruns = 8;
  counters.overflows = 3;
  recorder.rebaselineCounters("monitor-start-reset");
  counters.underruns = 0;
  counters.overflows = 0;
  recorder.rebaselineCounters("monitor-start-reset");
  counters.underruns = 4;
  counters.overflows = 1;
  assert.equal(recorder.status().underrunsDuringRecording, 7);
  assert.equal(recorder.status().overflowsDuringRecording, 2);
  await recorder.stop();
  const manifest = recorder.buildManifest();
  assert.deepEqual(manifest.counterDeltasAtStop, { underrunsDuringRecording: 7, overflowsDuringRecording: 2 });
  assert.deepEqual(manifest.counterEpochTotals, { underruns: 3, overflows: 1 });
  assert.deepEqual(manifest.integrity.counterResets.map((entry) => entry.closedEpochDeltas), [
    { underruns: 3, overflows: 1 },
    { underruns: 0, overflows: 0 },
  ]);
  assert.equal(inspectManifest(manifest).summary.counters.underrunsDuringRecording, 7);
});

function oversizedFile(size) {
  return {
    size,
    async text() { throw new Error("over-budget JSON must not be materialized"); },
    async arrayBuffer() { throw new Error("over-budget JSON must not be materialized"); },
  };
}

function replaceFile(root, predicate, file) {
  const getHandle = root.getFileHandle.bind(root);
  root.getFileHandle = async (name, options) => {
    const handle = await getHandle(name, options);
    return predicate(name) ? { ...handle, getFile: async () => file } : handle;
  };
}

test("recovery refuses over-budget OPFS JSON before reading its text", async (t) => {
  for (const target of ["index", "manifest", "sidecar"]) {
    const { recorder, root } = storedRecorder();
    navigatorProperty(t, "storage", { getDirectory: async () => root });
    await recorder.start(stream);
    await record(recorder);
    await recorder.closeCurrentChunk();
    const sessionId = recorder.session.sessionId;
    const sidecar = `${recorder.session.chunks[0].fileName}.json`;
    const manifestName = recorder.manifestFileName();
    if (target === "index") {
      replaceFile(root, (name) => name === "native-pcm-recordings-index.json", oversizedFile(16 * 1024 * 1024 + 1));
    } else if (target === "manifest") {
      replaceFile(root, (name) => name === manifestName, oversizedFile(256 * 1024 * 1024 + 1));
    } else {
      replaceFile(root, (name) => name === sidecar, oversizedFile(64 * 1024 * 1024 + 1));
    }
    const reloaded = storedRecorder(root).recorder;
    const session = (await reloaded.scanRecoverySessions()).sessions.find((entry) => entry.sessionId === sessionId);
    assert.ok(session, target);
    const budgetWarning = session.warnings.find((entry) => /recovery budget/.test(entry.message));
    assert.ok(budgetWarning, target);
    if (target === "sidecar") {
      assert.equal(budgetWarning.code, "chunk-metadata-read-error");
      assert.equal(budgetWarning.fatal, true);
      assert.equal(session.exportableWav, false);
    } else {
      assert.notEqual(budgetWarning.fatal, true, target);
      assert.equal(session.exportableWav, true, target);
      assert.equal(session.recoveredFrames, 2, target);
    }
  }
});

test("recovery refuses deeply nested and oversized-collection JSON", async (t) => {
  const { recorder, root } = storedRecorder();
  navigatorProperty(t, "storage", { getDirectory: async () => root });
  await recorder.start(stream);
  await record(recorder);
  await recorder.stop();
  const sessionId = recorder.session.sessionId;
  const manifestName = recorder.manifestFileName();
  const original = JSON.parse(new TextDecoder().decode(root.files.get(manifestName)));
  const nested = { ...original, summary: JSON.parse(`${"[".repeat(40)}${"]".repeat(40)}`) };
  const tooManyChunks = { ...original, chunks: Array.from({ length: 10_001 }, () => 0) };
  for (const [label, manifest, pattern] of [
    ["nested", nested, /nests deeper than 16 levels/],
    ["chunks", tooManyChunks, /10001 chunks exceed the 10000 chunk budget/],
  ]) {
    root.files.set(manifestName, new TextEncoder().encode(JSON.stringify(manifest)));
    const session = (await storedRecorder(root).recorder.scanRecoverySessions()).sessions
      .find((entry) => entry.sessionId === sessionId);
    const warning = session.warnings.find((entry) => entry.code === "manifest-read-error");
    assert.match(warning?.message ?? "", pattern, label);
    assert.equal(session.manifestPresent, false, label);
  }
  const index = JSON.parse(new TextDecoder().decode(root.files.get("native-pcm-recordings-index.json")));
  index.sessions = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`s${i}`, {}]));
  root.files.set("native-pcm-recordings-index.json", new TextEncoder().encode(JSON.stringify(index)));
  const scan = await storedRecorder(root).recorder.scanRecoverySessions();
  assert.equal(scan.sessions.length, 1);
  assert.ok(scan.sessions[0].warnings.some((entry) => /10001 sessions exceed/.test(entry.message)));
});

test("an unreadable manifest still detects a missing middle chunk from the index and sidecars", async (t) => {
  for (const evidence of ["index", "sidecars"]) {
    const { recorder, root } = storedRecorder();
    navigatorProperty(t, "storage", { getDirectory: async () => root });
    await recorder.start(stream);
    for (let chunk = 0; chunk < 3; chunk += 1) {
      await record(recorder, chunk * 2);
      await recorder.closeCurrentChunk();
    }
    await recorder.stop();
    const sessionId = recorder.session.sessionId;
    const middle = recorder.session.chunks[1].fileName;
    root.files.set(recorder.manifestFileName(), new TextEncoder().encode("{truncated"));
    root.files.delete(middle);
    if (evidence === "sidecars") {
      root.files.delete("native-pcm-recordings-index.json");
    }
    const session = (await storedRecorder(root).recorder.scanRecoverySessions()).sessions
      .find((entry) => entry.sessionId === sessionId);
    assert.ok(session.warnings.some((entry) => entry.code === "manifest-read-error"), evidence);
    assert.ok(session.chunks.some((chunk) => chunk.fileName === middle && !chunk.present), evidence);
    assert.equal(session.exportableWav, false, evidence);
    if (evidence === "index") {
      assert.equal(session.nonExportableReason, "one or more chunk files are missing");
    }
  }
});

test("chunks roll over at the block cap so their metadata stays within the recovery budget", async () => {
  const { recorder } = storedRecorder();
  await recorder.start(stream);
  for (let block = 0; block < 65_537; block += 1) {
    recorder.recordBlock({
      frameStart: block * 2, frameCount: 2, channels: 2, receivedBlockIndex: block,
      dataBytes: new Uint8Array(16),
    });
  }
  await recorder.writeChain;
  assert.deepEqual(recorder.session.chunks.map((chunk) => chunk.blocksRecorded), [65_536, 1]);
  assert.equal(recorder.session.storage.maxBlocksPerChunk, 65_536);
  await recorder.stop();
});

test("a session with only leftover metadata sidecars is listed and deletable", async (t) => {
  const { recorder, root } = storedRecorder();
  navigatorProperty(t, "storage", { getDirectory: async () => root });
  await recorder.start(stream);
  await record(recorder);
  await recorder.stop();
  const sessionId = recorder.session.sessionId;
  const sidecar = `${recorder.session.chunks[0].fileName}.json`;
  for (const name of [...root.files.keys()]) {
    if (name !== sidecar) root.files.delete(name);
  }
  const reloaded = storedRecorder(root).recorder;
  const session = (await reloaded.scanRecoverySessions()).sessions.find((entry) => entry.sessionId === sessionId);
  assert.ok(session);
  assert.equal(session.exportableWav, false);
  await reloaded.deleteRecoveredSession(sessionId);
  assert.equal(root.files.has(sidecar), false);
});

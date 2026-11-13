import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { PcmRecorder } from "../public/recorder.js";
import { barrier, memoryLocks, memoryStorage, record, stream } from "./fixtures/opfs.mjs";

const INDEX = "native-pcm-recordings-index.json";
const INDEX_TYPE = "opendaw-native-audio-poc-recording-index";
const encoder = new TextEncoder();
const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));
const catalog = (sessions = {}) => ({ type: INDEX_TYPE, version: 1, sessions });
const turn = () => new Promise((resolve) => setImmediate(resolve));

beforeEach((t) => {
  const root = memoryStorage();
  for (const [key, value] of Object.entries({ locks: memoryLocks(), storage: { getDirectory: async () => root } })) {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, key);
    Object.defineProperty(navigator, key, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(navigator, key, descriptor) : delete navigator[key]);
  }
});

function fixture(root = memoryStorage()) {
  const recorder = new PcmRecorder({
    readCounters: () => ({ underruns: 0, overflows: 0, receivedBlocks: 0 }), postMessage() {},
  });
  recorder.root = root;
  recorder.openStorageRoot = async () => root;
  return { recorder, root };
}

for (const failure of ["malformed", "shape", "read", "permission", "getFile-not-found"]) {
  test(`unreadable catalog (${failure}) protects bytes through Start and Delete`, async () => {
    const { recorder, root } = fixture();
    const id = "native-pcm-saved";
    const bytes = encoder.encode(failure === "malformed" ? "{truncated" : failure === "shape" ? '{"sessions":[]}' : JSON.stringify(catalog({ [id]: {} })));
    root.files.set(INDEX, bytes);
    root.files.set(`${id}-manifest.json`, encoder.encode("{}"));
    const getHandle = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, options) => {
      if (name === INDEX && !["malformed", "shape"].includes(failure) && !options?.create) {
        if (failure === "permission") throw new DOMException("Denied", "NotAllowedError");
        const handle = await getHandle(name, options);
        handle.getFile = async () => { throw new DOMException("Synthetic read failure", failure === "getFile-not-found" ? "NotFoundError" : "NotReadableError"); };
        return handle;
      }
      return getHandle(name, options);
    };
    const before = [...root.files.keys()].sort();
    for (let attempt = 0; attempt < 2; attempt++) {
      // A refused Start creates no session or artifact and leaves Start/Reset usable.
      await assert.rejects(recorder.start(stream), /index.*read-only/i);
      assert.deepEqual([...root.files.keys()].sort(), before);
      assert.equal(recorder.session, null);
      assert.equal(recorder.state, "idle");
    }
    await recorder.clear({ silent: true });
    assert.equal(recorder.state, "idle");
    await assert.rejects(recorder.deleteRecoveredSession(id), /index.*read-only/i);
    assert.deepEqual(root.files.get(INDEX), bytes);
    assert.ok(root.files.has(`${id}-manifest.json`));
    const scan = await recorder.scanRecoverySessions();
    assert.ok(scan.sessions.find((s) => s.sessionId === id).warnings.some((w) => w.code === "index-warning"));
  });
}

test("catalog turning read-only mid-recording keeps capture and a clean stop", async () => {
  const { recorder, root } = fixture();
  await recorder.start(stream);
  const id = recorder.session.sessionId;
  const bytes = encoder.encode(JSON.stringify({ ...catalog({ [id]: {} }), version: 2 }));
  root.files.set(INDEX, bytes);
  await record(recorder);
  await record(recorder, 2);
  await recorder.stop();
  assert.equal(recorder.state, "stopped");
  assert.equal(recorder.lastError, "");
  assert.deepEqual(root.files.get(INDEX), bytes);
  const manifest = decode(root.files.get(`${id}-manifest.json`));
  assert.equal(manifest.state, "stopped");
  assert.equal(manifest.totalRecordedFrames, 4);
  assert.ok(manifest.indexWarnings.length >= 1 && manifest.indexWarnings.length <= 20);
  assert.match(manifest.indexWarnings[0], /index not updated.*read-only/i);
});

test("absent catalog can be created", async () => {
  const { recorder, root } = fixture();
  await recorder.start(stream);
  assert.ok(decode(root.files.get(INDEX)).sessions[recorder.session.sessionId]);
});

test("catalog write session budget admits exactly 10000 and preserves bytes above it", async () => {
  const { recorder, root } = fixture();
  const sessions = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`native-pcm-${i}`, {}]));
  await recorder.writeIndex(catalog(sessions));
  assert.equal(Object.keys((await recorder.readIndex()).index.sessions).length, 10000);
  const bytes = root.files.get(INDEX).slice();
  await assert.rejects(recorder.mutateIndex((index) => { index.sessions.extra = {}; }), /session budget/);
  assert.deepEqual(root.files.get(INDEX), bytes);
});

test("catalog encoded byte budget admits exact boundary and refuses before writable creation", async () => {
  const { recorder, root } = fixture();
  const index = { ...catalog(), updatedAt: new Date().toISOString(), padding: "" };
  const limit = 16 * 1024 * 1024;
  const overhead = encoder.encode(JSON.stringify(index, null, 2)).length;
  index.padding = "é".repeat(Math.floor((limit - overhead) / 2)) + "x".repeat((limit - overhead) % 2);
  await recorder.writeIndex(index);
  assert.equal(root.files.get(INDEX).byteLength, limit);
  assert.equal((await recorder.readIndex()).warnings.length, 0);
  const bytes = root.files.get(INDEX).slice();
  let creates = 0;
  const getHandle = root.getFileHandle.bind(root);
  root.getFileHandle = async (name, options) => { if (options?.create) creates += 1; return getHandle(name, options); };
  index.padding += "x";
  await assert.rejects(recorder.writeIndex(index), /byte budget/);
  assert.equal(creates, 0);
  assert.deepEqual(root.files.get(INDEX), bytes);
});

test("catalog writer refuses a generation its reader would reject for nesting", async () => {
  const { recorder, root } = fixture();
  await recorder.writeIndex(catalog());
  const bytes = root.files.get(INDEX).slice();
  const index = { ...catalog(), extra: JSON.parse(`${"[".repeat(16)}0${"]".repeat(16)}`) };
  await assert.rejects(recorder.writeIndex(index), /nests deeper/);
  assert.deepEqual(root.files.get(INDEX), bytes);
});

for (const metadata of [{ type: INDEX_TYPE, version: 2 }, { type: "future-other-catalog", version: 1 }, { version: 1 }, { type: INDEX_TYPE }]) {
  test(`unsupported catalog ${JSON.stringify(metadata)} stays read-only`, async () => {
    const { recorder, root } = fixture();
    const bytes = encoder.encode(JSON.stringify({ ...metadata, sessions: { "native-pcm-saved": {} }, future: { retained: true } }));
    root.files.set(INDEX, bytes);
    const read = await recorder.readIndex();
    assert.equal(read.writable, false);
    assert.match(read.warnings.join(" "), /unsupported.*type\/version/i);
    await assert.rejects(recorder.start(stream), /index is read-only/);
    await assert.rejects(recorder.deleteIndexSession("native-pcm-saved"), /index is read-only/);
    await assert.rejects(recorder.writeIndex({ ...metadata, sessions: {} }), /unsupported.*type\/version/i);
    assert.deepEqual(root.files.get(INDEX), bytes);
  });
}

test("known catalog mutations preserve extension metadata", async () => {
  const { recorder, root } = fixture();
  root.files.set(INDEX, encoder.encode(JSON.stringify({ ...catalog(), extension: { retained: true } })));
  await recorder.mutateIndex((index) => { index.sessions["native-pcm-saved"] = {}; });
  assert.deepEqual(decode(root.files.get(INDEX)).extension, { retained: true });
});

test("recovery bounds every directory entry and refuses deletion of an incomplete inventory", async () => {
  const { recorder, root } = fixture();
  await recorder.start(stream); await record(recorder); await recorder.stop();
  const id = recorder.session.sessionId;
  const files = new Map(root.files);
  const entries = root.entries.bind(root);
  let visits = 0;
  root.entries = async function* () {
    for await (const entry of entries()) { visits++; yield entry; }
    for (let i = 0; i < 60000; i++) { visits++; yield [`unrelated-${i}`, { kind: "file" }]; }
  };
  const scan = await recorder.scanRecoverySessions();
  assert.equal(scan.complete, false);
  assert.ok(visits <= 50001);
  assert.match(scan.error, /incomplete.*50000/i);
  const recovered = scan.sessions.find((s) => s.sessionId === id);
  assert.ok(recovered);
  assert.ok(recovered.warnings.some((w) => w.code === "scan-incomplete" && /50000/.test(w.message)));
  assert.ok(!recovered.warnings.some((w) => w.code === "index-warning"));
  await assert.rejects(recorder.deleteRecoveredSession(id), /incomplete/i);
  assert.deepEqual(root.files, files);
});

test("recovery caps the union of indexed and orphan sessions", async () => {
  const { recorder, root } = fixture();
  root.files.set(INDEX, encoder.encode(JSON.stringify(catalog({ "native-pcm-indexed": {} }))));
  let visits = 0;
  root.entries = async function* () {
    for (let i = 0; i < 20000; i++) {
      visits++;
      yield [`native-pcm-orphan-${i}-chunk-00000.f32.json`, { kind: "file" }];
    }
  };
  const scan = await recorder.scanRecoverySessions();
  assert.equal(scan.complete, false);
  assert.equal(scan.sessions.length, 10000);
  assert.ok(visits <= 10000);
  assert.match(scan.error, /10000 sessions/);
  assert.ok(scan.sessions.some((s) => s.sessionId === "native-pcm-indexed"));
});

test("targeted recovery reads no unrelated manifests or sidecars and checks changed chunks", async () => {
  const { recorder, root } = fixture();
  await recorder.start(stream); await record(recorder); await recorder.stop();
  const id = recorder.session.sessionId;
  const chunkName = recorder.session.chunks[0].fileName;
  for (let i = 0; i < 100; i++) {
    root.files.set(`native-pcm-other-${i}-manifest.json`, encoder.encode("{broken large unrelated fixture"));
    root.files.set(`native-pcm-other-${i}-chunk-00000.f32.json`, encoder.encode("{}"));
  }
  // A prefix-neighbor belongs to a different session and must remain unread.
  root.files.set(`${id}-neighbor-manifest.json`, encoder.encode("{}"));
  const reloaded = fixture(root).recorder;
  const getHandle = root.getFileHandle.bind(root);
  const reads = [];
  root.getFileHandle = async (name, options) => {
    reads.push(name);
    return getHandle(name, options);
  };
  const wav = await reloaded.exportRecoveredSelectedChannelWav(id, 0);
  assert.deepEqual([...new Float32Array(await wav.blob.arrayBuffer(), 44)], [0.25, 0.75]);
  const manifest = await reloaded.exportRecoveredManifest(id);
  assert.equal(JSON.parse(await manifest.blob.text()).sessionId, id);
  assert.ok(reads.includes(`${chunkName}.json`));
  assert.ok(reads.every((name) => name === INDEX || name === `${id}-manifest.json` || name === chunkName || name === `${chunkName}.json`), JSON.stringify(reads));
  root.files.delete(chunkName);
  await assert.rejects(reloaded.exportRecoveredSelectedChannelWav(id, 0), /missing|no exportable/);
  root.files.set(chunkName, new Uint8Array(16));
  let chunkReads = 0;
  root.getFileHandle = async (name, options) => {
    const handle = await getHandle(name, options);
    if (name === chunkName && ++chunkReads === 2) handle.getFile = async () => new Blob([new Uint8Array(8)]);
    return handle;
  };
  await assert.rejects(reloaded.exportRecoveredSelectedChannelWav(id, 0), /changed during export/);
  await assert.rejects(reloaded.findRecoveredSession("native-pcm-does-not-exist"), /not found/);
});

for (const action of ["delete", "clear"]) {
  test(`${action} failure drains every removal before a queued retry`, async () => {
    const { recorder, root } = fixture();
    await recorder.start(stream); await record(recorder); await recorder.stop();
    const id = recorder.session.sessionId;
    const chunkName = recorder.session.chunks[0].fileName;
    const deferredName = `${chunkName}.json`;
    const entered = barrier(), resume = barrier();
    const remove = root.removeEntry.bind(root);
    let fail = true, delayed = true, retryEntered = false;
    root.removeEntry = async (name) => {
      if (name === chunkName && fail) { fail = false; throw new Error("synthetic remove denial"); }
      if (name === deferredName && delayed) { delayed = false; entered.release(); await resume.promise; }
      return remove(name);
    };
    const run = () => action === "delete" ? recorder.deleteRecoveredSession(id) : recorder.clear();
    const method = action === "delete" ? "deleteRecoveredSessionNow" : "clearNow";
    const actionNow = recorder[method].bind(recorder);
    let attempts = 0;
    recorder[method] = async (...args) => {
      if (++attempts === 2) retryEntered = true;
      return actionNow(...args);
    };
    let failure, retainedBeforeRetry;
    const first = run().catch((error) => { failure = error; retainedBeforeRetry = root.files.has(chunkName); });
    await entered.promise;
    const retry = run();
    await turn();
    const releasedEarly = retryEntered;
    resume.release();
    await Promise.all([first, retry]);
    assert.equal(releasedEarly, false, "lifecycle action must own all pending removals");
    assert.match(failure?.message ?? "", /1.*retained/);
    assert.ok(failure.message.includes(chunkName));
    assert.deepEqual(failure.retainedFileNames, [chunkName]);
    assert.equal(retainedBeforeRetry, true);
    await run();
    assert.equal([...root.files.keys()].some((name) => name.startsWith(id)), false);
    assert.equal(recorder.state, "idle");
  });
}

test("targeted lookup keeps orphan tails and excludes another session's chunk references", async () => {
  const { recorder, root } = fixture();
  await recorder.start(stream); await record(recorder); await recorder.stop();
  const id = recorder.session.sessionId;
  const tailName = `${id}-chunk-00001.f32`;
  root.files.set(tailName, new Uint8Array(16));
  root.files.delete(INDEX);
  const reloaded = fixture(root).recorder;
  const recovered = await reloaded.findRecoveredSession(id);
  assert.ok(recovered.chunks.some((chunk) => chunk.fileName === tailName));
  const manifestName = `${id}-manifest.json`;
  const manifest = decode(root.files.get(manifestName));
  manifest.chunks = [{ fileName: "native-pcm-other-chunk-00000.f32", frames: 2, bytes: 16 }];
  root.files.set(manifestName, encoder.encode(JSON.stringify(manifest)));
  const reads = [];
  const getHandle = root.getFileHandle.bind(root);
  root.getFileHandle = async (name, options) => { reads.push(name); return getHandle(name, options); };
  await assert.rejects(reloaded.exportRecoveredSelectedChannelWav(id, 0), /outside its session/);
  assert.equal(reads.includes("native-pcm-other-chunk-00000.f32"), false);
});

test("exact recovery directory budget is complete", async () => {
  const { recorder, root } = fixture();
  let visits = 0;
  root.entries = async function* () {
    for (let i = 0; i < 50000; i++) { visits++; yield [`unrelated-${i}`, { kind: "file" }]; }
  };
  const scan = await recorder.scanRecoverySessions();
  assert.equal(visits, 50000);
  assert.equal(scan.complete, true);
  assert.equal(scan.error, "");
});

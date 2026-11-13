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

for (const failure of ["malformed", "read", "permission", "getFile-not-found"]) {
  test(`unreadable catalog (${failure}) protects bytes through Start and Delete`, async () => {
    const { recorder, root } = fixture();
    const id = "native-pcm-saved";
    const bytes = encoder.encode(failure === "malformed" ? "{truncated" : JSON.stringify(catalog({ [id]: {} })));
    root.files.set(INDEX, bytes);
    root.files.set(`${id}-manifest.json`, encoder.encode("{}"));
    const getHandle = root.getFileHandle.bind(root);
    root.getFileHandle = async (name, options) => {
      if (name === INDEX && failure !== "malformed" && !options?.create) {
        if (failure === "permission") throw new DOMException("Denied", "NotAllowedError");
        const handle = await getHandle(name, options);
        handle.getFile = async () => { throw new DOMException("Synthetic read failure", failure === "getFile-not-found" ? "NotFoundError" : "NotReadableError"); };
        return handle;
      }
      return getHandle(name, options);
    };
    await assert.rejects(recorder.start(stream), /index.*read-only/i);
    await assert.rejects(recorder.deleteRecoveredSession(id), /index.*read-only/i);
    assert.deepEqual(root.files.get(INDEX), bytes);
    assert.ok(root.files.has(`${id}-manifest.json`));
    const scan = await recorder.scanRecoverySessions();
    assert.ok(scan.sessions.find((s) => s.sessionId === id).warnings.some((w) => w.code === "index-warning"));
  });
}

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
  assert.ok(scan.sessions.some((s) => s.sessionId === id));
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

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

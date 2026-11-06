import assert from "node:assert/strict";
import { test } from "node:test";
import { readStereoFromRingBuffer, STATE, STATE_BYTES } from "../public/ring-buffer.js";

// Exercise the actual worker message handler with synthetic sockets and PCM.
test("superseded sockets cannot publish events or modify the current stream", async (t) => {
  const messages = [];
  const sockets = [];
  let receive;
  class FakeSocket {
    constructor() { this.handlers = new Map(); sockets.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    close() { this.emit("close"); }
    emit(type, data) { this.handlers.get(type)?.({ data }); }
  }
  for (const [key, value] of Object.entries({
    self: { addEventListener(type, handler) { assert.equal(type, "message"); receive = handler; } },
    WebSocket: FakeSocket,
    postMessage: (message) => messages.push(message),
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  await import("../public/audio-worker.js");
  const send = (type) => receive({ data: { type, url: "ws://synthetic.invalid/ws" } });
  const stream = { type: "stream-started", channels: 2, sampleRate: 48000, framesPerBlock: 1 };
  send("connect");
  const a = sockets[0];
  a.emit("message", JSON.stringify(stream));
  send("connect");
  const b = sockets[1];
  b.emit("open");
  b.emit("message", JSON.stringify(stream));
  const buffer = messages.filter((message) => message.type === "shared-buffer").at(-1).sharedBuffer;
  const state = new Int32Array(buffer, 0, STATE_BYTES / 4);
  const samples = new Float32Array(buffer, STATE_BYTES);
  const pcm = new ArrayBuffer(24);
  const view = new DataView(pcm);
  view.setBigUint64(0, 0n, true);
  view.setUint32(8, 1, true);
  view.setUint16(12, 2, true);
  view.setFloat32(16, 0.25, true);
  view.setFloat32(20, -0.5, true);
  b.emit("message", pcm);
  assert.equal(state[STATE.RECEIVED_BLOCKS], 1);
  assert.deepEqual([...samples.subarray(0, 2)], [0.25, -0.5]);
  const count = messages.length;
  a.emit("open");
  a.emit("error");
  a.emit("close");
  a.emit("message", JSON.stringify({ ...stream, channels: 9 }));
  a.emit("message", JSON.stringify({ type: "native-input-stats", nativeDroppedBlocks: 99 }));
  a.emit("message", JSON.stringify({ type: "stream-error", message: "stale error" }));
  a.emit("message", pcm);
  assert.equal(state[STATE.CONNECTED], 1);
  assert.equal(state[STATE.CHANNELS], 2);
  assert.equal(state[STATE.RECEIVED_BLOCKS], 1);
  assert.equal(messages.length, count);
  assert.deepEqual([...samples.subarray(0, 4)], [0.25, -0.5, 0, 0]);
  const capacity = state[STATE.CAPACITY_FRAMES];
  assert.equal(2 ** 32 % capacity, 0);
  for (const boundary of [2 ** 31, 2 ** 32]) {
    Atomics.store(state, STATE.READ_FRAME, boundary - 1);
    Atomics.store(state, STATE.WRITE_FRAME, boundary - 1);
    Atomics.store(state, STATE.RESERVED_WRITE_FRAME, boundary - 1);
    b.emit("message", pcm);
    b.emit("message", pcm);
    const left = new Float32Array(2), right = new Float32Array(2);
    readStereoFromRingBuffer(state, samples, left, right);
    assert.deepEqual([...left], [0.25, 0.25]);
    assert.deepEqual([...right], [-0.5, -0.5]);
    assert.equal(Atomics.load(state, STATE.READ_FRAME) >>> 0, (boundary + 1) >>> 0);
  }
  b.emit("error");
  assert.deepEqual(messages.at(-1), { type: "socket-state", state: "error" });
  b.emit("close");
  assert.equal(state[STATE.CONNECTED], 0);
  assert.deepEqual(messages.at(-1), { type: "socket-state", state: "closed" });
  send("disconnect");
  const disconnectedCount = messages.length;
  b.emit("message", JSON.stringify(stream));
  b.emit("open");
  assert.equal(messages.length, disconnectedCount);
});

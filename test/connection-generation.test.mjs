import assert from "node:assert/strict";
import { test } from "node:test";
import { appFixture, workerFixture } from "./fixtures/browser.mjs";
import { memoryLocks, memoryStorage, stream } from "./fixtures/opfs.mjs";
import { pcmBlock } from "./fixtures/pcm.mjs";
import { STATE } from "../public/ring-buffer.js";

const started = JSON.stringify({ type: "stream-started", ...stream });

test("page retires already-posted connection replies before disconnect and reconnect", async (t) => {
  const f = await appFixture(t);
  f.click("#connect");
  const old = f.worker.messages.at(-1).generation;
  const buffer = new SharedArrayBuffer(272);
  const stale = [
    { type: "socket-state", state: "open" },
    { type: "shared-buffer", sharedBuffer: buffer, stream },
    { type: "native-input-stats", stats: { nativeDroppedBlocks: 99 } },
    { type: "error", message: "retired error" },
    { type: "socket-state", state: "closed" },
  ].map(message => ({ ...message, generation: old }));
  f.click("#connect"); // Retire synchronously, before the Worker processes Disconnect.
  for (const message of stale) f.worker.emit(message);
  assert.equal(f.elements.get("#socket-state").textContent, "closed");
  assert.equal(f.elements.get("#monitor").disabled, true);
  f.click("#connect");
  const current = f.worker.messages.at(-1).generation;
  assert.notEqual(current, old);
  f.worker.emit({ type: "socket-state", state: "open", generation: current });
  f.worker.emit({ type: "shared-buffer", sharedBuffer: buffer, stream, generation: current });
  for (const message of stale) f.worker.emit(message);
  assert.equal(f.elements.get("#socket-state").textContent, "open");
  assert.equal(f.elements.get("#monitor").disabled, false);
  f.worker.emit({ type: "socket-state", state: "open", generation: old });
  assert.equal(f.elements.get("#socket-state").textContent, "open");
  assert.equal(f.elements.get("#native-dropped-blocks").textContent, "0");
  assert.doesNotMatch(f.elements.get("#stream-summary").textContent, /retired/);
  // Recovery has separate request ownership and still works after disconnect.
  f.click("#connect");
  f.worker.emit({ type: "recovery-sessions", result: { available: true, sessions: [] } });
  assert.match(f.elements.get("#recovery-summary").textContent, /0 OPFS sessions/);
  f.worker.emit({ type: "recording-status", status: { state: "stopped", sessionId: "fixture", recordedFrames: 2 } });
  assert.equal(f.elements.get("#record-state").textContent, "stopped");
  assert.equal(f.elements.get("#export-manifest").disabled, false);
});

test("worker echoes connection generation on stream and terminal replies", async (t) => {
  const f = await workerFixture(t);
  f.send("connect", { generation: 7 });
  f.send("disconnect", { generation: 1 }); // An old command cannot retire generation 7.
  const socket = f.sockets.at(-1);
  socket.emit("open");
  socket.emit("message", started);
  socket.emit("message", "invalid");
  socket.emit("error");
  const replies = f.messages.filter(m => ["socket-state", "shared-buffer", "error"].includes(m.type));
  assert.ok(replies.length >= 4);
  assert.ok(replies.every(m => m.generation === 7));
});

for (const name of ["SyntaxError", "SecurityError"]) {
  test(`WebSocket ${name} settles the attempt and preserves prior transport and recovery`, async (t) => {
    const sockets = [];
    class Socket {
      handlers = new Map();
      closes = 0;
      constructor(url) {
        if (url === "refused") throw new DOMException("private constructor detail", name);
        sockets.push(this);
      }
      addEventListener(type, handler) { this.handlers.set(type, handler); }
      removeEventListener(type, handler) { if (this.handlers.get(type) === handler) this.handlers.delete(type); }
      emit(type, data) { this.handlers.get(type)?.({ data }); }
      close() { this.closes++; this.emit("close"); }
    }
    const root = memoryStorage();
    const f = await workerFixture(t, { WebSocket: Socket, navigator: {
      storage: { getDirectory: async () => root, persist: async () => true }, locks: memoryLocks(),
    } });
    const previous = sockets[0];
    previous.emit("message", started);
    const buffer = f.messages.find(m => m.type === "shared-buffer").sharedBuffer;
    f.send("recording-start");
    await new Promise(setImmediate);
    previous.emit("message", pcmBlock());
    f.send("recording-stop");
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.equal(f.messages.findLast(m => m.type === "recording-status").status.state, "stopped");
    assert.doesNotThrow(() => f.send("connect", { generation: 8, url: "refused" }));
    assert.equal(previous.closes, 0);
    assert.equal(new Int32Array(buffer)[STATE.CONNECTED], 1);
    assert.deepEqual(f.messages.at(-1), { type: "socket-state", state: "error", generation: 8,
      code: "connection-construction-failed", message: "WebSocket connection could not be created; retry Connect." });
    f.send("recovery-scan", { requestId: 17 });
    await new Promise(setImmediate);
    const inventory = f.messages.findLast(m => m.type === "recovery-sessions");
    assert.equal(inventory.requestId, 17);
    assert.equal(inventory.result.sessions.length, 1);
    f.send("export-recovered-wav", { sessionId: inventory.result.sessions[0].sessionId, channelIndex: 1 });
    await new Promise(setImmediate);
    assert.equal(f.messages.findLast(m => m.type === "download").blob.size, 52);
    f.send("export-manifest");
    await new Promise(setImmediate);
    const manifest = JSON.parse(await f.messages.findLast(m => m.type === "download").blob.text());
    assert.equal(manifest.totalRecordedFrames, 2);
    f.send("connect", { generation: 9 });
    assert.equal(previous.closes, 1);
    sockets.at(-1).emit("message", started);
    assert.equal(f.messages.findLast(m => m.type === "shared-buffer").generation, 9);
    f.send("disconnect", { generation: 9 });
  });
}

test("page leaves connecting after constructor refusal and permits retry with recovery intact", async (t) => {
  const f = await appFixture(t);
  f.click("#connect");
  const generation = f.worker.messages.at(-1).generation;
  f.worker.emit({ type: "socket-state", state: "error", generation,
    code: "connection-construction-failed", message: "WebSocket connection could not be created; retry Connect." });
  assert.equal(f.elements.get("#connect").textContent, "Connect");
  assert.equal(f.worker.terminations, 0);
  assert.match(f.elements.get("#stream-summary").textContent, /could not be created/);
  f.click("#connect");
  assert.equal(f.elements.get("#socket-state").textContent, "connecting");
  assert.notEqual(f.worker.messages.at(-1).generation, generation);
});

test("device-lost explanation reaches the page on the terminal socket-state", async (t) => {
  const w = await workerFixture(t);
  w.socket.emit("open");
  w.socket.emit("message", started);
  const generation = w.messages.findLast(m => m.type === "socket-state").generation;
  const before = w.messages.length;
  w.socket.emit("message", JSON.stringify({ type: "stream-error", code: "device-lost", message: "Input capture failed" }));
  const replies = w.messages.slice(before).filter(m => ["socket-state", "error"].includes(m.type));
  assert.deepEqual(replies, [{ type: "socket-state", state: "device-lost", generation,
    code: "device-lost", message: "Input capture failed" }]);

  const f = await appFixture(t);
  f.click("#connect");
  const page = f.worker.messages.at(-1).generation;
  f.worker.emit({ type: "socket-state", state: "open", generation: page });
  f.worker.emit({ ...replies[0], generation: page });
  assert.equal(f.elements.get("#socket-state").textContent, "device-lost");
  assert.equal(f.elements.get("#stream-summary").textContent, "Input capture failed");
  assert.equal(f.elements.get("#connect").textContent, "Connect");
});

for (const phase of ["handshake", "configuration"]) {
  test(`startup deadline covers stalled ${phase} and ignores late events after retry`, async (t) => {
    const timers = new Map();
    let nextTimer = 0;
    const f = await workerFixture(t, {
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    });
    assert.equal(timers.size, 1);
    const timer = [...timers.values()][0];
    assert.equal(timer.delay, 10_000);
    const lateMessage = f.socket.handlers.get("message");
    const lateOpen = f.socket.handlers.get("open");
    if (phase === "configuration") {
      f.socket.emit("open");
      f.socket.emit("message", JSON.stringify({ type: "stream-started", channels: -1 }));
      assert.equal(timers.size, 1, "invalid configuration cannot clear the deadline");
    }
    timer.callback();
    assert.equal(timers.size, 0);
    assert.equal(f.socket.handlers.size, 0, "retirement detaches transport listeners");
    assert.deepEqual(f.messages.at(-1), { type: "socket-state", state: "error", generation: 1,
      code: "connection-startup-timeout", message: "WebSocket startup timed out; retry Connect." });
    f.send("connect");
    const current = f.sockets.at(-1);
    const before = f.messages.length;
    lateOpen({}); lateMessage({ data: started }); timer.callback();
    assert.equal(f.messages.length, before);
    assert.equal(timers.size, 1, "old timeout cannot clear new attempt's timer");
    const settledTimer = [...timers.values()][0];
    current.emit("message", started);
    assert.equal(timers.size, 0);
    assert.equal(f.messages.at(-1).type, "shared-buffer");
    assert.equal(f.messages.at(-1).generation, 2);
    const settledCount = f.messages.length;
    timer.callback();
    settledTimer.callback();
    assert.equal(f.messages.length, settledCount);
    f.send("disconnect");
    assert.equal(current.handlers.size, 0);
  });
}

test("startup owns one timer through open; replacement and disconnect cancel it", async (t) => {
  const timers = new Set();
  const f = await workerFixture(t, {
    setTimeout(callback) { timers.add(callback); return callback; },
    clearTimeout(callback) { timers.delete(callback); },
  });
  f.socket.emit("open");
  assert.equal(timers.size, 1);
  f.send("connect");
  assert.equal(timers.size, 1);
  f.send("disconnect");
  assert.equal(timers.size, 0);
});

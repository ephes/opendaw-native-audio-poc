import assert from "node:assert/strict";
import { test } from "node:test";
import { STATE, STATE_BYTES } from "../public/ring-buffer.js";
import { monitorRing, workletFixture } from "./fixtures/worklet.mjs";

test("invalid controls preserve routing, counters and renderable configuration", () => {
  const f = workletFixture(), ring = monitorRing();
  f.send({ type: "configure", sharedBuffer: ring.sharedBuffer, left: 2, right: 0 });
  const bad = [null, [], 42, "configure", {}, { type: "unknown" },
    { type: "configure" }, { type: "configure", sharedBuffer: new ArrayBuffer(512) },
    { type: "configure", sharedBuffer: new SharedArrayBuffer(8) },
    { type: "configure", sharedBuffer: new SharedArrayBuffer(STATE_BYTES) }];
  for (const [field, values] of [
    [STATE.CHANNELS, [0, -1, 65]],
    [STATE.CAPACITY_FRAMES, [0, -1, 3, 64]],
    [STATE.SAMPLE_RATE, [0, -1, 384001]],
    [STATE.FRAMES_PER_BLOCK, [0, -1, 65537]],
  ]) {
    for (const value of values) {
      const invalid = monitorRing();
      invalid.state[field] = value;
      bad.push({ type: "configure", sharedBuffer: invalid.sharedBuffer });
    }
  }
  // Valid-looking geometry with surplus storage is not the declared ring.
  const surplus = new SharedArrayBuffer(ring.sharedBuffer.byteLength + 4);
  new Int32Array(surplus, 0, 64).set(ring.state);
  bad.push({ type: "configure", sharedBuffer: surplus });
  for (const type of ["channels", "configure"]) {
    for (const side of ["left", "right"]) {
      for (const value of [-1, 0.5, NaN, Infinity, 3, "1", null]) {
        bad.push({ type, sharedBuffer: ring.sharedBuffer, left: 2, right: 0, [side]: value });
      }
    }
  }
  bad.push({ type: "channels", left: 0 });
  for (const message of bad) {
    ring.state[STATE.OVERFLOW_COUNT] = 7;
    ring.state[STATE.UNDERRUN_COUNT] = 8;
    const before = f.messages.length;
    assert.doesNotThrow(() => f.send(message));
    assert.equal(f.messages.length, before + 1);
    assert.equal(f.messages.at(-1).type, "control-error");
    assert.ok(JSON.stringify(f.messages.at(-1)).length < 160);
    assert.equal(ring.state[STATE.OVERFLOW_COUNT], 7);
    assert.equal(ring.state[STATE.UNDERRUN_COUNT], 8);
    ring.write(0, 4);
    assert.deepEqual(f.render(), [[3, 13, 23, 33], [1, 11, 21, 31]]);
  }
});

test("invalid controls before configuration leave the output silent", () => {
  const f = workletFixture();
  for (const message of [null, [], { type: "channels", left: 0, right: 1 }]) {
    assert.doesNotThrow(() => f.send(message));
    assert.equal(f.messages.at(-1).type, "control-error");
    assert.deepEqual(f.render(), [[0, 0, 0, 0], [0, 0, 0, 0]]);
  }
});

test("multichannel ramps render across quanta and reroute without resetting counters", () => {
  const f = workletFixture(), ring = monitorRing(4);
  assert.deepEqual(f.render(), [[0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.deepEqual(f.messages, []);
  f.send({ type: "configure", sharedBuffer: ring.sharedBuffer, left: 3, right: 1 });
  ring.write(0, 12);
  assert.deepEqual(f.render(), [[4, 14, 24, 34], [2, 12, 22, 32]]);
  assert.deepEqual(f.render(), [[44, 54, 64, 74], [42, 52, 62, 72]]);
  f.send({ type: "channels", left: 0, right: 2 });
  assert.deepEqual(f.render(), [[81, 91, 101, 111], [83, 93, 103, 113]]);
  assert.deepEqual(f.render(), [[0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(ring.state[STATE.UNDERRUN_COUNT], 1);
  ring.write(12, 2);
  assert.deepEqual(f.render(), [[121, 131, 0, 0], [123, 133, 0, 0]]);
  assert.equal(ring.state[STATE.UNDERRUN_COUNT], 2);
  assert.equal(ring.state[STATE.READ_FRAME], 14);
  assert.equal(f.messages.filter((m) => m.type === "counters-reset").length, 1);
});

test("configure aligns only to retained unconsumed samples and resets counters once", () => {
  const f = workletFixture(), old = monitorRing();
  f.send({ type: "configure", sharedBuffer: old.sharedBuffer, left: 2, right: 1 });
  old.write(0, 4);
  const next = monitorRing(2);
  next.write(0, 24);
  next.state[STATE.OVERFLOW_COUNT] = 9;
  next.state[STATE.UNDERRUN_COUNT] = 7;
  f.send({ type: "configure", sharedBuffer: next.sharedBuffer });
  assert.equal(next.state[STATE.READ_FRAME], 12); // Three four-frame blocks behind.
  assert.equal(next.state[STATE.OVERFLOW_COUNT], 0);
  assert.equal(next.state[STATE.UNDERRUN_COUNT], 0);
  assert.deepEqual(f.render(), [[122, 132, 142, 152], [122, 132, 142, 152]]);
  assert.equal(old.state[STATE.READ_FRAME], 0);
  assert.equal(f.messages.filter((m) => m.type === "counters-reset").length, 2);

  const mono = monitorRing(1);
  mono.write(0, 2);
  f.send({ type: "configure", sharedBuffer: mono.sharedBuffer });
  assert.equal(mono.state[STATE.READ_FRAME], 0); // Never invent pre-start samples.
  assert.deepEqual(f.render(), [[1, 11, 0, 0], [1, 11, 0, 0]]);
  const consumed = mono.state[STATE.READ_FRAME];
  f.send({ type: "configure", sharedBuffer: mono.sharedBuffer });
  assert.equal(mono.state[STATE.READ_FRAME], consumed); // Never replay consumed audio.
  assert.deepEqual(f.render(), [[0, 0, 0, 0], [0, 0, 0, 0]]);
  assert.equal(mono.state[STATE.UNDERRUN_COUNT], 1);
});

test("status starts on the first configured render and repeats every twenty quanta", () => {
  const f = workletFixture(), ring = monitorRing();
  for (let i = 0; i < 25; i++) f.render();
  assert.equal(f.messages.length, 0);
  f.send({ type: "configure", sharedBuffer: ring.sharedBuffer });
  for (let quantum = 1; quantum <= 42; quantum++) {
    if (quantum === 10) f.send({ type: "configure", sharedBuffer: ring.sharedBuffer });
    f.render();
    assert.equal(f.messages.filter((m) => m.type === "status").length,
      Math.floor((quantum - 1) / 20) + 1);
  }
  assert.equal(f.messages.filter((m) => m.type === "counters-reset").length, 2);
});

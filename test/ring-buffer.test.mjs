import assert from "node:assert/strict";
import { test } from "node:test";

import {
  alignReadCursor,
  writePcmToRingBuffer,
  createRingBufferViews,
  readStereoFromRingBuffer,
  RING_BUFFER_BYTES_PER_SAMPLE,
  STATE,
  STATE_BYTES,
  STATE_INTS,
} from "../public/ring-buffer.js";

test("alignReadCursor places the read cursor three blocks behind the writer", () => {
  const { stateView } = createTestRingBuffer({
    channels: 2,
    capacityFrames: 4096,
    framesPerBlock: 100,
    writeFrame: 1_000,
  });

  assert.equal(alignReadCursor(stateView), 700);
  assert.equal(Atomics.load(stateView, STATE.READ_FRAME), 700);
});

test("alignReadCursor does not move before frame zero", () => {
  const { stateView } = createTestRingBuffer({
    channels: 2,
    capacityFrames: 4096,
    framesPerBlock: 100,
    writeFrame: 250,
  });

  assert.equal(alignReadCursor(stateView), 0);
  assert.equal(Atomics.load(stateView, STATE.READ_FRAME), 0);
});

test("alignReadCursor uses the default frames-per-block fallback when metadata is missing", () => {
  const { stateView } = createTestRingBuffer({
    channels: 2,
    capacityFrames: 4096,
    framesPerBlock: 0,
    writeFrame: 4_000,
  });

  assert.equal(alignReadCursor(stateView), 1_120);
  assert.equal(Atomics.load(stateView, STATE.READ_FRAME), 1_120);
});

test("readStereoFromRingBuffer copies selected source channels and advances the read cursor", () => {
  const ring = createTestRingBuffer({
    channels: 4,
    capacityFrames: 16,
    readFrame: 2,
    writeFrame: 5,
  });
  writeFrame(ring, 2, [20, 21, 22, 23]);
  writeFrame(ring, 3, [30, 31, 32, 33]);
  writeFrame(ring, 4, [40, 41, 42, 43]);
  const leftOut = new Float32Array(3);
  const rightOut = new Float32Array(3);

  const result = readStereoFromRingBuffer(
    ring.stateView,
    ring.sampleView,
    leftOut,
    rightOut,
    2,
    0,
  );

  assert.deepEqual([...leftOut], [22, 32, 42]);
  assert.deepEqual([...rightOut], [20, 30, 40]);
  assert.equal(result.underrun, false);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 5);
  assert.equal(Atomics.load(ring.stateView, STATE.UNDERRUN_COUNT), 0);
});

test("readStereoFromRingBuffer zeroes unavailable trailing frames and counts one underrun", () => {
  const ring = createTestRingBuffer({
    channels: 2,
    capacityFrames: 16,
    readFrame: 10,
    writeFrame: 12,
  });
  writeFrame(ring, 10, [101, 102]);
  writeFrame(ring, 11, [111, 112]);
  const leftOut = new Float32Array(4);
  const rightOut = new Float32Array(4);

  const result = readStereoFromRingBuffer(
    ring.stateView,
    ring.sampleView,
    leftOut,
    rightOut,
    0,
    1,
  );

  assert.deepEqual([...leftOut], [101, 111, 0, 0]);
  assert.deepEqual([...rightOut], [102, 112, 0, 0]);
  assert.equal(result.underrun, true);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 12);
  assert.equal(Atomics.load(ring.stateView, STATE.UNDERRUN_COUNT), 1);
});

test("readStereoFromRingBuffer zeroes an empty buffer without advancing the read cursor", () => {
  const ring = createTestRingBuffer({
    channels: 2,
    capacityFrames: 16,
    readFrame: 7,
    writeFrame: 7,
  });
  const leftOut = new Float32Array([1, 2, 3]);
  const rightOut = new Float32Array([4, 5, 6]);

  readStereoFromRingBuffer(
    ring.stateView,
    ring.sampleView,
    leftOut,
    rightOut,
    0,
    1,
  );

  assert.deepEqual([...leftOut], [0, 0, 0]);
  assert.deepEqual([...rightOut], [0, 0, 0]);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 7);
  assert.equal(Atomics.load(ring.stateView, STATE.UNDERRUN_COUNT), 1);
});

test("readStereoFromRingBuffer wraps through the end and beginning of the circular buffer", () => {
  const ring = createTestRingBuffer({
    channels: 2,
    capacityFrames: 4,
    readFrame: 2,
    writeFrame: 6,
  });
  writeFrame(ring, 2, [20, 21]);
  writeFrame(ring, 3, [30, 31]);
  writeFrame(ring, 4, [40, 41]);
  writeFrame(ring, 5, [50, 51]);
  const leftOut = new Float32Array(4);
  const rightOut = new Float32Array(4);

  readStereoFromRingBuffer(
    ring.stateView,
    ring.sampleView,
    leftOut,
    rightOut,
    0,
    1,
  );

  assert.deepEqual([...leftOut], [20, 30, 40, 50]);
  assert.deepEqual([...rightOut], [21, 31, 41, 51]);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 6);
});

test("readStereoFromRingBuffer clamps out-of-range selected channels to the last channel", () => {
  const ring = createTestRingBuffer({
    channels: 3,
    capacityFrames: 8,
    readFrame: 0,
    writeFrame: 1,
  });
  writeFrame(ring, 0, [1, 2, 3]);
  const leftOut = new Float32Array(1);
  const rightOut = new Float32Array(1);

  readStereoFromRingBuffer(
    ring.stateView,
    ring.sampleView,
    leftOut,
    rightOut,
    99,
    10,
  );

  assert.deepEqual([...leftOut], [3]);
  assert.deepEqual([...rightOut], [3]);
});

test("readStereoFromRingBuffer preserves the source-sample fallback to zero", () => {
  const ring = createTestRingBuffer({
    channels: 2,
    capacityFrames: 8,
    readFrame: 0,
    writeFrame: 1,
  });
  writeFrame(ring, 0, [Number.NaN, 5]);
  const leftOut = new Float32Array(1);
  const rightOut = new Float32Array(1);

  readStereoFromRingBuffer(
    ring.stateView,
    ring.sampleView,
    leftOut,
    rightOut,
    0,
    9,
  );

  assert.deepEqual([...leftOut], [0]);
  assert.deepEqual([...rightOut], [5]);
});

test("readStereoFromRingBuffer preserves mono-output alias behavior", () => {
  const ring = createTestRingBuffer({
    channels: 2,
    capacityFrames: 8,
    readFrame: 0,
    writeFrame: 1,
  });
  writeFrame(ring, 0, [11, 22]);
  const monoOut = new Float32Array(1);

  readStereoFromRingBuffer(
    ring.stateView,
    ring.sampleView,
    monoOut,
    monoOut,
    0,
    1,
  );

  assert.deepEqual([...monoOut], [22]);
});

function createTestRingBuffer({
  channels,
  capacityFrames,
  framesPerBlock = 960,
  readFrame = 0,
  writeFrame = 0,
}) {
  const sharedBuffer = new SharedArrayBuffer(
    STATE_BYTES + capacityFrames * channels * RING_BUFFER_BYTES_PER_SAMPLE,
  );
  const stateView = new Int32Array(sharedBuffer, 0, STATE_INTS);
  Atomics.store(stateView, STATE.WRITE_FRAME, writeFrame);
  Atomics.store(stateView, STATE.RESERVED_WRITE_FRAME, writeFrame);
  Atomics.store(stateView, STATE.READ_FRAME, readFrame);
  Atomics.store(stateView, STATE.OVERFLOW_COUNT, 0);
  Atomics.store(stateView, STATE.UNDERRUN_COUNT, 0);
  Atomics.store(stateView, STATE.CHANNELS, channels);
  Atomics.store(stateView, STATE.CAPACITY_FRAMES, capacityFrames);
  Atomics.store(stateView, STATE.FRAMES_PER_BLOCK, framesPerBlock);
  const { sampleView } = createRingBufferViews(sharedBuffer);
  return { sharedBuffer, stateView, sampleView, channels, capacityFrames };
}

function writeFrame(ring, absoluteFrame, samples) {
  const ringFrame = absoluteFrame % ring.capacityFrames;
  const offset = ringFrame * ring.channels;
  ring.sampleView.set(samples, offset);
}

for (const boundary of [2 ** 31, 2 ** 32]) {
  test(`stereo read and alignment survive cursor wrap at ${boundary}`, () => {
    const ring = createTestRingBuffer({
      channels: 2, capacityFrames: 16, framesPerBlock: 1,
      readFrame: boundary - 2, writeFrame: boundary + 2,
    });
    for (let i = 0; i < 4; i++) writeFrame(ring, (boundary - 2 + i) >>> 0, [i + 1, -i - 1]);
    assert.equal(alignReadCursor(ring.stateView, { targetBlocks: 4 }), (boundary - 2) >>> 0);
    const left = new Float32Array(4);
    const right = new Float32Array(4);
    const result = readStereoFromRingBuffer(ring.stateView, ring.sampleView, left, right);
    assert.deepEqual([...left], [1, 2, 3, 4]);
    assert.deepEqual([...right], [-1, -2, -3, -4]);
    assert.equal(result.underrun, false);
    assert.equal(result.readFrame, (boundary + 2) >>> 0);
  });
}

for (const boundary of [2 ** 31, 2 ** 32]) {
  test(`producer and consumer preserve samples across ${boundary}`, () => {
    const ring = createTestRingBuffer({ channels: 2, capacityFrames: 8,
      readFrame: boundary - 2, writeFrame: boundary - 2 });
    const input = new Float32Array([1, -1, 2, -2, 3, -3, 4, -4]);
    writePcmToRingBuffer(ring.stateView, ring.sampleView, input, 4);
    const left = new Float32Array(4), right = new Float32Array(4);
    readStereoFromRingBuffer(ring.stateView, ring.sampleView, left, right);
    assert.deepEqual([...left], [1, 2, 3, 4]);
    assert.deepEqual([...right], [-1, -2, -3, -4]);
    assert.equal(Atomics.load(ring.stateView, STATE.OVERFLOW_COUNT), 0);
  });
}

test("overflow during rendering discards overwritten samples and never resurrects old frames", () => {
  const ring = createTestRingBuffer({ channels: 2, capacityFrames: 4,
    readFrame: 0, writeFrame: 4 });
  let interleaved = false;
  const samples = new Proxy(ring.sampleView, {
    get(target, key) {
      if (key === "0" && !interleaved) {
        interleaved = true;
        writePcmToRingBuffer(ring.stateView, target,
          new Float32Array([5, -5, 6, -6, 7, -7, 8, -8]), 4);
      }
      return Reflect.get(target, key);
    },
  });
  const left = new Float32Array(1), right = new Float32Array(1);
  readStereoFromRingBuffer(ring.stateView, samples, left, right);
  assert.equal(interleaved, true);
  assert.deepEqual([...left, ...right], [0, 0]);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 0);
  const resumedLeft = new Float32Array(4), resumedRight = new Float32Array(4);
  readStereoFromRingBuffer(ring.stateView, ring.sampleView, resumedLeft, resumedRight);
  assert.deepEqual([...resumedLeft], [5, 6, 7, 8]);
  assert.deepEqual([...resumedRight], [-5, -6, -7, -8]);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 8);
  assert.equal(Atomics.load(ring.stateView, STATE.OVERFLOW_COUNT), 1);
});

test("render during an in-progress non-overlapping write preserves committed audio", () => {
  const ring = createTestRingBuffer({ channels: 2, capacityFrames: 4, writeFrame: 1 });
  ring.sampleView.set([1, -1]);
  const samples = new Proxy(ring.sampleView, {
    get(target, key) {
      if (key !== "set") return Reflect.get(target, key);
      return (...args) => {
        const left = new Float32Array([99]), right = new Float32Array([99]);
        readStereoFromRingBuffer(ring.stateView, target, left, right);
        assert.deepEqual([...left, ...right], [1, -1]);
        assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 1);
        return target.set(...args);
      };
    },
  });
  writePcmToRingBuffer(ring.stateView, samples, new Float32Array([2, -2]), 1);
});

test("overflow spanning uint32 wrap retains the newest capacity frames", () => {
  const ring = createTestRingBuffer({ channels: 2, capacityFrames: 4,
    readFrame: 2 ** 32 - 2, writeFrame: 2 ** 32 - 2 });
  writePcmToRingBuffer(ring.stateView, ring.sampleView,
    new Float32Array([1,-1,2,-2,3,-3,4,-4,5,-5,6,-6]), 6);
  const left = new Float32Array(4), right = new Float32Array(4);
  readStereoFromRingBuffer(ring.stateView, ring.sampleView, left, right);
  assert.deepEqual([...left], [3,4,5,6]);
  assert.deepEqual([...right], [-3,-4,-5,-6]);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 4);
  assert.equal(Atomics.load(ring.stateView, STATE.OVERFLOW_COUNT), 1);
});

test("startup alignment never rewinds consumed audio or includes overwritten frames", () => {
  const ring = createTestRingBuffer({ channels: 2, capacityFrames: 8,
    framesPerBlock: 2, readFrame: 9, writeFrame: 10 });
  assert.equal(alignReadCursor(ring.stateView), 9);
  Atomics.store(ring.stateView, STATE.READ_FRAME, 0);
  assert.equal(alignReadCursor(ring.stateView, { targetBlocks: 20 }), 2);
});

test("a non-overflowing write during render preserves audio and cursor progress", () => {
  const ring = createTestRingBuffer({ channels: 2, capacityFrames: 8, writeFrame: 2 });
  ring.sampleView.set([1, -1, 2, -2]);
  let interleaved = false;
  const samples = new Proxy(ring.sampleView, {
    get(target, key) {
      if (key === "0" && !interleaved) {
        interleaved = true;
        writePcmToRingBuffer(ring.stateView, target, new Float32Array([3, -3]), 1);
      }
      return Reflect.get(target, key);
    },
  });
  const left = new Float32Array(2), right = new Float32Array(2);
  readStereoFromRingBuffer(ring.stateView, samples, left, right);
  assert.equal(interleaved, true);
  assert.deepEqual([...left], [1, 2]);
  assert.deepEqual([...right], [-1, -2]);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 2);
  assert.equal(Atomics.load(ring.stateView, STATE.UNDERRUN_COUNT), 0);
});

test("render during an unfinished overwrite stays silent until the write commits", () => {
  const ring = createTestRingBuffer({ channels: 2, capacityFrames: 4, writeFrame: 4 });
  ring.sampleView.fill(99);
  let renders = 0;
  const samples = new Proxy(ring.sampleView, {
    get(target, key) {
      if (key !== "set") return Reflect.get(target, key);
      return (...args) => {
        renders++;
        const left = new Float32Array([99]), right = new Float32Array([99]);
        readStereoFromRingBuffer(ring.stateView, target, left, right);
        assert.deepEqual([...left, ...right], [0, 0]);
        assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 0);
        return target.set(...args);
      };
    },
  });
  writePcmToRingBuffer(ring.stateView, samples, new Float32Array([5,-5,6,-6,7,-7,8,-8]), 4);
  assert.equal(renders, 4);
  const left = new Float32Array(4), right = new Float32Array(4);
  readStereoFromRingBuffer(ring.stateView, ring.sampleView, left, right);
  assert.deepEqual([...left], [5,6,7,8]);
  assert.equal(Atomics.load(ring.stateView, STATE.READ_FRAME), 8);
});

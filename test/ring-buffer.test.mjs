import assert from "node:assert/strict";
import { test } from "node:test";

import {
  alignReadCursor,
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
    capacityFrames: 128,
    framesPerBlock: 100,
    writeFrame: 1_000,
  });

  assert.equal(alignReadCursor(stateView), 700);
  assert.equal(Atomics.load(stateView, STATE.READ_FRAME), 700);
});

test("alignReadCursor does not move before frame zero", () => {
  const { stateView } = createTestRingBuffer({
    channels: 2,
    capacityFrames: 128,
    framesPerBlock: 100,
    writeFrame: 250,
  });

  assert.equal(alignReadCursor(stateView), 0);
  assert.equal(Atomics.load(stateView, STATE.READ_FRAME), 0);
});

test("alignReadCursor uses the default frames-per-block fallback when metadata is missing", () => {
  const { stateView } = createTestRingBuffer({
    channels: 2,
    capacityFrames: 128,
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

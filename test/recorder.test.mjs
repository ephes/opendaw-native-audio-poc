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

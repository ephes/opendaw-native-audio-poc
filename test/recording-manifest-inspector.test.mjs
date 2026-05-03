import assert from "node:assert/strict";
import { test } from "node:test";

import { inspectManifest, parseCliArgs } from "../scripts/inspect-recording-manifest.mjs";

test("inspectManifest accepts a valid stopped manifest", () => {
  const result = inspectManifest(createStoppedManifest(), l12Options());

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.frames, 1920);
  assert.deepEqual(result.summary.nativeDropDeltas, {
    nativeDroppedBlocks: 0,
    nativeDroppedFrames: 0,
    nativeDropEvents: 0,
  });
});

test("inspectManifest fails expected stream shape mismatches", () => {
  const manifest = createStoppedManifest();
  const result = inspectManifest(manifest, {
    expectChannels: 12,
    expectSampleRate: 44100,
    expectFramesPerBlock: 480,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /channels expected 12, got 14/);
  assert.match(result.errors.join("\n"), /sampleRate expected 44100, got 48000/);
  assert.match(result.errors.join("\n"), /framesPerBlock expected 480, got 960/);
});

test("inspectManifest fails recorded gaps and discontinuities", () => {
  const manifest = createStoppedManifest();
  manifest.integrity.gaps.push({
    expectedFrameStart: 960,
    actualFrameStart: 1920,
    missingFrames: 960,
    recordedBlockIndex: 1,
  });
  manifest.integrity.discontinuities.push({ type: "gap", ...manifest.integrity.gaps[0] });

  const result = inspectManifest(manifest, l12Options());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /integrity\.gaps has 1 entry/);
  assert.match(result.errors.join("\n"), /integrity\.discontinuities has 1 entry/);
});

test("inspectManifest fails chunk frame and byte inconsistencies", () => {
  const manifest = createStoppedManifest();
  manifest.chunks[0].frames += 1;
  manifest.chunks[0].blocks[1].chunkOffsetBytes += 4;

  const result = inspectManifest(manifest, l12Options());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /chunks\[0\]\.frames expected block frame sum 1920, got 1921/);
  assert.match(result.errors.join("\n"), /chunks\[0\]\.blocks\[1\]\.chunkOffsetBytes expected 53760, got 53764/);
});

test("inspectManifest fails block byte-length inconsistencies", () => {
  const manifest = createStoppedManifest();
  manifest.chunks[0].blocks[1].byteLength += 4;

  const result = inspectManifest(manifest, l12Options());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /chunks\[0\]\.blocks\[1\]\.byteLength expected 53760, got 53764/);
});

test("inspectManifest fails cross-chunk frame continuity mismatches", () => {
  const manifest = createTwoChunkManifestWithGap();

  const result = inspectManifest(manifest, l12Options());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /chunks\[1\]\.firstFrameStart expected 960 after previous chunk, got 1920/);
});

test("inspectManifest fails native drops when zero drops are expected", () => {
  const manifest = createStoppedManifest();
  manifest.nativeInputStats.stop.nativeDroppedBlocks = 1;
  manifest.nativeInputStats.stop.nativeDroppedFrames = 960;
  manifest.nativeInputStats.stop.nativeDropEvents = 1;

  const result = inspectManifest(manifest, l12Options());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Native dropped callback buffers increased during recording: 1/);
  assert.match(result.errors.join("\n"), /Native dropped frames increased during recording: 960/);
  assert.match(result.errors.join("\n"), /Native drop events increased during recording: 1/);
});

test("inspectManifest reports native counter decreases distinctly", () => {
  const manifest = createStoppedManifest();
  manifest.nativeInputStats.start.nativeDroppedFrames = 10;

  const result = inspectManifest(manifest, l12Options());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /nativeInputStats\.nativeDroppedFrames decreased between start and stop\/latest \(10 -> 0\)/);
  assert.doesNotMatch(result.errors.join("\n"), /are required when --expect-native-drops-zero is set/);
});

test("inspectManifest fails missing native stats when zero drops are expected", () => {
  const manifest = createStoppedManifest();
  delete manifest.nativeInputStats;

  const result = inspectManifest(manifest, l12Options());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /nativeInputStats\.start and nativeInputStats\.stop\/latest are required/);
});

test("inspectManifest fails a recovered manifest with a fatal recovery warning", () => {
  const result = inspectManifest(createRecoveredManifest(), l12Options());

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /Fatal recovery warning: Chunk is missing/);
  assert.equal(result.summary.recovered, true);
  assert.equal(result.summary.fatalRecoveryWarnings, 1);
});

test("inspectManifest compares recovered totals against valid recovered chunks", () => {
  const result = inspectManifest(createPartialRecoveredManifest(), l12Options());
  const errors = result.errors.join("\n");
  const warnings = result.warnings.join("\n");

  assert.equal(result.ok, false);
  assert.match(errors, /Fatal recovery warning: Chunk native-pcm-test-chunk-00001\.f32 is size-mismatched/);
  assert.match(errors, /chunks\[1\]\.bytes expected recovered expectedBytes 107520, got 53760/);
  assert.doesNotMatch(errors, /reconstructed\.frames/);
  assert.doesNotMatch(errors, /reconstructed\.bytes/);
  assert.doesNotMatch(errors, /reconstructed\.chunks/);
  assert.doesNotMatch(errors, /fatal chunk recovery warning/);
  assert.doesNotMatch(warnings, /counterDeltasAtStop is missing/);
});

test("inspectManifest warns but does not fail for non-stopped live manifests", () => {
  const manifest = createStoppedManifest();
  manifest.state = "recording";
  manifest.stoppedAt = null;

  const result = inspectManifest(manifest, l12Options());

  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /Manifest state is recording/);
});

test("inspectManifest reports monitor and write-backlog counters as warnings", () => {
  const manifest = createStoppedManifest();
  manifest.counterDeltasAtStop.underrunsDuringRecording = 2;
  manifest.counterDeltasAtStop.overflowsDuringRecording = 1;
  manifest.integrity.websocketLagEvents.push({ code: "lag", message: "late", at: "2026-05-03T10:00:01.000Z" });
  manifest.integrity.counterResets.push({ reason: "monitor-start", at: "2026-05-03T10:00:01.000Z" });
  manifest.integrity.writeBacklogEvents.push({ highWaterBlocks: 2, highWaterBytes: 4096 });
  manifest.writeBacklogHighWaterBlocks = 2;
  manifest.writeBacklogHighWaterBytes = 4096;

  const result = inspectManifest(manifest, l12Options());
  const warnings = result.warnings.join("\n");

  assert.equal(result.ok, true);
  assert.match(warnings, /Monitor underruns during recording: 2/);
  assert.match(warnings, /Monitor overflows during recording: 1/);
  assert.match(warnings, /integrity\.websocketLagEvents has 1 entry/);
  assert.match(warnings, /integrity\.counterResets has 1 entry/);
  assert.match(warnings, /integrity\.writeBacklogEvents has 1 entry/);
  assert.match(warnings, /Write backlog high-water blocks: 2/);
  assert.match(warnings, /Write backlog high-water bytes: 4096/);
});

test("parseCliArgs parses inspector options", () => {
  assert.deepEqual(
    parseCliArgs([
      "manifest.json",
      "--expect-channels",
      "14",
      "--expect-sample-rate",
      "48000",
      "--expect-frames-per-block",
      "960",
      "--expect-native-drops-zero",
    ]),
    {
      help: false,
      manifestPath: "manifest.json",
      options: {
        expectChannels: 14,
        expectSampleRate: 48000,
        expectFramesPerBlock: 960,
        expectNativeDropsZero: true,
      },
    },
  );
});

test("parseCliArgs rejects invalid options", () => {
  assert.throws(
    () => parseCliArgs(["manifest.json", "--expect-channels", "0"]),
    /--expect-channels must be a positive integer/,
  );
  assert.throws(
    () => parseCliArgs(["manifest.json", "--unknown", "1"]),
    /Unknown option --unknown/,
  );
});

function l12Options() {
  return {
    expectChannels: 14,
    expectSampleRate: 48000,
    expectFramesPerBlock: 960,
    expectNativeDropsZero: true,
  };
}

function createTwoChunkManifestWithGap() {
  const manifest = createStoppedManifest();
  const channels = manifest.channels;
  const framesPerBlock = manifest.framesPerBlock;
  const blockBytes = framesPerBlock * channels * 4;
  manifest.expectedNextFrame = framesPerBlock * 3;
  manifest.chunks = [
    {
      ...manifest.chunks[0],
      lastFrameStart: 0,
      lastFrameEnd: framesPerBlock,
      frames: framesPerBlock,
      blocksRecorded: 1,
      bytes: blockBytes,
      blocks: [manifest.chunks[0].blocks[0]],
    },
    {
      index: 1,
      fileName: "native-pcm-test-chunk-00001.f32",
      sampleFormat: "f32-interleaved",
      channels,
      firstFrameStart: framesPerBlock * 2,
      lastFrameStart: framesPerBlock * 2,
      lastFrameEnd: framesPerBlock * 3,
      frames: framesPerBlock,
      blocksRecorded: 1,
      bytes: blockBytes,
      startedAt: "2026-05-03T10:00:01.000Z",
      completedAt: "2026-05-03T10:00:02.000Z",
      blocks: [
        {
          frameStart: framesPerBlock * 2,
          frameCount: framesPerBlock,
          chunkOffsetBytes: 0,
          byteLength: blockBytes,
          receivedBlockIndex: 2,
        },
      ],
    },
  ];
  return manifest;
}

function createStoppedManifest() {
  const channels = 14;
  const framesPerBlock = 960;
  const blockBytes = framesPerBlock * channels * 4;
  return {
    type: "opendaw-native-audio-poc-recording",
    version: 1,
    sessionId: "native-pcm-test",
    state: "stopped",
    createdAt: "2026-05-03T10:00:00.000Z",
    startedAt: "2026-05-03T10:00:00.000Z",
    stoppedAt: "2026-05-03T10:00:01.000Z",
    sampleRate: 48000,
    channels,
    framesPerBlock,
    sampleFormat: "f32-interleaved",
    firstFrameStart: 0,
    expectedNextFrame: framesPerBlock * 2,
    totalRecordedFrames: framesPerBlock * 2,
    recordedBlocks: 2,
    counterDeltasAtStop: {
      underrunsDuringRecording: 0,
      overflowsDuringRecording: 0,
    },
    nativeInputStats: {
      start: nativeStats(),
      latest: nativeStats(),
      stop: nativeStats(),
      events: [],
    },
    writeBacklogHighWaterBlocks: 0,
    writeBacklogHighWaterBytes: 0,
    integrity: {
      gaps: [],
      overlaps: [],
      discontinuities: [],
      channelMismatches: [],
      invalidBlocks: [],
      websocketLagEvents: [],
      counterResets: [],
      writeBacklogEvents: [],
    },
    chunks: [
      {
        index: 0,
        fileName: "native-pcm-test-chunk-00000.f32",
        sampleFormat: "f32-interleaved",
        channels,
        firstFrameStart: 0,
        lastFrameStart: framesPerBlock,
        lastFrameEnd: framesPerBlock * 2,
        frames: framesPerBlock * 2,
        blocksRecorded: 2,
        bytes: blockBytes * 2,
        startedAt: "2026-05-03T10:00:00.000Z",
        completedAt: "2026-05-03T10:00:01.000Z",
        blocks: [
          {
            frameStart: 0,
            frameCount: framesPerBlock,
            chunkOffsetBytes: 0,
            byteLength: blockBytes,
            receivedBlockIndex: 1,
          },
          {
            frameStart: framesPerBlock,
            frameCount: framesPerBlock,
            chunkOffsetBytes: blockBytes,
            byteLength: blockBytes,
            receivedBlockIndex: 2,
          },
        ],
      },
    ],
  };
}

function createPartialRecoveredManifest() {
  const blockBytes = 14 * 960 * 4;
  return {
    type: "opendaw-native-audio-poc-recovered-recording",
    version: 1,
    recovered: true,
    recoveredAt: "2026-05-03T10:05:00.000Z",
    recoveryWarnings: [
      {
        code: "chunk-size-mismatch",
        message: "Chunk native-pcm-test-chunk-00001.f32 is size-mismatched",
        fileName: "native-pcm-test-chunk-00001.f32",
        fatal: true,
      },
    ],
    sessionId: "native-pcm-test",
    state: "abandoned",
    sampleRate: 48000,
    channels: 14,
    framesPerBlock: 960,
    sampleFormat: "f32-interleaved",
    nativeInputStats: {
      start: nativeStats(),
      latest: nativeStats(),
      stop: nativeStats(),
      events: [],
    },
    exportableWav: false,
    nonExportableReason: "one or more chunk files are truncated or size-mismatched",
    reconstructed: {
      frames: 960,
      bytes: blockBytes,
      chunks: 1,
      durationSeconds: 0.02,
    },
    chunks: [
      {
        index: 0,
        fileName: "native-pcm-test-chunk-00000.f32",
        listedInManifest: true,
        present: true,
        bytes: blockBytes,
        frames: 960,
        expectedBytes: blockBytes,
        manifestFrames: 960,
        firstFrameStart: 0,
        lastFrameStart: 0,
        lastFrameEnd: 960,
        blocksRecorded: 1,
        completedAt: "2026-05-03T10:00:01.000Z",
        lastModifiedAt: "2026-05-03T10:00:01.000Z",
        validForWav: true,
        fatalForWav: false,
        ignoredForWav: false,
        warnings: [],
      },
      {
        index: 1,
        fileName: "native-pcm-test-chunk-00001.f32",
        listedInManifest: true,
        present: true,
        bytes: blockBytes,
        frames: 960,
        expectedBytes: blockBytes * 2,
        manifestFrames: 1920,
        firstFrameStart: 960,
        lastFrameStart: 1920,
        lastFrameEnd: 2880,
        blocksRecorded: 2,
        completedAt: "2026-05-03T10:00:02.000Z",
        lastModifiedAt: "2026-05-03T10:00:02.000Z",
        validForWav: false,
        fatalForWav: true,
        ignoredForWav: false,
        warnings: [
          {
            code: "chunk-size-mismatch",
            message: "Chunk native-pcm-test-chunk-00001.f32 is size-mismatched",
            fileName: "native-pcm-test-chunk-00001.f32",
            fatal: true,
          },
        ],
      },
    ],
  };
}

function createRecoveredManifest() {
  return {
    type: "opendaw-native-audio-poc-recovered-recording",
    version: 1,
    recovered: true,
    recoveredAt: "2026-05-03T10:05:00.000Z",
    recoveryWarnings: [
      {
        code: "missing-chunk",
        message: "Chunk is missing",
        fileName: "native-pcm-test-chunk-00000.f32",
        fatal: true,
      },
    ],
    sessionId: "native-pcm-test",
    state: "abandoned",
    sampleRate: 48000,
    channels: 14,
    framesPerBlock: 960,
    sampleFormat: "f32-interleaved",
    nativeInputStats: {
      start: nativeStats(),
      latest: nativeStats(),
      stop: nativeStats(),
      events: [],
    },
    exportableWav: false,
    nonExportableReason: "one or more chunk files are missing",
    reconstructed: {
      frames: 0,
      bytes: 0,
      chunks: 0,
      durationSeconds: 0,
    },
    chunks: [],
  };
}

function nativeStats() {
  return {
    available: true,
    source: "input",
    nativeDroppedBlocks: 0,
    nativeDroppedFrames: 0,
    nativeDropEvents: 0,
    bridgeQueueCapacityBlocks: 64,
    atFrame: 0,
    receivedAt: "2026-05-03T10:00:00.000Z",
  };
}

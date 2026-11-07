import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

for (const shift of [960, -480, -1920]) {
  test(`inspectManifest derives intra-chunk continuity with a middle block shift of ${shift}`, () => {
    const manifest = createThreeBlockManifest(1920);
    manifest.chunks[0].blocks[1].frameStart += shift;
    const result = inspectManifest(manifest);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /blocks\[1\]\.frameStart expected 2880/);
  });
}

test("inspectManifest accepts contiguous blocks starting at a nonzero frame", () => {
  assert.equal(inspectManifest(createThreeBlockManifest(1920)).ok, true);
});

test("inspectManifest accepts contiguous chunks with a nonzero initial frame", () => {
  const manifest = createTwoChunkManifestWithGap();
  manifest.firstFrameStart = manifest.chunks[0].firstFrameStart = 960;
  manifest.chunks[0].lastFrameStart = manifest.chunks[0].blocks[0].frameStart = 960;
  manifest.chunks[0].lastFrameEnd = 1920;
  assert.equal(inspectManifest(manifest, { finalAcceptance: true }).ok, true);
});

function createThreeBlockManifest(firstFrameStart = 0) {
  const manifest = createStoppedManifest();
  const chunk = manifest.chunks[0];
  const blockBytes = chunk.blocks[0].byteLength;
  chunk.blocks.push({ ...chunk.blocks[1], frameStart: 1920, chunkOffsetBytes: blockBytes * 2 });
  for (const block of chunk.blocks) block.frameStart += firstFrameStart;
  chunk.firstFrameStart = manifest.firstFrameStart = firstFrameStart;
  chunk.lastFrameStart = firstFrameStart + 1920;
  chunk.lastFrameEnd = manifest.expectedNextFrame = firstFrameStart + 2880;
  chunk.frames = manifest.totalRecordedFrames = 2880;
  chunk.blocksRecorded = manifest.recordedBlocks = 3;
  chunk.bytes = blockBytes * 3;
  return manifest;
}

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

test("final acceptance accepts a complete stopped recording", () => {
  assert.equal(inspectManifest(createStoppedManifest(), { finalAcceptance: true }).ok, true);
});

for (const [label, mutate] of [
  ["active state", (m) => { m.state = "recording"; }],
  ["interrupted state", (m) => { m.state = "interrupted"; }],
  ["missing state", (m) => { delete m.state; }],
  ["missing stop timestamp", (m) => { m.stoppedAt = null; }],
  ["invalid stop timestamp", (m) => { m.stoppedAt = "invalid"; }],
  ["missing block evidence", (m) => { delete m.chunks[0].blocks; }],
  ["unclosed chunk", (m) => { m.chunks[0].completedAt = null; }],
  ["empty recording", (m) => {
    m.chunks = []; m.totalRecordedFrames = 0; m.recordedBlocks = 0;
    m.firstFrameStart = null; m.expectedNextFrame = null;
  }],
]) {
  test(`final acceptance rejects ${label}`, () => {
    const manifest = createStoppedManifest();
    mutate(manifest);
    assert.equal(inspectManifest(manifest, { finalAcceptance: true }).ok, false);
  });
}

test("exploratory inspection preserves missing-block and recovery warnings", () => {
  const manifest = createStoppedManifest();
  delete manifest.chunks[0].blocks;
  const result = inspectManifest(manifest);
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /internal block continuity was not validated/);

  const recovered = createPartialRecoveredManifest();
  recovered.chunks.pop();
  recovered.recoveryWarnings = [];
  recovered.exportableWav = true;
  assert.equal(inspectManifest(recovered).ok, true);
  assert.equal(inspectManifest(recovered, { finalAcceptance: true }).ok, false);
});

test("empty recorder manifests remain inspectable but cannot pass final acceptance", () => {
  const manifest = createStoppedManifest();
  manifest.chunks = [];
  manifest.firstFrameStart = manifest.expectedNextFrame = null;
  manifest.totalRecordedFrames = manifest.recordedBlocks = 0;
  assert.equal(inspectManifest(manifest).ok, true);
  const result = inspectManifest(manifest, { finalAcceptance: true });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /requires complete, nonempty block metadata/);
});

test("documented acceptance recipe runs the strict CLI on synthetic manifests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "manifest-inspector-"));
  const fileName = path.join(directory, "manifest.json");
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  try {
    for (const kind of ["stopped", "active", "missing-blocks"]) {
      const manifest = createStoppedManifest();
      if (kind === "active") manifest.state = "recording";
      if (kind === "missing-blocks") delete manifest.chunks[0].blocks;
      await writeFile(fileName, JSON.stringify(manifest));
      const result = spawnSync("just", ["inspect-recording", fileName], { cwd, encoding: "utf8" });
      assert.ifError(result.error);
      assert.equal(result.status, kind === "stopped" ? 0 : 1, result.stdout + result.stderr);
      assert.match(result.stdout, /Mode: final acceptance/);
    }
    const result = spawnSync(process.execPath, ["scripts/inspect-recording-manifest.mjs", fileName],
      { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Mode: exploratory/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      "--final",
    ]),
    {
      help: false,
      manifestPath: "manifest.json",
      options: {
        expectChannels: 14,
        expectSampleRate: 48000,
        expectFramesPerBlock: 960,
        expectNativeDropsZero: true,
        finalAcceptance: true,
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

const geometryPaths = [
  ["sampleRate"], ["channels"], ["framesPerBlock"], ["version"],
  ["firstFrameStart"], ["expectedNextFrame"], ["recordedBlocks"], ["totalRecordedFrames"],
  ["chunks", 0, "frames"], ["chunks", 0, "bytes"], ["chunks", 0, "blocksRecorded"],
  ["chunks", 0, "channels"], ["chunks", 0, "index"],
  ["chunks", 0, "firstFrameStart"], ["chunks", 0, "lastFrameStart"], ["chunks", 0, "lastFrameEnd"],
  ...["frameStart", "frameCount", "chunkOffsetBytes", "byteLength", "receivedBlockIndex"]
    .map((key) => ["chunks", 0, "blocks", 0, key]),
];
for (const keys of geometryPaths) {
  for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1, -1, "960", null]) {
    test(`inspectManifest rejects ${keys.join(".")} = ${JSON.stringify(value)}`, () => {
      const manifest = createStoppedManifest();
      const parent = keys.slice(0, -1).reduce((object, key) => object[key], manifest);
      parent[keys.at(-1)] = value;
      assert.equal(inspectManifest(manifest).ok, false);
    });
  }
}

test("inspectManifest only supports manifest version 1", () => {
  const manifest = createStoppedManifest();
  manifest.version = 2;
  assert.equal(inspectManifest(manifest).ok, false);
});

test("inspectManifest checks frame-end addition before comparing rounded summaries", () => {
  const manifest = createThreeBlockManifest(Number.MAX_SAFE_INTEGER - 1000);
  const result = inspectManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /frame end.*safe integer/);
});

test("inspectManifest checks byte products and accumulated totals for overflow", () => {
  const manifest = createStoppedManifest();
  const frames = 2 ** 46;
  const bytes = frames * 14 * 4;
  const chunk = manifest.chunks[0];
  chunk.blocks = [{ frameStart: 0, frameCount: frames, chunkOffsetBytes: 0, byteLength: bytes }];
  chunk.frames = chunk.lastFrameEnd = frames;
  chunk.bytes = bytes;
  chunk.lastFrameStart = 0;
  chunk.blocksRecorded = 1;
  manifest.chunks = [chunk, { ...chunk, firstFrameStart: frames, lastFrameStart: frames,
    lastFrameEnd: frames * 2, blocks: [{ ...chunk.blocks[0], frameStart: frames }] },
    { ...chunk, firstFrameStart: frames * 2, lastFrameStart: frames * 2,
      lastFrameEnd: frames * 3, blocks: [{ ...chunk.blocks[0], frameStart: frames * 2 }] }];
  manifest.totalRecordedFrames = manifest.expectedNextFrame = frames * 3;
  manifest.recordedBlocks = 3;
  const result = inspectManifest(manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /total bytes.*safe integer/);

  manifest.channels = 2 ** 51;
  const productResult = inspectManifest(manifest);
  assert.equal(productResult.ok, false);
  assert.match(productResult.errors.join("\n"), /bytes per frame.*safe integer/);
});

test("inspectManifest validates optional recovered geometry and keeps fractional duration", () => {
  const manifest = createPartialRecoveredManifest();
  manifest.chunks.pop();
  manifest.recoveryWarnings = [];
  manifest.exportableWav = true;
  assert.equal(inspectManifest(manifest).ok, true);
  assert.equal(inspectManifest(manifest).summary.durationSeconds, 0.02);
  for (const [object, key] of [[manifest.reconstructed, "frames"], [manifest.reconstructed, "bytes"],
    [manifest.reconstructed, "chunks"], [manifest.chunks[0], "expectedBytes"],
    [manifest.chunks[0], "manifestFrames"]]) {
    const previous = object[key];
    object[key] = 0.5;
    const result = inspectManifest(manifest);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /safe integer/);
    object[key] = previous;
  }
});

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


test("inspectManifest rejects an uncommitted chunk after close failure", () => {
  const manifest = createStoppedManifest();
  manifest.state = "error";
  manifest.stoppedAt = null;
  manifest.chunks[0].completedAt = null;
  manifest.chunks[0].closeError = "synthetic quota-close failure";
  const result = inspectManifest(manifest, l12Options());
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /chunks\[0\].*failed to close.*uncommitted/);
});

import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BYTES_PER_SAMPLE = 4;
const DEFAULT_SAMPLE_FORMAT = "f32-interleaved";
const CONTINUITY_ARRAYS = [
  "gaps",
  "overlaps",
  "discontinuities",
  "channelMismatches",
  "invalidBlocks",
];
const COUNTER_ARRAYS = [
  "websocketLagEvents",
  "counterResets",
  "writeBacklogEvents",
];
const NATIVE_DROP_FIELDS = [
  ["nativeDroppedBlocks", "dropped callback buffers"],
  ["nativeDroppedFrames", "dropped frames"],
  ["nativeDropEvents", "drop events"],
];

export function inspectManifest(manifest, options = {}) {
  const errors = [];
  const warnings = [];
  const summary = {
    recovered: false,
    recoveryWarnings: 0,
    fatalRecoveryWarnings: 0,
    chunks: 0,
    frames: 0,
    blocks: 0,
    bytes: 0,
    durationSeconds: null,
    continuity: {},
    counters: {},
    nativeDropDeltas: null,
  };

  if (!isObject(manifest)) {
    return {
      ok: false,
      errors: ["Manifest must be a JSON object"],
      warnings,
      summary,
    };
  }

  summary.type = stringOrNull(manifest.type);
  summary.sessionId = stringOrNull(manifest.sessionId);
  summary.state = stringOrNull(manifest.state);
  summary.startedAt = stringOrNull(manifest.startedAt);
  summary.stoppedAt = stringOrNull(manifest.stoppedAt ?? manifest.originalStoppedAt);
  summary.recovered = manifest.recovered === true || manifest.recoveryWarnings !== undefined;

  validateManifestIdentity(manifest, errors, summary);
  inspectManifestState(warnings, summary);
  validateStreamShape(manifest, options, errors, summary);
  inspectRecovery(manifest, errors, warnings, summary);
  inspectIntegrity(manifest, errors, warnings, summary);

  const chunkResult = inspectChunks(manifest, errors, warnings);
  summary.chunks = chunkResult.chunkCount;
  summary.frames = chunkResult.totalFrames;
  summary.blocks = chunkResult.totalBlocks;
  summary.bytes = chunkResult.totalBytes;

  validateManifestTotals(manifest, chunkResult, errors, warnings, summary);
  inspectCounterSummaries(manifest, warnings, summary);
  inspectNativeDrops(manifest, options, errors, warnings, summary);

  if (Number.isFinite(summary.sampleRate) && summary.sampleRate > 0) {
    summary.durationSeconds = summary.frames / summary.sampleRate;
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}

export function formatInspectionReport(result) {
  const lines = [];
  const { summary } = result;
  lines.push(`Recording manifest inspection: ${result.ok ? "PASS" : "FAIL"}`);
  lines.push(`Session: ${summary.sessionId ?? "<unknown>"}`);
  lines.push(`Type: ${summary.type ?? "<unknown>"}${summary.recovered ? " (recovered)" : ""}`);
  lines.push(`State: ${summary.state ?? "<unknown>"}`);
  lines.push(
    `Shape: ${formatNumber(summary.channels)} channels, ${formatNumber(summary.sampleRate)} Hz, ${formatNumber(summary.framesPerBlock)} frames/block, ${summary.sampleFormat ?? "<unknown>"}`,
  );
  lines.push(
    `Recorded: ${formatNumber(summary.frames)} frames, ${formatNumber(summary.blocks)} blocks, ${formatNumber(summary.chunks)} chunks, ${formatBytes(summary.bytes)}`,
  );
  if (summary.durationSeconds !== null) {
    lines.push(`Duration: ${summary.durationSeconds.toFixed(3)} seconds`);
  }
  lines.push(
    `Continuity: gaps=${summary.continuity.gaps ?? "unknown"} overlaps=${summary.continuity.overlaps ?? "unknown"} discontinuities=${summary.continuity.discontinuities ?? "unknown"} channelMismatches=${summary.continuity.channelMismatches ?? "unknown"} invalidBlocks=${summary.continuity.invalidBlocks ?? "unknown"}`,
  );
  lines.push(
    `Monitor/browser counters: underruns=${summary.counters.underrunsDuringRecording ?? "unknown"} overflows=${summary.counters.overflowsDuringRecording ?? "unknown"} websocketLag=${summary.counters.websocketLagEvents ?? "unknown"} counterResets=${summary.counters.counterResets ?? "unknown"} writeBacklog=${summary.counters.writeBacklogEvents ?? "unknown"}`,
  );
  lines.push(
    `Write backlog high-water: ${formatNumber(summary.counters.writeBacklogHighWaterBlocks)} blocks, ${formatBytes(summary.counters.writeBacklogHighWaterBytes ?? 0)}`,
  );
  if (summary.nativeDropDeltas) {
    lines.push(
      `Native drops during recording: blocks=${summary.nativeDropDeltas.nativeDroppedBlocks} frames=${summary.nativeDropDeltas.nativeDroppedFrames} events=${summary.nativeDropDeltas.nativeDropEvents}`,
    );
  } else {
    lines.push("Native drops during recording: unknown");
  }
  if (summary.recovered) {
    lines.push(
      `Recovery: warnings=${summary.recoveryWarnings} fatal=${summary.fatalRecoveryWarnings} exportableWav=${summary.exportableWav ?? "unknown"}`,
    );
  }
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of result.warnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (result.errors.length > 0) {
    lines.push("");
    lines.push("Errors:");
    for (const error of result.errors) {
      lines.push(`- ${error}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function parseCliArgs(argv) {
  const options = {};
  let manifestPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, manifestPath, options };
    }
    if (!arg.startsWith("--")) {
      if (manifestPath) {
        throw new Error(`Unexpected extra argument ${JSON.stringify(arg)}`);
      }
      manifestPath = arg;
      continue;
    }
    if (arg === "--expect-native-drops-zero") {
      options.expectNativeDropsZero = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--expect-channels") {
      options.expectChannels = parsePositiveIntOption(arg, value);
    } else if (arg === "--expect-sample-rate") {
      options.expectSampleRate = parsePositiveIntOption(arg, value);
    } else if (arg === "--expect-frames-per-block") {
      options.expectFramesPerBlock = parsePositiveIntOption(arg, value);
    } else if (arg === "--expect-sample-format") {
      options.expectSampleFormat = value;
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  return { help: false, manifestPath, options };
}

async function main() {
  try {
    const { help, manifestPath, options } = parseCliArgs(process.argv.slice(2));
    if (help) {
      console.log(usage());
      return;
    }
    if (!manifestPath) {
      throw new Error("Missing manifest path");
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const result = inspectManifest(manifest, options);
    process.stdout.write(formatInspectionReport(result));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function validateManifestIdentity(manifest, errors, summary) {
  const expectedType = summary.recovered
    ? "opendaw-native-audio-poc-recovered-recording"
    : "opendaw-native-audio-poc-recording";
  if (summary.type === null) {
    errors.push("type must be a string");
    return;
  }
  if (
    summary.type !== "opendaw-native-audio-poc-recording" &&
    summary.type !== "opendaw-native-audio-poc-recovered-recording"
  ) {
    errors.push(`type must be ${expectedType}, got ${summary.type}`);
    return;
  }
  if (summary.type !== expectedType) {
    errors.push(`type must be ${expectedType} when recovered is ${summary.recovered}`);
  }
  if (typeof manifest.version !== "number") {
    errors.push("version must be a number");
  }
}

function inspectManifestState(warnings, summary) {
  if (summary.state === null) {
    warnings.push("state is missing or not a string");
    return;
  }
  if (!summary.recovered && summary.state !== "stopped") {
    warnings.push(`Manifest state is ${summary.state}; inspect a stopped manifest for final recording proof.`);
  }
}

function validateStreamShape(manifest, options, errors, summary) {
  const sampleRate = finiteNumberOrNull(manifest.sampleRate);
  const channels = finiteNumberOrNull(manifest.channels);
  const framesPerBlock = finiteNumberOrNull(manifest.framesPerBlock);
  const sampleFormat = stringOrNull(manifest.sampleFormat);
  summary.sampleRate = sampleRate;
  summary.channels = channels;
  summary.framesPerBlock = framesPerBlock;
  summary.sampleFormat = sampleFormat;

  requirePositiveNumber("sampleRate", sampleRate, errors);
  requirePositiveNumber("channels", channels, errors);
  requirePositiveNumber("framesPerBlock", framesPerBlock, errors);
  if (sampleFormat === null) {
    errors.push("sampleFormat must be a string");
  }

  const expectedFormat = options.expectSampleFormat ?? DEFAULT_SAMPLE_FORMAT;
  if (sampleFormat !== null && sampleFormat !== expectedFormat) {
    errors.push(`sampleFormat expected ${expectedFormat}, got ${sampleFormat}`);
  }
  if (options.expectChannels !== undefined && channels !== null && channels !== options.expectChannels) {
    errors.push(`channels expected ${options.expectChannels}, got ${formatValue(channels)}`);
  }
  if (
    options.expectSampleRate !== undefined &&
    sampleRate !== null &&
    sampleRate !== options.expectSampleRate
  ) {
    errors.push(`sampleRate expected ${options.expectSampleRate}, got ${formatValue(sampleRate)}`);
  }
  if (
    options.expectFramesPerBlock !== undefined &&
    framesPerBlock !== null &&
    framesPerBlock !== options.expectFramesPerBlock
  ) {
    errors.push(
      `framesPerBlock expected ${options.expectFramesPerBlock}, got ${formatValue(framesPerBlock)}`,
    );
  }
}

function inspectRecovery(manifest, errors, warnings, summary) {
  if (!summary.recovered && manifest.recoveryWarnings === undefined) {
    return;
  }
  summary.recovered = true;
  summary.exportableWav =
    typeof manifest.exportableWav === "boolean" ? manifest.exportableWav : undefined;
  if (!Array.isArray(manifest.recoveryWarnings)) {
    errors.push("recoveryWarnings must be an array on recovered manifests");
    return;
  }
  summary.recoveryWarnings = manifest.recoveryWarnings.length;
  for (const [index, warning] of manifest.recoveryWarnings.entries()) {
    if (!isObject(warning)) {
      errors.push(`recoveryWarnings[${index}] must be an object`);
      continue;
    }
    const message = stringOrNull(warning.message) ?? stringOrNull(warning.code) ?? "recovery warning";
    if (warning.fatal === true) {
      summary.fatalRecoveryWarnings += 1;
      errors.push(`Fatal recovery warning: ${message}`);
    } else {
      warnings.push(`Recovery warning: ${message}`);
    }
  }
  if (manifest.exportableWav === false) {
    warnings.push(
      `Recovered WAV export is not clean: ${stringOrNull(manifest.nonExportableReason) ?? "unknown reason"}`,
    );
  }
}

function inspectIntegrity(manifest, errors, warnings, summary) {
  if (!isObject(manifest.integrity)) {
    if (summary.recovered) {
      warnings.push("Recovered manifest has no top-level integrity arrays; relying on recovered chunk metadata.");
    } else {
      errors.push("integrity must be an object");
    }
    return;
  }

  for (const name of CONTINUITY_ARRAYS) {
    const entries = manifest.integrity[name];
    if (!Array.isArray(entries)) {
      errors.push(`integrity.${name} must be an array`);
      summary.continuity[name] = "unknown";
      continue;
    }
    summary.continuity[name] = entries.length;
    if (entries.length > 0) {
      errors.push(`integrity.${name} has ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
    }
  }

  for (const name of COUNTER_ARRAYS) {
    const entries = manifest.integrity[name];
    if (!Array.isArray(entries)) {
      warnings.push(`integrity.${name} is missing or not an array`);
      summary.counters[name] = "unknown";
      continue;
    }
    summary.counters[name] = entries.length;
    if (entries.length > 0) {
      warnings.push(`integrity.${name} has ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
    }
  }
}

function inspectChunks(manifest, errors, warnings) {
  if (!Array.isArray(manifest.chunks)) {
    errors.push("chunks must be an array");
    return {
      chunkCount: 0,
      totalFrames: 0,
      totalBlocks: 0,
      totalBytes: 0,
      fullBlockMetadata: false,
      firstFrameStart: null,
      lastFrameEnd: null,
    };
  }

  const channels = finiteNumberOrNull(manifest.channels);
  const bytesPerFrame = channels === null ? null : channels * BYTES_PER_SAMPLE;
  let totalFrames = 0;
  let totalBlocks = 0;
  let totalBytes = 0;
  let fullBlockMetadata = true;
  let firstFrameStart = null;
  let previousLastFrameEnd = null;
  let hasRecoveredValidity = false;
  let validRecoveredFrames = 0;
  let validRecoveredBytes = 0;
  let validRecoveredChunks = 0;

  for (const [chunkIndex, chunk] of manifest.chunks.entries()) {
    const prefix = `chunks[${chunkIndex}]`;
    if (!isObject(chunk)) {
      errors.push(`${prefix} must be an object`);
      fullBlockMetadata = false;
      continue;
    }
    const frames = finiteNumberOrNull(chunk.frames);
    const bytes = finiteNumberOrNull(chunk.bytes);
    const blocksRecorded = finiteNumberOrNull(chunk.blocksRecorded);
    totalFrames += frames ?? 0;
    totalBytes += bytes ?? 0;
    if (blocksRecorded !== null) {
      totalBlocks += blocksRecorded;
    }
    if (typeof chunk.validForWav === "boolean") {
      hasRecoveredValidity = true;
      if (chunk.validForWav) {
        validRecoveredChunks += 1;
        validRecoveredFrames += frames ?? 0;
        validRecoveredBytes += bytes ?? 0;
      }
    }

    if (stringOrNull(chunk.sampleFormat) !== null && chunk.sampleFormat !== DEFAULT_SAMPLE_FORMAT) {
      errors.push(`${prefix}.sampleFormat expected ${DEFAULT_SAMPLE_FORMAT}, got ${chunk.sampleFormat}`);
    }
    if (channels !== null && finiteNumberOrNull(chunk.channels) !== null && chunk.channels !== channels) {
      errors.push(`${prefix}.channels expected ${channels}, got ${chunk.channels}`);
    }
    if (bytesPerFrame !== null && frames !== null && bytes !== null && bytes !== frames * bytesPerFrame) {
      errors.push(`${prefix}.bytes expected ${frames * bytesPerFrame}, got ${bytes}`);
    }

    if (!Array.isArray(chunk.blocks)) {
      fullBlockMetadata = false;
      inspectRecoveredChunkSummary(chunk, prefix, errors, warnings);
      continue;
    }

    const blockResult = inspectChunkBlocks(chunk, prefix, bytesPerFrame, errors);
    if (blocksRecorded !== null && blocksRecorded !== chunk.blocks.length) {
      errors.push(`${prefix}.blocksRecorded expected ${chunk.blocks.length}, got ${blocksRecorded}`);
    }
    if (frames !== null && frames !== blockResult.frames) {
      errors.push(`${prefix}.frames expected block frame sum ${blockResult.frames}, got ${frames}`);
    }
    if (bytes !== null && bytes !== blockResult.bytes) {
      errors.push(`${prefix}.bytes expected block byte sum ${blockResult.bytes}, got ${bytes}`);
    }
    if (blockResult.blockCount > 0) {
      totalBlocks = totalBlocks - (blocksRecorded ?? 0) + blockResult.blockCount;
      const blockFirstFrameStart = blockResult.firstFrameStart;
      const blockLastFrameStart = blockResult.lastFrameStart;
      const blockLastFrameEnd = blockResult.lastFrameEnd;
      if (firstFrameStart === null) {
        firstFrameStart = blockFirstFrameStart;
      }
      if (previousLastFrameEnd !== null && blockFirstFrameStart !== previousLastFrameEnd) {
        errors.push(
          `${prefix}.firstFrameStart expected ${previousLastFrameEnd} after previous chunk, got ${blockFirstFrameStart}`,
        );
      }
      previousLastFrameEnd = blockLastFrameEnd;
      checkEqual(`${prefix}.firstFrameStart`, chunk.firstFrameStart, blockFirstFrameStart, errors);
      checkEqual(`${prefix}.lastFrameStart`, chunk.lastFrameStart, blockLastFrameStart, errors);
      checkEqual(`${prefix}.lastFrameEnd`, chunk.lastFrameEnd, blockLastFrameEnd, errors);
    }
  }

  return {
    chunkCount: manifest.chunks.length,
    totalFrames,
    totalBlocks,
    totalBytes,
    fullBlockMetadata,
    firstFrameStart,
    lastFrameEnd: previousLastFrameEnd,
    recovered: {
      hasValidity: hasRecoveredValidity,
      frames: validRecoveredFrames,
      bytes: validRecoveredBytes,
      chunks: validRecoveredChunks,
    },
  };
}

function inspectChunkBlocks(chunk, prefix, bytesPerFrame, errors) {
  let frames = 0;
  let bytes = 0;
  let expectedOffset = 0;
  let firstFrameStart = null;
  let lastFrameStart = null;
  let lastFrameEnd = null;

  for (const [blockIndex, block] of chunk.blocks.entries()) {
    const blockPrefix = `${prefix}.blocks[${blockIndex}]`;
    if (!isObject(block)) {
      errors.push(`${blockPrefix} must be an object`);
      continue;
    }
    const frameStart = finiteNumberOrNull(block.frameStart);
    const frameCount = finiteNumberOrNull(block.frameCount);
    const chunkOffsetBytes = finiteNumberOrNull(block.chunkOffsetBytes);
    const byteLength = finiteNumberOrNull(block.byteLength);
    requireNonNegativeNumber(`${blockPrefix}.frameStart`, frameStart, errors);
    requirePositiveNumber(`${blockPrefix}.frameCount`, frameCount, errors);
    requireNonNegativeNumber(`${blockPrefix}.chunkOffsetBytes`, chunkOffsetBytes, errors);
    requireNonNegativeNumber(`${blockPrefix}.byteLength`, byteLength, errors);

    if (frameStart !== null && frameCount !== null) {
      firstFrameStart ??= frameStart;
      lastFrameStart = frameStart;
      lastFrameEnd = frameStart + frameCount;
    }
    if (frameCount !== null) {
      frames += frameCount;
    }
    if (byteLength !== null) {
      bytes += byteLength;
    }
    if (chunkOffsetBytes !== null && chunkOffsetBytes !== expectedOffset) {
      errors.push(`${blockPrefix}.chunkOffsetBytes expected ${expectedOffset}, got ${chunkOffsetBytes}`);
    }
    if (
      bytesPerFrame !== null &&
      frameCount !== null &&
      byteLength !== null &&
      byteLength !== frameCount * bytesPerFrame
    ) {
      errors.push(`${blockPrefix}.byteLength expected ${frameCount * bytesPerFrame}, got ${byteLength}`);
    }
    expectedOffset += byteLength ?? 0;
  }

  return {
    blockCount: chunk.blocks.length,
    frames,
    bytes,
    firstFrameStart,
    lastFrameStart,
    lastFrameEnd,
  };
}

function inspectRecoveredChunkSummary(chunk, prefix, errors, warnings) {
  const hasRecoveredShape =
    "expectedBytes" in chunk ||
    "manifestFrames" in chunk ||
    "validForWav" in chunk ||
    Array.isArray(chunk.warnings);
  if (!hasRecoveredShape) {
    warnings.push(`${prefix} has no block metadata; internal block continuity was not validated`);
    return;
  }
  if (chunk.expectedBytes !== null && chunk.expectedBytes !== undefined && chunk.expectedBytes !== chunk.bytes) {
    errors.push(`${prefix}.bytes expected recovered expectedBytes ${chunk.expectedBytes}, got ${chunk.bytes}`);
  }
  if (
    chunk.manifestFrames !== null &&
    chunk.manifestFrames !== undefined &&
    chunk.frames !== null &&
    chunk.frames !== undefined &&
    chunk.manifestFrames !== chunk.frames
  ) {
    errors.push(`${prefix}.frames expected recovered manifestFrames ${chunk.manifestFrames}, got ${chunk.frames}`);
  }
  warnings.push(`${prefix} has recovered chunk metadata without block lists; raw .f32 files were not inspected`);
}

function validateManifestTotals(manifest, chunkResult, errors, warnings, summary) {
  checkEqual("totalRecordedFrames", manifest.totalRecordedFrames, chunkResult.totalFrames, errors, {
    optional: summary.recovered,
  });
  if (summary.recovered && isObject(manifest.reconstructed)) {
    const reconstructedTarget = chunkResult.recovered.hasValidity
      ? chunkResult.recovered
      : {
          frames: chunkResult.totalFrames,
          bytes: chunkResult.totalBytes,
          chunks: chunkResult.chunkCount,
        };
    checkEqual("reconstructed.frames", manifest.reconstructed.frames, reconstructedTarget.frames, errors);
    checkEqual("reconstructed.bytes", manifest.reconstructed.bytes, reconstructedTarget.bytes, errors);
    checkEqual("reconstructed.chunks", manifest.reconstructed.chunks, reconstructedTarget.chunks, errors);
  }
  if (chunkResult.fullBlockMetadata) {
    checkEqual("recordedBlocks", manifest.recordedBlocks, chunkResult.totalBlocks, errors, {
      optional: summary.recovered,
    });
  } else if (manifest.recordedBlocks !== undefined) {
    warnings.push("recordedBlocks was not fully validated because one or more chunks lack block metadata");
  }
  if (chunkResult.chunkCount > 0 && chunkResult.firstFrameStart !== null) {
    checkEqual("firstFrameStart", manifest.firstFrameStart, chunkResult.firstFrameStart, errors, {
      optional: summary.recovered,
    });
    checkEqual("expectedNextFrame", manifest.expectedNextFrame, chunkResult.lastFrameEnd, errors, {
      optional: summary.recovered,
    });
  }
}

function inspectCounterSummaries(manifest, warnings, summary) {
  const deltas = manifest.counterDeltasAtStop;
  if (isObject(deltas)) {
    summary.counters.underrunsDuringRecording = finiteNumberOrNull(deltas.underrunsDuringRecording);
    summary.counters.overflowsDuringRecording = finiteNumberOrNull(deltas.overflowsDuringRecording);
    if ((summary.counters.underrunsDuringRecording ?? 0) > 0) {
      warnings.push(`Monitor underruns during recording: ${summary.counters.underrunsDuringRecording}`);
    }
    if ((summary.counters.overflowsDuringRecording ?? 0) > 0) {
      warnings.push(`Monitor overflows during recording: ${summary.counters.overflowsDuringRecording}`);
    }
  } else {
    summary.counters.underrunsDuringRecording = "unknown";
    summary.counters.overflowsDuringRecording = "unknown";
    if (!summary.recovered) {
      warnings.push("counterDeltasAtStop is missing; monitor underrun/overflow deltas are unknown");
    }
  }

  summary.counters.writeBacklogHighWaterBlocks = finiteNumberOrNull(manifest.writeBacklogHighWaterBlocks);
  summary.counters.writeBacklogHighWaterBytes = finiteNumberOrNull(manifest.writeBacklogHighWaterBytes);
  if ((summary.counters.writeBacklogHighWaterBlocks ?? 0) > 0) {
    warnings.push(`Write backlog high-water blocks: ${summary.counters.writeBacklogHighWaterBlocks}`);
  }
  if ((summary.counters.writeBacklogHighWaterBytes ?? 0) > 0) {
    warnings.push(`Write backlog high-water bytes: ${summary.counters.writeBacklogHighWaterBytes}`);
  }
}

function inspectNativeDrops(manifest, options, errors, warnings, summary) {
  const stats = manifest.nativeInputStats;
  const nativeDropResult = nativeDropDeltas(stats);
  const deltas = nativeDropResult.deltas;
  summary.nativeDropDeltas = deltas;
  if (isObject(stats?.start) && stats.start.available === false) {
    warnings.push("nativeInputStats.start reports native stats unavailable");
  }
  if (isObject(stats?.stop) && stats.stop.available === false) {
    warnings.push("nativeInputStats.stop reports native stats unavailable");
  }
  if (!options.expectNativeDropsZero) {
    return;
  }
  if (nativeDropResult.errors.length > 0) {
    errors.push(...nativeDropResult.errors);
    return;
  }
  if (!deltas) {
    errors.push(
      "nativeInputStats.start and nativeInputStats.stop/latest are required when --expect-native-drops-zero is set",
    );
    return;
  }
  for (const [field, label] of NATIVE_DROP_FIELDS) {
    if (deltas[field] > 0) {
      errors.push(`Native ${label} increased during recording: ${deltas[field]}`);
    }
  }
}

function nativeDropDeltas(stats) {
  if (!isObject(stats) || !isObject(stats.start)) {
    return {
      deltas: null,
      errors: [
        "nativeInputStats.start and nativeInputStats.stop/latest are required when --expect-native-drops-zero is set",
      ],
    };
  }
  const end = isObject(stats.stop) ? stats.stop : stats.latest;
  if (!isObject(end)) {
    return {
      deltas: null,
      errors: [
        "nativeInputStats.start and nativeInputStats.stop/latest are required when --expect-native-drops-zero is set",
      ],
    };
  }
  const deltas = {};
  const errors = [];
  for (const [field] of NATIVE_DROP_FIELDS) {
    const start = finiteNumberOrNull(stats.start[field]);
    const stop = finiteNumberOrNull(end[field]);
    if (start === null || stop === null) {
      errors.push(`nativeInputStats.${field} must be numeric at start and stop/latest`);
      continue;
    }
    if (stop < start) {
      errors.push(
        `nativeInputStats.${field} decreased between start and stop/latest (${start} -> ${stop}); possible counter reset`,
      );
      continue;
    }
    deltas[field] = stop - start;
  }
  if (errors.length > 0) {
    return { deltas: null, errors };
  }
  return { deltas, errors: [] };
}

function checkEqual(label, actual, expected, errors, { optional = false } = {}) {
  if (actual === undefined || actual === null) {
    if (!optional) {
      errors.push(`${label} must be present`);
    }
    return;
  }
  if (actual !== expected) {
    errors.push(`${label} expected ${expected}, got ${formatValue(actual)}`);
  }
}

function requirePositiveNumber(label, value, errors) {
  if (value === null || value <= 0) {
    errors.push(`${label} must be a positive number`);
  }
}

function requireNonNegativeNumber(label, value, errors) {
  if (value === null || value < 0) {
    errors.push(`${label} must be a non-negative number`);
  }
}

function parsePositiveIntOption(name, raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "unknown";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : "unknown";
}

function formatValue(value) {
  return value === null ? "null" : JSON.stringify(value);
}

function usage() {
  return `Usage: node scripts/inspect-recording-manifest.mjs <manifest.json> [options]

Options:
  --expect-channels <n>            Require channel count
  --expect-sample-rate <n>         Require sample rate
  --expect-frames-per-block <n>    Require frames per block
  --expect-sample-format <format>  Require sample format (default: ${DEFAULT_SAMPLE_FORMAT})
  --expect-native-drops-zero       Fail if native drop counters increased
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

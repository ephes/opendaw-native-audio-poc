import { createMonoFloat32WavBlob, extractChannel } from "./wav.js";

const CHUNK_TARGET_BYTES = 64 * 1024 * 1024;
const BYTES_PER_SAMPLE = 4;
const STATUS_INTERVAL_MS = 500;
const BACKLOG_WARNING_BYTES = 64 * 1024 * 1024;
const INDEX_FILE_NAME = "native-pcm-recordings-index.json";
const ARTIFACT_PREFIX = "native-pcm-";
const MANIFEST_SUFFIX = "-manifest.json";
const CHUNK_NAME_RE = /^(native-pcm-.+)-chunk-(\d+)\.f32$/;

export class PcmRecorder {
  constructor({ readCounters, postMessage }) {
    this.readCounters = readCounters;
    this.postMessage = postMessage;
    this.root = null;
    this.session = null;
    this.currentChunk = null;
    this.state = "idle";
    this.writeChain = Promise.resolve();
    this.pendingWriteBlocks = 0;
    this.pendingWriteBytes = 0;
    this.writeBacklogHighWaterBlocks = 0;
    this.writeBacklogHighWaterBytes = 0;
    this.nextBacklogWarningBytes = BACKLOG_WARNING_BYTES;
    this.lastStatusPost = 0;
    this.lastError = "";
    this.nativeInputStats = defaultNativeInputStats();
  }

  setNativeInputStats(stats) {
    const normalized = normalizeNativeInputStats(stats);
    const previous = this.nativeInputStats;
    this.nativeInputStats = normalized;
    if (
      this.session?.nativeInputStats &&
      (this.state === "recording" || this.state === "stopping")
    ) {
      const previousSessionStats = this.session.nativeInputStats.latest;
      this.session.nativeInputStats.latest = { ...normalized };
      if (nativeCountersIncreased(previousSessionStats, normalized)) {
        this.session.nativeInputStats.events.push({ ...normalized });
        this.postStatus(true);
      }
    } else if (nativeCountersIncreased(previous, normalized)) {
      this.postStatus(true);
    }
  }

  async start(streamInfo) {
    if (!streamInfo) {
      this.setError("Cannot start recording before the stream is configured");
      return;
    }
    if (this.state === "recording" || this.state === "stopping") {
      return;
    }

    await this.clear({ silent: true });
    this.root = await this.openStorageRoot();
    const persisted = await requestPersistentStorage();
    const counters = this.readCounters();
    const nativeStats = this.currentNativeInputStats();
    const now = new Date().toISOString();
    const sessionId = `native-pcm-${new Date().toISOString().replace(/[:.]/g, "-")}`;

    this.session = {
      type: "opendaw-native-audio-poc-recording",
      version: 1,
      sessionId,
      state: "recording",
      createdAt: now,
      startedAt: now,
      stoppedAt: null,
      sampleRate: streamInfo.sampleRate,
      channels: streamInfo.channels,
      framesPerBlock: streamInfo.framesPerBlock,
      sampleFormat: streamInfo.sampleFormat,
      manifestFileName: `${sessionId}-manifest.json`,
      chunkFilePrefix: `${sessionId}-chunk-`,
      storage: {
        mode: "opfs",
        chunkTargetBytes: CHUNK_TARGET_BYTES,
        writeBacklogWarningBytes: BACKLOG_WARNING_BYTES,
        persisted,
        note: "Chunk files are interleaved Float32 little-endian PCM without per-file headers.",
      },
      firstFrameStart: null,
      expectedNextFrame: null,
      totalRecordedFrames: 0,
      recordedBlocks: 0,
      receivedBlocksAtStart: counters.receivedBlocks,
      counterBaselines: {
        underruns: counters.underruns,
        overflows: counters.overflows,
        receivedBlocks: counters.receivedBlocks,
      },
      counterDeltasAtStop: null,
      nativeInputStats: {
        start: { ...nativeStats },
        latest: { ...nativeStats },
        stop: null,
        events: [],
      },
      receivedBlocksAtStop: null,
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
      chunks: [],
    };
    this.currentChunk = null;
    this.pendingWriteBlocks = 0;
    this.pendingWriteBytes = 0;
    this.writeBacklogHighWaterBlocks = 0;
    this.writeBacklogHighWaterBytes = 0;
    this.nextBacklogWarningBytes = BACKLOG_WARNING_BYTES;
    this.lastStatusPost = 0;
    this.state = "recording";
    this.lastError = "";
    await this.updateIndexSession("recording");
    await this.writeManifestToStorage();
    this.postStatus(true);
  }

  async stop() {
    if (this.state !== "recording") {
      return;
    }
    try {
      this.state = "stopping";
      const stopCounters = this.readCounters();
      if (this.session) {
        const nativeStats = this.currentNativeInputStats();
        this.session.state = "stopping";
        this.session.receivedBlocksAtStop = stopCounters.receivedBlocks;
        this.session.counterDeltasAtStop = this.counterDeltas(stopCounters);
        this.session.nativeInputStats.latest = { ...nativeStats };
        this.session.nativeInputStats.stop = { ...nativeStats };
        await this.updateIndexSession("stopping");
      }
      this.postStatus(true);
      await this.writeChain.catch(() => {});
      await this.closeCurrentChunk({ allowCloseFailure: true });
      if (this.session) {
        this.session.state = "stopped";
        this.session.stoppedAt = new Date().toISOString();
        await this.writeManifestToStorage();
        await this.updateIndexSession("stopped");
      }
      this.state = "stopped";
    } catch (error) {
      this.setError(`Failed to stop recording cleanly: ${error.message}`);
      this.state = "error";
      if (this.session) {
        this.session.state = "error";
        // Persist the terminal error state even if a previous stop manifest/index write partially succeeded.
        await this.writeManifestToStorage().catch(() => {});
        await this.updateIndexSession("error").catch(() => {});
      }
    }
    this.postStatus(true);
  }

  async clear({ silent = false } = {}) {
    if (this.state === "recording") {
      await this.stop().catch((error) => {
        this.setError(`Failed to stop before clearing recording: ${error.message}`);
      });
    }
    await this.writeChain.catch(() => {});
    await this.closeCurrentChunk({ allowCloseFailure: true, skipPersist: true }).catch((error) => {
      this.setError(`Failed to close current chunk before clearing recording: ${error.message}`);
    });
    if (this.root && this.session) {
      const fileNames = this.session.chunks.map((chunk) => chunk.fileName);
      fileNames.push(this.manifestFileName());
      await Promise.all(fileNames.map((fileName) => removeEntry(this.root, fileName)));
      await this.deleteIndexSession(this.session.sessionId);
    }
    this.session = null;
    this.currentChunk = null;
    this.state = "idle";
    this.pendingWriteBlocks = 0;
    this.pendingWriteBytes = 0;
    this.writeBacklogHighWaterBlocks = 0;
    this.writeBacklogHighWaterBytes = 0;
    this.nextBacklogWarningBytes = BACKLOG_WARNING_BYTES;
    this.lastStatusPost = 0;
    this.lastError = "";
    if (!silent) {
      this.postStatus(true);
    }
  }

  recordBlock({ frameStart, frameCount, channels, receivedBlockIndex, dataBytes }) {
    if (this.state !== "recording" || !this.session) {
      return;
    }
    const block = { frameStart, frameCount, channels, receivedBlockIndex, dataBytes };
    this.pendingWriteBlocks += 1;
    this.pendingWriteBytes += dataBytes.byteLength;
    this.writeBacklogHighWaterBlocks = Math.max(
      this.writeBacklogHighWaterBlocks,
      this.pendingWriteBlocks,
    );
    this.writeBacklogHighWaterBytes = Math.max(
      this.writeBacklogHighWaterBytes,
      this.pendingWriteBytes,
    );
    this.session.writeBacklogHighWaterBlocks = Math.max(
      this.session.writeBacklogHighWaterBlocks,
      this.writeBacklogHighWaterBlocks,
    );
    this.session.writeBacklogHighWaterBytes = Math.max(
      this.session.writeBacklogHighWaterBytes,
      this.writeBacklogHighWaterBytes,
    );
    while (this.pendingWriteBytes >= this.nextBacklogWarningBytes) {
      this.session.integrity.writeBacklogEvents.push({
        pendingBlocks: this.pendingWriteBlocks,
        pendingBytes: this.pendingWriteBytes,
        highWaterBlocks: this.writeBacklogHighWaterBlocks,
        highWaterBytes: this.writeBacklogHighWaterBytes,
        thresholdBytes: this.nextBacklogWarningBytes,
        at: new Date().toISOString(),
      });
      this.setError(`Recording write backlog reached ${formatBytes(this.pendingWriteBytes)}`);
      this.nextBacklogWarningBytes += BACKLOG_WARNING_BYTES;
    }
    this.writeChain = this.writeChain
      .then(() => this.writeBlockNow(block))
      .catch(async (error) => {
        this.setError(`Recording storage error: ${error.message}`);
        if (this.state === "recording") {
          this.state = "error";
          if (this.session) {
            this.session.state = "error";
            try {
              await this.writeManifestToStorage();
              await this.updateIndexSession("error");
            } catch (persistError) {
              this.setError(
                `Recording storage error: ${error.message}; failed to persist error state: ${persistError.message}`,
              );
            }
          }
        }
        this.postStatus(true);
      })
      .finally(() => {
        this.pendingWriteBlocks = Math.max(0, this.pendingWriteBlocks - 1);
        this.pendingWriteBytes = Math.max(0, this.pendingWriteBytes - block.dataBytes.byteLength);
      });
  }

  rebaselineCounters(reason) {
    if (this.state !== "recording" || !this.session) {
      return;
    }
    const counters = this.readCounters();
    this.session.integrity.counterResets.push({
      reason,
      previousBaseline: { ...this.session.counterBaselines },
      newBaseline: {
        underruns: counters.underruns,
        overflows: counters.overflows,
        receivedBlocks: counters.receivedBlocks,
      },
      at: new Date().toISOString(),
    });
    this.session.counterBaselines.underruns = counters.underruns;
    this.session.counterBaselines.overflows = counters.overflows;
    this.postStatus(true);
  }

  noteChannelMismatch({ frameStart, frameCount, expectedChannels, actualChannels }) {
    if (!this.session) {
      return;
    }
    this.session.integrity.channelMismatches.push({
      frameStart,
      frameCount,
      expectedChannels,
      actualChannels,
      at: new Date().toISOString(),
    });
    this.postStatus();
  }

  noteInvalidBlock(reason) {
    if (!this.session) {
      return;
    }
    this.session.integrity.invalidBlocks.push({
      reason,
      at: new Date().toISOString(),
    });
    this.postStatus();
  }

  noteWebSocketLag({ code, message }) {
    if (!this.session) {
      return;
    }
    this.session.integrity.websocketLagEvents.push({
      code,
      message,
      at: new Date().toISOString(),
    });
    this.postStatus(true);
  }

  async exportManifest() {
    if (!this.session) {
      throw new Error("No recording manifest is available");
    }
    if (this.state === "recording" || this.state === "stopping") {
      throw new Error("Stop recording before exporting the manifest");
    }
    await this.writeChain;
    await this.writeManifestToStorage();
    const json = JSON.stringify(this.buildManifest(), null, 2);
    return {
      filename: `${this.session.sessionId}-manifest.json`,
      blob: new Blob([json], { type: "application/json" }),
    };
  }

  async exportSelectedChannelWav(channelIndex) {
    if (!this.session) {
      throw new Error("No recording is available for WAV export");
    }
    if (this.state === "recording" || this.state === "stopping") {
      throw new Error("Stop recording before exporting WAV");
    }
    if (channelIndex < 0 || channelIndex >= this.session.channels) {
      throw new Error(`Channel ${channelIndex + 1} is outside the recorded channel range`);
    }
    await this.writeChain;

    const channelParts = [];
    for (const chunk of this.session.chunks) {
      const fileHandle = await this.root.getFileHandle(chunk.fileName);
      const file = await fileHandle.getFile();
      const buffer = await file.arrayBuffer();
      const samples = new Float32Array(buffer);
      const expectedSamples = chunk.frames * this.session.channels;
      if (samples.length !== expectedSamples) {
        throw new Error(
          `Chunk ${chunk.fileName} has ${samples.length} samples, expected ${expectedSamples}`,
        );
      }
      const channelSamples = extractChannel(
        samples,
        channelIndex,
        this.session.channels,
        chunk.frames,
      );
      channelParts.push(channelSamples);
    }

    const blob = createMonoFloat32WavBlob({
      sampleRate: this.session.sampleRate,
      totalFrames: this.session.totalRecordedFrames,
      channelParts,
    });
    return {
      filename: `${this.session.sessionId}-ch${String(channelIndex + 1).padStart(2, "0")}.wav`,
      blob,
    };
  }

  async scanRecoverySessions() {
    if (!supportsOpfs()) {
      return {
        available: false,
        error: "OPFS is unavailable in this browser",
        scannedAt: new Date().toISOString(),
        sessions: [],
      };
    }

    this.root = this.root ?? (await this.openStorageRoot());
    const scannedAt = new Date().toISOString();
    const { index, warnings: indexWarnings } = await this.readIndex();
    const artifacts = await listRecordingArtifacts(this.root);
    const sessionIds = new Set(Object.keys(index.sessions));
    for (const sessionId of artifacts.manifests.keys()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of artifacts.chunks.keys()) {
      sessionIds.add(sessionId);
    }

    const sessions = [];
    for (const sessionId of sessionIds) {
      sessions.push(
        await buildRecoveredSession({
          root: this.root,
          sessionId,
          indexEntry: index.sessions[sessionId] ?? null,
          manifestFileName: artifacts.manifests.get(sessionId) ?? null,
          chunkFiles: artifacts.chunks.get(sessionId) ?? [],
          activeSessionId: this.session?.sessionId ?? null,
          activeSessionState: this.state,
          activeSessionHasOpenChunk: Boolean(this.currentChunk),
          indexWarnings,
        }),
      );
    }

    sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return {
      available: true,
      error: "",
      scannedAt,
      indexFileName: INDEX_FILE_NAME,
      sessions,
    };
  }

  async exportRecoveredManifest(sessionId) {
    const session = await this.findRecoveredSession(sessionId);
    if (session.activeInMemory || session.openInMemory) {
      throw new Error("Stop or reset the active recording before exporting recovery artifacts");
    }
    const recoveredAt = new Date().toISOString();
    const manifest = {
      type: "opendaw-native-audio-poc-recovered-recording",
      version: 1,
      recovered: true,
      recoveredAt,
      recoveryWarnings: session.warnings.map(({ code, message, fileName, fatal }) => ({
        code: code ?? "recovery-warning",
        message,
        fileName: fileName ?? null,
        fatal: Boolean(fatal),
      })),
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      originalStoppedAt: session.originalStoppedAt,
      state: session.state,
      sampleRate: session.sampleRate,
      channels: session.channels,
      framesPerBlock: session.framesPerBlock,
      sampleFormat: session.sampleFormat,
      manifestFileName: session.manifestFileName,
      chunkFilePrefix: session.chunkFilePrefix,
      nativeInputStats: session.nativeInputStats ?? null,
      manifestPresent: session.manifestPresent,
      indexPresent: session.indexPresent,
      exportableWav: session.exportableWav,
      nonExportableReason: session.nonExportableReason,
      reconstructed: {
        frames: session.recoveredFrames,
        bytes: session.recoveredBytes,
        chunks: session.chunkCount,
        durationSeconds: session.durationSeconds,
      },
      chunks: session.chunks.map((chunk) => ({ ...chunk })),
      originalManifest: session.originalManifest,
      note:
        "Recovered metadata is reconstructed from OPFS artifacts. A browser/page failure may lose the current open chunk.",
    };
    const json = JSON.stringify(manifest, null, 2);
    return {
      filename: `${session.sessionId}-recovered-manifest.json`,
      blob: new Blob([json], { type: "application/json" }),
    };
  }

  async exportRecoveredSelectedChannelWav(sessionId, channelIndex) {
    const session = await this.findRecoveredSession(sessionId);
    if (session.activeInMemory || session.openInMemory) {
      throw new Error("Stop or reset the active recording before exporting recovery artifacts");
    }
    if (!session.exportableWav) {
      throw new Error(session.nonExportableReason || "Recovered session is not exportable as WAV");
    }
    if (channelIndex < 0 || channelIndex >= session.channels) {
      throw new Error(`Channel ${channelIndex + 1} is outside the recovered channel range`);
    }

    const channelParts = [];
    for (const chunk of session.chunks.filter((entry) => entry.validForWav)) {
      const fileHandle = await this.root.getFileHandle(chunk.fileName);
      const file = await fileHandle.getFile();
      if (file.size !== chunk.bytes) {
        throw new Error(`Chunk ${chunk.fileName} changed during export`);
      }
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength !== chunk.frames * session.channels * BYTES_PER_SAMPLE) {
        throw new Error(`Chunk ${chunk.fileName} has an unexpected byte length`);
      }
      const samples = new Float32Array(buffer);
      channelParts.push(extractChannel(samples, channelIndex, session.channels, chunk.frames));
    }

    const blob = createMonoFloat32WavBlob({
      sampleRate: session.sampleRate,
      totalFrames: session.recoveredFrames,
      channelParts,
    });
    return {
      filename: `${session.sessionId}-recovered-ch${String(channelIndex + 1).padStart(2, "0")}.wav`,
      blob,
    };
  }

  async deleteRecoveredSession(sessionId) {
    if (
      this.session?.sessionId === sessionId &&
      (this.state === "recording" || this.state === "stopping")
    ) {
      throw new Error("Cannot delete the active in-memory recording session");
    }
    this.root = this.root ?? (await this.openStorageRoot());
    const scan = await this.scanRecoverySessions();
    const session = scan.sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) {
      await this.deleteIndexSession(sessionId);
      return this.scanRecoverySessions();
    }
    if (this.session?.sessionId === sessionId) {
      await this.closeCurrentChunk({ allowCloseFailure: true, skipPersist: true }).catch((error) => {
        this.setError(`Failed to close current chunk before delete: ${error.message}`);
      });
    }

    const fileNames = new Set();
    if (session.manifestFileName) {
      fileNames.add(session.manifestFileName);
    }
    for (const chunk of session.chunks) {
      if (chunk.fileName) {
        fileNames.add(chunk.fileName);
      }
    }
    for await (const [name] of this.root.entries()) {
      if (name === `${sessionId}${MANIFEST_SUFFIX}` || name.startsWith(`${sessionId}-chunk-`)) {
        fileNames.add(name);
      }
    }

    await Promise.all([...fileNames].map((fileName) => removeEntry(this.root, fileName)));
    await this.deleteIndexSession(sessionId);
    if (this.session?.sessionId === sessionId) {
      this.session = null;
      this.currentChunk = null;
      this.state = "idle";
      this.postStatus(true);
    }
    return this.scanRecoverySessions();
  }

  async findRecoveredSession(sessionId) {
    const scan = await this.scanRecoverySessions();
    const session = scan.sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) {
      throw new Error(`Recovered session ${sessionId} was not found`);
    }
    return session;
  }

  status() {
    if (!this.session) {
      return {
        state: this.state,
        sessionId: "",
        durationSeconds: 0,
        channels: 0,
        sampleRate: 0,
        receivedBlocks: 0,
        recordedBlocks: 0,
        recordedFrames: 0,
        expectedNextFrame: null,
        chunks: 0,
        bytes: 0,
        gaps: 0,
        overlaps: 0,
        discontinuities: 0,
        channelMismatches: 0,
        invalidBlocks: 0,
        websocketLagEvents: 0,
        counterResets: 0,
        writeBacklogEvents: 0,
        pendingWriteBlocks: 0,
        pendingWriteBytes: 0,
        writeBacklogHighWaterBlocks: 0,
        writeBacklogHighWaterBytes: 0,
        underrunsDuringRecording: 0,
        overflowsDuringRecording: 0,
        nativeDroppedBlocksDuringRecording: 0,
        nativeDroppedFramesDuringRecording: 0,
        nativeDropEventsDuringRecording: 0,
        storageMode: supportsOpfs() ? "opfs" : "unavailable",
        lastError: this.lastError,
      };
    }

    const started = Date.parse(this.session.startedAt);
    const stopped = this.session.stoppedAt ? Date.parse(this.session.stoppedAt) : Date.now();
    const bytes = this.session.chunks.reduce((total, chunk) => total + chunk.bytes, 0);
    const counterDeltas = this.session.counterDeltasAtStop ?? this.counterDeltas();
    const nativeInputDeltas = this.nativeInputDeltas();
    const receivedBlocksEnd = this.session.receivedBlocksAtStop ?? this.readCounters().receivedBlocks;
    return {
      state: this.state,
      sessionId: this.session.sessionId,
      durationSeconds: Math.max(0, (stopped - started) / 1000),
      channels: this.session.channels,
      sampleRate: this.session.sampleRate,
      receivedBlocks: receivedBlocksEnd - this.session.receivedBlocksAtStart,
      recordedBlocks: this.session.recordedBlocks,
      recordedFrames: this.session.totalRecordedFrames,
      expectedNextFrame: this.session.expectedNextFrame,
      chunks: this.session.chunks.length,
      bytes,
      gaps: this.session.integrity.gaps.length,
      overlaps: this.session.integrity.overlaps.length,
      discontinuities: this.session.integrity.discontinuities.length,
      channelMismatches: this.session.integrity.channelMismatches.length,
      invalidBlocks: this.session.integrity.invalidBlocks.length,
      websocketLagEvents: this.session.integrity.websocketLagEvents.length,
      counterResets: this.session.integrity.counterResets.length,
      writeBacklogEvents: this.session.integrity.writeBacklogEvents.length,
      pendingWriteBlocks: this.pendingWriteBlocks,
      pendingWriteBytes: this.pendingWriteBytes,
      writeBacklogHighWaterBlocks: this.session.writeBacklogHighWaterBlocks,
      writeBacklogHighWaterBytes: this.session.writeBacklogHighWaterBytes,
      ...counterDeltas,
      ...nativeInputDeltas,
      storageMode: "opfs",
      lastError: this.lastError,
    };
  }

  async openStorageRoot() {
    if (!supportsOpfs()) {
      throw new Error("OPFS is unavailable in this browser; use a Chromium-class desktop browser");
    }
    return navigator.storage.getDirectory();
  }

  async writeBlockNow(block) {
    if ((this.state !== "recording" && this.state !== "stopping") || !this.session) {
      return;
    }
    if (block.channels !== this.session.channels) {
      this.noteChannelMismatch({
        frameStart: block.frameStart,
        frameCount: block.frameCount,
        expectedChannels: this.session.channels,
        actualChannels: block.channels,
      });
      return;
    }
    if (!this.currentChunk || this.currentChunk.bytes + block.dataBytes.byteLength > CHUNK_TARGET_BYTES) {
      await this.openNextChunk();
    }

    this.auditTimeline(block);
    const chunk = this.currentChunk;
    const chunkOffsetBytes = chunk.bytes;
    await chunk.writable.write(block.dataBytes);

    if (chunk.frames === 0) {
      chunk.firstFrameStart = block.frameStart;
    }
    chunk.blocks.push({
      frameStart: block.frameStart,
      frameCount: block.frameCount,
      chunkOffsetBytes,
      byteLength: block.dataBytes.byteLength,
      receivedBlockIndex: block.receivedBlockIndex,
    });
    chunk.frames += block.frameCount;
    chunk.blocksRecorded += 1;
    chunk.bytes += block.dataBytes.byteLength;
    chunk.lastFrameStart = block.frameStart;
    chunk.lastFrameEnd = block.frameStart + block.frameCount;

    this.session.totalRecordedFrames += block.frameCount;
    this.session.recordedBlocks += 1;
    this.postStatus();
  }

  auditTimeline(block) {
    if (this.session.firstFrameStart === null) {
      this.session.firstFrameStart = block.frameStart;
      this.session.expectedNextFrame = block.frameStart;
    }

    const expected = this.session.expectedNextFrame;
    if (block.frameStart > expected) {
      const gap = {
        expectedFrameStart: expected,
        actualFrameStart: block.frameStart,
        missingFrames: block.frameStart - expected,
        recordedBlockIndex: this.session.recordedBlocks,
      };
      this.session.integrity.gaps.push(gap);
      this.session.integrity.discontinuities.push({ type: "gap", ...gap });
    } else if (block.frameStart < expected) {
      const overlap = {
        expectedFrameStart: expected,
        actualFrameStart: block.frameStart,
        overlappingFrames: expected - block.frameStart,
        recordedBlockIndex: this.session.recordedBlocks,
      };
      this.session.integrity.overlaps.push(overlap);
      this.session.integrity.discontinuities.push({ type: "overlap", ...overlap });
    }

    this.session.expectedNextFrame = Math.max(expected, block.frameStart + block.frameCount);
  }

  async openNextChunk() {
    await this.closeCurrentChunk();
    const index = this.session.chunks.length;
    const fileName = `${this.session.sessionId}-chunk-${String(index).padStart(5, "0")}.f32`;
    const fileHandle = await this.root.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const chunk = {
      index,
      fileName,
      sampleFormat: "f32-interleaved",
      channels: this.session.channels,
      firstFrameStart: this.session.expectedNextFrame,
      lastFrameStart: null,
      lastFrameEnd: null,
      frames: 0,
      blocksRecorded: 0,
      bytes: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      blocks: [],
      writable,
    };
    this.currentChunk = chunk;
    this.session.chunks.push(chunk);
    await this.updateIndexSession(this.session.state ?? "recording");
  }

  async closeCurrentChunk({ allowCloseFailure = false, skipPersist = false } = {}) {
    if (!this.currentChunk) {
      return;
    }
    const chunk = this.currentChunk;
    this.currentChunk = null;
    try {
      await chunk.writable.close();
    } catch (error) {
      this.setError(`Failed to close recording chunk ${chunk.fileName}: ${error.message}`);
      if (!allowCloseFailure) {
        this.currentChunk = chunk;
        throw error;
      }
    }
    chunk.completedAt = new Date().toISOString();
    delete chunk.writable;
    if (chunk.frames === 0) {
      await removeEntry(this.root, chunk.fileName);
      this.session.chunks = this.session.chunks.filter((entry) => entry !== chunk);
    } else if (!skipPersist) {
      await this.writeManifestToStorage();
      await this.updateIndexSession(this.session.state ?? this.state);
    }
  }

  async writeManifestToStorage() {
    if (!this.root || !this.session) {
      return;
    }
    const handle = await this.root.getFileHandle(this.manifestFileName(), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(this.buildManifest(), null, 2));
    await writable.close();
  }

  buildManifest() {
    const nativeInputStats = cloneNativeInputStatsRecord(this.session.nativeInputStats);
    if (nativeInputStats && !nativeInputStats.stop) {
      nativeInputStats.latest = this.currentNativeInputStats();
    }
    const manifest = {
      ...this.session,
      storage: { ...this.session.storage },
      counterBaselines: { ...this.session.counterBaselines },
      counterDeltasAtStop: this.session.counterDeltasAtStop
        ? { ...this.session.counterDeltasAtStop }
        : null,
      nativeInputStats,
      integrity: {
        gaps: this.session.integrity.gaps.map((entry) => ({ ...entry })),
        overlaps: this.session.integrity.overlaps.map((entry) => ({ ...entry })),
        discontinuities: this.session.integrity.discontinuities.map((entry) => ({ ...entry })),
        channelMismatches: this.session.integrity.channelMismatches.map((entry) => ({ ...entry })),
        invalidBlocks: this.session.integrity.invalidBlocks.map((entry) => ({ ...entry })),
        websocketLagEvents: this.session.integrity.websocketLagEvents.map((entry) => ({ ...entry })),
        counterResets: this.session.integrity.counterResets.map((entry) => ({ ...entry })),
        writeBacklogEvents: this.session.integrity.writeBacklogEvents.map((entry) => ({ ...entry })),
      },
      chunks: this.session.chunks.map(({ writable: _writable, ...chunk }) => ({
        ...chunk,
        blocks: chunk.blocks.map((block) => ({ ...block })),
      })),
    };
    manifest.summary = this.status();
    return manifest;
  }

  counterDeltas(counters = this.readCounters()) {
    if (!this.session) {
      return {
        underrunsDuringRecording: 0,
        overflowsDuringRecording: 0,
      };
    }
    return {
      underrunsDuringRecording: Math.max(
        0,
        counters.underruns - this.session.counterBaselines.underruns,
      ),
      overflowsDuringRecording: Math.max(
        0,
        counters.overflows - this.session.counterBaselines.overflows,
      ),
    };
  }

  nativeInputDeltas() {
    if (!this.session?.nativeInputStats) {
      return {
        nativeDroppedBlocksDuringRecording: 0,
        nativeDroppedFramesDuringRecording: 0,
        nativeDropEventsDuringRecording: 0,
      };
    }
    const start = this.session.nativeInputStats.start;
    const latest = this.session.nativeInputStats.stop ?? this.currentNativeInputStats();
    return {
      nativeDroppedBlocksDuringRecording: Math.max(
        0,
        latest.nativeDroppedBlocks - start.nativeDroppedBlocks,
      ),
      nativeDroppedFramesDuringRecording: Math.max(
        0,
        latest.nativeDroppedFrames - start.nativeDroppedFrames,
      ),
      nativeDropEventsDuringRecording: Math.max(
        0,
        latest.nativeDropEvents - start.nativeDropEvents,
      ),
    };
  }

  currentNativeInputStats() {
    return { ...this.nativeInputStats };
  }

  manifestFileName() {
    return this.session.manifestFileName ?? `${this.session.sessionId}-manifest.json`;
  }

  async readIndex() {
    const warnings = [];
    const emptyIndex = () => ({
      type: "opendaw-native-audio-poc-recording-index",
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: {},
    });
    if (!this.root) {
      return { index: emptyIndex(), warnings };
    }
    try {
      const handle = await this.root.getFileHandle(INDEX_FILE_NAME);
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !parsed.sessions) {
        warnings.push(`Ignoring malformed ${INDEX_FILE_NAME}`);
        return { index: emptyIndex(), warnings };
      }
      return {
        index: {
          type: parsed.type ?? "opendaw-native-audio-poc-recording-index",
          version: parsed.version ?? 1,
          updatedAt: parsed.updatedAt ?? null,
          sessions: parsed.sessions ?? {},
        },
        warnings,
      };
    } catch (error) {
      if (error?.name !== "NotFoundError") {
        warnings.push(`Could not read ${INDEX_FILE_NAME}: ${error.message}`);
      }
      return { index: emptyIndex(), warnings };
    }
  }

  async writeIndex(index) {
    if (!this.root) {
      return;
    }
    index.updatedAt = new Date().toISOString();
    const handle = await this.root.getFileHandle(INDEX_FILE_NAME, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(index, null, 2));
    await writable.close();
  }

  async updateIndexSession(state) {
    if (!this.root || !this.session) {
      return;
    }
    const { index } = await this.readIndex();
    const now = new Date().toISOString();
    index.sessions[this.session.sessionId] = {
      sessionId: this.session.sessionId,
      state,
      startedAt: this.session.startedAt,
      stoppedAt: this.session.stoppedAt,
      sampleRate: this.session.sampleRate,
      channels: this.session.channels,
      framesPerBlock: this.session.framesPerBlock,
      sampleFormat: this.session.sampleFormat,
      manifestFileName: this.manifestFileName(),
      chunkFilePrefix: this.session.chunkFilePrefix,
      chunkFileNames: this.session.chunks.map((chunk) => chunk.fileName),
      chunkCount: this.session.chunks.length,
      totalRecordedFrames: this.session.totalRecordedFrames,
      totalRecordedBytes: this.session.chunks.reduce((total, chunk) => total + chunk.bytes, 0),
      updatedAt: now,
    };
    await this.writeIndex(index);
  }

  async deleteIndexSession(sessionId) {
    if (!this.root) {
      return;
    }
    const { index } = await this.readIndex();
    delete index.sessions[sessionId];
    await this.writeIndex(index);
  }

  postStatus(force = false) {
    const now = performance.now();
    if (!force && now - this.lastStatusPost < STATUS_INTERVAL_MS) {
      return;
    }
    this.lastStatusPost = now;
    this.postMessage({ type: "recording-status", status: this.status() });
  }

  setError(message) {
    this.lastError = message;
    this.postMessage({ type: "recording-error", message });
  }
}

function defaultNativeInputStats() {
  return {
    available: false,
    source: "unknown",
    nativeDroppedBlocks: 0,
    nativeDroppedFrames: 0,
    nativeDropEvents: 0,
    bridgeQueueCapacityBlocks: 0,
    atFrame: 0,
    receivedAt: null,
  };
}

function normalizeNativeInputStats(stats) {
  const fallback = defaultNativeInputStats();
  if (!stats || typeof stats !== "object") {
    return fallback;
  }
  return {
    available: true,
    source: typeof stats.source === "string" ? stats.source : fallback.source,
    nativeDroppedBlocks: nonNegativeNumber(stats.nativeDroppedBlocks),
    nativeDroppedFrames: nonNegativeNumber(stats.nativeDroppedFrames),
    nativeDropEvents: nonNegativeNumber(stats.nativeDropEvents),
    bridgeQueueCapacityBlocks: nonNegativeNumber(stats.bridgeQueueCapacityBlocks),
    atFrame: nonNegativeNumber(stats.atFrame),
    receivedAt: new Date().toISOString(),
  };
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nativeCountersIncreased(previous, next) {
  if (!previous || !next) {
    return false;
  }
  return (
    next.nativeDroppedBlocks > previous.nativeDroppedBlocks ||
    next.nativeDroppedFrames > previous.nativeDroppedFrames ||
    next.nativeDropEvents > previous.nativeDropEvents
  );
}

function cloneNativeInputStatsRecord(record) {
  if (!record) {
    return null;
  }
  return {
    start: record.start ? { ...record.start } : null,
    latest: record.latest ? { ...record.latest } : null,
    stop: record.stop ? { ...record.stop } : null,
    events: Array.isArray(record.events) ? record.events.map((entry) => ({ ...entry })) : [],
  };
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function supportsOpfs() {
  return Boolean(navigator.storage?.getDirectory);
}

async function requestPersistentStorage() {
  try {
    return Boolean(await navigator.storage?.persist?.());
  } catch {
    return false;
  }
}

async function removeEntry(root, fileName) {
  try {
    await root?.removeEntry(fileName);
  } catch (error) {
    if (error?.name !== "NotFoundError") {
      throw error;
    }
  }
}

async function listRecordingArtifacts(root) {
  const manifests = new Map();
  const chunks = new Map();
  for await (const [name, handle] of root.entries()) {
    if (!name.startsWith(ARTIFACT_PREFIX)) {
      continue;
    }
    if (name.endsWith(MANIFEST_SUFFIX) && handle.kind === "file") {
      manifests.set(name.slice(0, -MANIFEST_SUFFIX.length), name);
      continue;
    }
    const match = name.match(CHUNK_NAME_RE);
    if (match && handle.kind === "file") {
      const sessionId = match[1];
      const chunk = {
        fileName: name,
        index: Number(match[2]),
      };
      if (!chunks.has(sessionId)) {
        chunks.set(sessionId, []);
      }
      chunks.get(sessionId).push(chunk);
    }
  }
  for (const chunkList of chunks.values()) {
    chunkList.sort((a, b) => a.index - b.index || a.fileName.localeCompare(b.fileName));
  }
  return { manifests, chunks };
}

async function buildRecoveredSession({
  root,
  sessionId,
  indexEntry,
  manifestFileName,
  chunkFiles,
  activeSessionId,
  activeSessionState,
  activeSessionHasOpenChunk,
  indexWarnings,
}) {
  const warnings = indexWarnings.map((message) => ({
    code: "index-warning",
    message,
  }));
  let manifest = null;
  let manifestParseError = "";
  if (manifestFileName) {
    try {
      const handle = await root.getFileHandle(manifestFileName);
      const file = await handle.getFile();
      manifest = JSON.parse(await file.text());
    } catch (error) {
      manifestParseError = error.message;
      warnings.push({
        code: "manifest-read-error",
        message: `Could not read ${manifestFileName}: ${error.message}`,
      });
    }
  }
  if (manifest && !manifest.nativeInputStats) {
    warnings.push({
      code: "missing-native-input-stats",
      message: "Original manifest has no nativeInputStats; native-side drop counters are unknown.",
      fatal: false,
    });
  }

  const manifestChunks = Array.isArray(manifest?.chunks) ? manifest.chunks : [];
  const manifestChunkNames = manifestChunks
    .map((chunk) => chunk?.fileName)
    .filter((name) => typeof name === "string");
  const indexChunkNames = Array.isArray(indexEntry?.chunkFileNames)
    ? indexEntry.chunkFileNames.filter((name) => typeof name === "string")
    : [];
  const chunkNames = new Set([
    ...chunkFiles.map((chunk) => chunk.fileName),
    ...manifestChunkNames,
    ...indexChunkNames,
  ]);
  const sortedChunkNames = [...chunkNames].sort(compareChunkNames);

  const sampleRate = numberOrNull(manifest?.sampleRate ?? indexEntry?.sampleRate);
  const channels = numberOrNull(manifest?.channels ?? indexEntry?.channels);
  const framesPerBlock = numberOrNull(manifest?.framesPerBlock ?? indexEntry?.framesPerBlock);
  const sampleFormat = manifest?.sampleFormat ?? indexEntry?.sampleFormat ?? "f32-interleaved";
  const manifestByName = new Map(manifestChunks.map((chunk) => [chunk.fileName, chunk]));
  const validatedChunks = [];

  for (const fileName of sortedChunkNames) {
    const manifestChunk = manifestByName.get(fileName) ?? null;
    validatedChunks.push(
      await validateRecoveredChunk({
        root,
        fileName,
        channels,
        manifestChunk,
        manifestPresent: Boolean(manifest),
        warnings,
      }),
    );
  }

  const presentChunks = validatedChunks.filter((chunk) => chunk.present);
  const recoveredChunks = validatedChunks.filter((chunk) => chunk.validForWav);
  const recoveredBytes = recoveredChunks.reduce((total, chunk) => total + chunk.bytes, 0);
  const recoveredFrames = recoveredChunks.reduce((total, chunk) => total + (chunk.frames ?? 0), 0);
  const originalStoppedAt = manifest?.stoppedAt ?? indexEntry?.stoppedAt ?? null;
  const manifestState = manifest?.state ?? indexEntry?.state ?? null;
  const activeInMemory =
    activeSessionId === sessionId &&
    (activeSessionState === "recording" || activeSessionState === "stopping");
  const openInMemory = activeSessionId === sessionId && activeSessionHasOpenChunk;
  let state = "orphan";
  if (activeInMemory) {
    state = "active";
  } else if (manifestParseError) {
    state = "error";
  } else if (originalStoppedAt || manifestState === "stopped") {
    state = "stopped";
  } else if (manifest || indexEntry) {
    state = "abandoned";
    warnings.push({
      code: "missing-stopped-at",
      message: "Original session has no stoppedAt; treating it as abandoned.",
    });
    warnings.push({
      code: "possible-open-chunk-loss",
      message: "The current open chunk may be absent or truncated after page/browser failure.",
    });
  }

  const missingChunks = validatedChunks.filter((chunk) => !chunk.present);
  const invalidChunks = validatedChunks.filter(
    (chunk) => chunk.present && !chunk.validForWav && !chunk.ignoredForWav,
  );
  const shapeKnown = channels > 0 && sampleRate > 0 && sampleFormat === "f32-interleaved";
  let nonExportableReason = "";
  if (!shapeKnown) {
    nonExportableReason = "sample rate, channel count, or sample format is unknown";
  } else if (recoveredChunks.length === 0) {
    nonExportableReason = "no exportable chunk files were found";
  } else if (missingChunks.length > 0) {
    nonExportableReason = "one or more chunk files are missing";
  } else if (invalidChunks.length > 0) {
    nonExportableReason = "one or more chunk files are truncated or size-mismatched";
  }

  return {
    sessionId,
    state,
    activeInMemory,
    openInMemory,
    startedAt: manifest?.startedAt ?? indexEntry?.startedAt ?? null,
    updatedAt: latestTimestamp([
      manifest?.stoppedAt,
      manifest?.startedAt,
      indexEntry?.updatedAt,
      ...presentChunks.map((chunk) => chunk.lastModifiedAt),
    ]),
    originalStoppedAt,
    sampleRate: sampleRate ?? 0,
    channels: channels ?? 0,
    framesPerBlock: framesPerBlock ?? 0,
    sampleFormat,
    nativeInputStats: manifest?.nativeInputStats ?? null,
    manifestFileName: manifestFileName ?? indexEntry?.manifestFileName ?? `${sessionId}${MANIFEST_SUFFIX}`,
    chunkFilePrefix: indexEntry?.chunkFilePrefix ?? `${sessionId}-chunk-`,
    manifestPresent: Boolean(manifest),
    indexPresent: Boolean(indexEntry),
    chunkCount: recoveredChunks.length,
    recoveredFrames,
    recoveredBytes,
    durationSeconds: sampleRate ? recoveredFrames / sampleRate : 0,
    exportableManifest: true,
    exportableWav: !nonExportableReason,
    nonExportableReason,
    warnings,
    chunks: validatedChunks,
    originalManifest: manifest,
  };
}

async function validateRecoveredChunk({ root, fileName, channels, manifestChunk, manifestPresent, warnings }) {
  const chunk = {
    index: chunkIndexFromName(fileName),
    fileName,
    listedInManifest: Boolean(manifestChunk),
    present: false,
    bytes: 0,
    frames: null,
    expectedBytes: numberOrNull(manifestChunk?.bytes),
    manifestFrames: numberOrNull(manifestChunk?.frames),
    firstFrameStart: numberOrNull(manifestChunk?.firstFrameStart),
    lastFrameStart: numberOrNull(manifestChunk?.lastFrameStart),
    lastFrameEnd: numberOrNull(manifestChunk?.lastFrameEnd),
    blocksRecorded: numberOrNull(manifestChunk?.blocksRecorded),
    completedAt: manifestChunk?.completedAt ?? null,
    lastModifiedAt: null,
    validForWav: false,
    fatalForWav: false,
    ignoredForWav: false,
    warnings: [],
  };

  try {
    const handle = await root.getFileHandle(fileName);
    const file = await handle.getFile();
    chunk.present = true;
    chunk.bytes = file.size;
    chunk.lastModifiedAt = file.lastModified ? new Date(file.lastModified).toISOString() : null;
  } catch (error) {
    if (error?.name === "NotFoundError") {
      addChunkWarning(chunk, warnings, "missing-chunk", `Chunk ${fileName} is listed but missing.`);
      return chunk;
    }
    addChunkWarning(chunk, warnings, "chunk-read-error", `Could not read ${fileName}: ${error.message}`);
    return chunk;
  }

  if (chunk.expectedBytes !== null && chunk.expectedBytes !== chunk.bytes) {
    addChunkWarning(
      chunk,
      warnings,
      "chunk-size-mismatch",
      `Chunk ${fileName} is ${chunk.bytes} bytes; manifest expected ${chunk.expectedBytes}.`,
    );
  }

  if (!channels || channels <= 0) {
    addChunkWarning(chunk, warnings, "unknown-shape", `Cannot validate ${fileName}; channel count is unknown.`);
    return chunk;
  }

  if (chunk.bytes === 0) {
    addChunkWarning(chunk, warnings, "empty-chunk", `Chunk ${fileName} is empty.`);
    chunk.ignoredForWav = manifestPresent && !manifestChunk;
    return chunk;
  }

  const bytesPerFrame = channels * BYTES_PER_SAMPLE;
  if (chunk.bytes % bytesPerFrame !== 0) {
    addChunkWarning(
      chunk,
      warnings,
      "truncated-chunk",
      `Chunk ${fileName} size is not divisible by ${bytesPerFrame} bytes/frame.`,
    );
    chunk.ignoredForWav = manifestPresent && !manifestChunk;
    return chunk;
  }

  const framesFromBytes = chunk.bytes / bytesPerFrame;
  chunk.frames = framesFromBytes;
  if (!manifestChunk) {
    addChunkWarning(
      chunk,
      warnings,
      "unmanifested-chunk",
      `Chunk ${fileName} is not listed in the manifest; treating it as unverified recovered audio.`,
      { fatal: false },
    );
  }
  if (chunk.manifestFrames !== null && chunk.manifestFrames !== framesFromBytes) {
    addChunkWarning(
      chunk,
      warnings,
      "chunk-frame-mismatch",
      `Chunk ${fileName} has ${framesFromBytes} frames by byte size; manifest expected ${chunk.manifestFrames}.`,
    );
  }
  chunk.validForWav =
    chunk.present &&
    chunk.bytes > 0 &&
    chunk.frames !== null &&
    !chunk.fatalForWav &&
    (chunk.expectedBytes === null || chunk.expectedBytes === chunk.bytes);
  return chunk;
}

function addChunkWarning(chunk, warnings, code, message, { fatal = true } = {}) {
  const warning = { code, message, fileName: chunk.fileName, fatal };
  chunk.warnings.push(warning);
  if (fatal) {
    chunk.fatalForWav = true;
  }
  warnings.push(warning);
}

function compareChunkNames(left, right) {
  const leftIndex = chunkIndexFromName(left);
  const rightIndex = chunkIndexFromName(right);
  return leftIndex - rightIndex || left.localeCompare(right);
}

function chunkIndexFromName(fileName) {
  const match = fileName.match(CHUNK_NAME_RE);
  return match ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latestTimestamp(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

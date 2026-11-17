import { STATE, STATE_INTS } from "./ring-buffer.js";

const els = {
  connect: document.querySelector("#connect"),
  monitor: document.querySelector("#monitor"),
  streamSummary: document.querySelector("#stream-summary"),
  socketState: document.querySelector("#socket-state"),
  bufferFill: document.querySelector("#buffer-fill"),
  underruns: document.querySelector("#underruns"),
  overflows: document.querySelector("#overflows"),
  nativeDroppedBlocks: document.querySelector("#native-dropped-blocks"),
  nativeDroppedFrames: document.querySelector("#native-dropped-frames"),
  nativeDropEvents: document.querySelector("#native-drop-events"),
  meters: document.querySelector("#meters"),
  leftChannel: document.querySelector("#left-channel"),
  rightChannel: document.querySelector("#right-channel"),
  recordStart: document.querySelector("#record-start"),
  recordStop: document.querySelector("#record-stop"),
  recordReset: document.querySelector("#record-reset"),
  exportManifest: document.querySelector("#export-manifest"),
  wavChannel: document.querySelector("#wav-channel"),
  exportWav: document.querySelector("#export-wav"),
  recordState: document.querySelector("#record-state"),
  recordDuration: document.querySelector("#record-duration"),
  recordFrames: document.querySelector("#record-frames"),
  recordBlocks: document.querySelector("#record-blocks"),
  recordNextFrame: document.querySelector("#record-next-frame"),
  recordChunks: document.querySelector("#record-chunks"),
  recordGaps: document.querySelector("#record-gaps"),
  recordUnderOver: document.querySelector("#record-under-over"),
  recordLag: document.querySelector("#record-lag"),
  recordNativeDrops: document.querySelector("#record-native-drops"),
  recordBacklog: document.querySelector("#record-backlog"),
  recordStorage: document.querySelector("#record-storage"),
  recordError: document.querySelector("#record-error"),
  recoveryRefresh: document.querySelector("#recovery-refresh"),
  recoverySession: document.querySelector("#recovery-session"),
  recoveryWavChannel: document.querySelector("#recovery-wav-channel"),
  recoveryExportManifest: document.querySelector("#recovery-export-manifest"),
  recoveryExportWav: document.querySelector("#recovery-export-wav"),
  recoveryDelete: document.querySelector("#recovery-delete"),
  recoverySummary: document.querySelector("#recovery-summary"),
  recoveryDetails: document.querySelector("#recovery-details"),
};

let worker = null;
let nextConnectionGeneration = 0;
let connectionGeneration = null;
const CONNECTION_REPLIES = new Set(["socket-state", "shared-buffer", "meters", "native-input-stats", "error"]);
let audioContext = null;
let workletNode = null;
let monitorAttempt = null;
const MONITOR_STARTUP_TIMEOUT_MS = 10_000;
let sharedBuffer = null;
let stateView = null;
let streamInfo = null;
let meterBars = [];
let recordingStatus = null;
let recordingStartPending = false;
let socketStateValue = "closed";
let recoveryResult = null;
let recoveryChannelOwner = null;
let recoveryScanPending = false;
let exportPending = false;
let exportError = "";
let recoveryRequestId = 0;
let nativeInputStats = defaultNativeInputStats();

els.connect.addEventListener("click", () => {
  if (socketStateValue === "connecting" || socketStateValue === "open") {
    disconnect();
  } else {
    connect();
  }
});

els.monitor.addEventListener("click", async () => {
  await startMonitor();
});

els.leftChannel.addEventListener("change", updateMonitorChannels);
els.rightChannel.addEventListener("change", updateMonitorChannels);
els.recordStart.addEventListener("click", () => {
  recordingStartPending = true;
  renderRecordingStatus();
  worker?.postMessage({ type: "recording-start" });
});
els.recordStop.addEventListener("click", () => {
  worker?.postMessage({ type: "recording-stop" });
});
els.recordReset.addEventListener("click", () => {
  worker?.postMessage({ type: "recording-reset" });
});
els.exportManifest.addEventListener("click", () => {
  requestExport({ type: "export-manifest" });
});
els.exportWav.addEventListener("click", () => {
  requestExport({
    type: "export-selected-wav",
    channelIndex: Number(els.wavChannel.value),
  });
});
els.recoveryRefresh.addEventListener("click", scanRecovery);
els.recoverySession.addEventListener("change", renderRecovery);
els.recoveryExportManifest.addEventListener("click", () => {
  const session = selectedRecoverySession();
  if (!session) {
    return;
  }
  requestExport({
    type: "export-recovered-manifest",
    sessionId: session.sessionId,
  });
});
els.recoveryExportWav.addEventListener("click", () => {
  const session = selectedRecoverySession();
  if (!session) {
    return;
  }
  requestExport({
    type: "export-recovered-wav",
    sessionId: session.sessionId,
    channelIndex: Number(els.recoveryWavChannel.value),
  });
});
els.recoveryDelete.addEventListener("click", () => {
  const session = selectedRecoverySession();
  if (!session) {
    return;
  }
  const confirmed = window.confirm(
    `Delete OPFS files for ${session.sessionId}? This removes its manifest, chunks, and index entry.`,
  );
  if (confirmed) {
    recoveryScanPending = true;
    renderRecovery();
    worker?.postMessage({
      type: "delete-recovered-session",
      requestId: ++recoveryRequestId,
      sessionId: session.sessionId,
    });
  }
});

if (!window.crossOriginIsolated) {
  els.streamSummary.textContent = "Cross-origin isolation is missing; SharedArrayBuffer is unavailable.";
  els.connect.disabled = true;
}

ensureWorker();
scanRecovery();

function connect() {
  ensureWorker();
  connectionGeneration = ++nextConnectionGeneration;
  worker.postMessage({ type: "connect", url: websocketUrl(), generation: connectionGeneration });
  els.connect.textContent = "Disconnect";
  setSocketState("connecting");
}

function disconnect() {
  if (isRecorderBusy(recordingStatus)) {
    return;
  }
  const retiredGeneration = connectionGeneration;
  connectionGeneration = null;
  worker?.postMessage({ type: "disconnect", generation: retiredGeneration });
  stopMonitor();
  sharedBuffer = null;
  stateView = null;
  streamInfo = null;
  meterBars = [];
  recordingStatus = null;
  recordingStartPending = false;
  nativeInputStats = defaultNativeInputStats();
  els.meters.replaceChildren();
  els.leftChannel.replaceChildren();
  els.rightChannel.replaceChildren();
  els.wavChannel.replaceChildren();
  els.monitor.disabled = true;
  els.monitor.textContent = "Start Monitor";
  els.connect.textContent = "Connect";
  els.streamSummary.textContent = "Disconnected";
  setSocketState("closed");
  renderRecordingStatus();
  renderCounters();
  scanRecovery();
}

function ensureWorker() {
  if (worker) {
    return;
  }
  const owned = new Worker("/audio-worker.js", { type: "module" });
  worker = owned;
  owned.addEventListener("message", (event) => {
    if (worker === owned) handleWorkerMessage(event);
  });
  for (const type of ["error", "messageerror"]) {
    owned.addEventListener(type, (event) => {
      event.preventDefault();
      if (worker !== owned) return;
      worker = null;
      connectionGeneration = null;
      owned.terminate();
      stopMonitor();
      sharedBuffer = null;
      stateView = null;
      streamInfo = null;
      recordingStartPending = false;
      recoveryScanPending = false;
      exportPending = false;
      exportError = "";
      nativeInputStats = defaultNativeInputStats();
      const guidance = "Audio worker failed; capture may be interrupted. Use Scan Recovery to inspect retained OPFS audio, then reconnect. The open chunk may be lost.";
      // The replacement recorder owns no live session. Exports must use the
      // recovery panel, not stale in-memory counters/session ownership.
      recordingStatus = { state: "interrupted", lastError: guidance };
      recoveryResult = { available: true, sessions: [], error: guidance };
      meterBars = [];
      els.meters.replaceChildren();
      els.leftChannel.replaceChildren();
      els.rightChannel.replaceChildren();
      els.wavChannel.replaceChildren();
      setSocketState("error");
      els.streamSummary.textContent = guidance;
      renderCounters();
      renderRecovery();
    });
  }
}

function releaseMonitor(attempt) {
  if (!attempt || attempt.closed) return;
  attempt.closed = true;
  clearTimeout(attempt.timer);
  attempt.retire();
  attempt.context?.removeEventListener("statechange", attempt.onStateChange);
  if (attempt.node) {
    attempt.node.port.removeEventListener("message", attempt.onMessage);
    attempt.node.removeEventListener("processorerror", attempt.onFault);
    attempt.node.disconnect();
  }
  if (attempt.context && attempt.context.state !== "closed") {
    attempt.context.close().catch(() => {});
  }
}

function stopMonitor() {
  const previous = monitorAttempt;
  monitorAttempt = null;
  releaseMonitor(previous);
  audioContext = null;
  workletNode = null;
  els.monitor.textContent = "Start Monitor";
}

function renderMonitorState(attempt) {
  if (monitorAttempt !== attempt || sharedBuffer !== attempt.buffer) return;
  const state = attempt.context.state;
  if (state === "closed") {
    stopMonitor();
    els.streamSummary.textContent = "Monitor context closed; Start Monitor to retry";
    els.monitor.disabled = !sharedBuffer;
  } else if (!attempt.starting) {
    const running = state === "running";
    els.monitor.textContent = running ? "Monitoring" : "Resume Monitor";
    els.monitor.disabled = running || !sharedBuffer;
    els.streamSummary.textContent = running
      ? `${attempt.info.channels} channels, ${attempt.info.sampleRate} Hz, ${attempt.info.framesPerBlock} frames/block · Monitoring`
      : `Monitor ${state}; click Resume Monitor to resume audio`;
  }
}

function startMonitor() {
  if (!sharedBuffer) return Promise.resolve();
  if (monitorAttempt?.starting || monitorAttempt?.context.state === "running") {
    return monitorAttempt.promise;
  }
  const attempt = monitorAttempt ?? { buffer: sharedBuffer, info: streamInfo, context: null, node: null };
  if (!monitorAttempt) {
    attempt.retired = new Promise(resolve => { attempt.retire = resolve; });
    monitorAttempt = attempt;
  }
  const resuming = Boolean(attempt.node);
  attempt.starting = true;
  els.monitor.disabled = true;
  els.monitor.textContent = resuming ? "Resuming Monitor…" : "Starting Monitor…";
  attempt.promise = (async () => {
    const current = () => monitorAttempt === attempt && sharedBuffer === attempt.buffer;
    const operation = {};
    attempt.operation = operation;
    attempt.timer = setTimeout(() => {
      if (!current() || !attempt.starting || attempt.operation !== operation) return;
      stopMonitor();
      els.streamSummary.textContent = `Monitor ${resuming ? "resume" : "startup"} timed out; Start Monitor to retry`;
      els.monitor.disabled = !sharedBuffer;
    }, MONITOR_STARTUP_TIMEOUT_MS);
    try {
      if (!attempt.context) {
        const context = new AudioContext({ sampleRate: attempt.info.sampleRate });
        attempt.context = context;
        attempt.onStateChange = () => renderMonitorState(attempt);
        context.addEventListener("statechange", attempt.onStateChange);
        await Promise.race([context.audioWorklet.addModule("/bridge-processor.js"), attempt.retired]);
        if (!current()) return;
        const node = new AudioWorkletNode(context, "native-bridge-processor", {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        attempt.node = node;
        attempt.onMessage = (event) => {
          if (current()) handleWorkletMessage(event);
        };
        attempt.onFault = () => {
          if (!current()) return;
          stopMonitor();
          els.streamSummary.textContent = "Monitor processor failed; Start Monitor to retry";
          els.monitor.disabled = !sharedBuffer;
        };
        node.port.addEventListener("message", attempt.onMessage);
        node.addEventListener("processorerror", attempt.onFault);
        node.port.start();
        node.connect(context.destination);
        node.port.postMessage({
          type: "configure", sharedBuffer: attempt.buffer,
          left: Number(els.leftChannel.value), right: Number(els.rightChannel.value),
        });
      }
      // On recovery, invoke resume before any await to retain the click's gesture.
      await Promise.race([attempt.context.resume(), attempt.retired]);
      if (!current()) return;
      audioContext = attempt.context;
      workletNode = attempt.node;
    } catch (error) {
      if (current()) {
        stopMonitor();
        els.streamSummary.textContent = `Monitor failed: ${error.message}; Start Monitor to retry`;
      }
      releaseMonitor(attempt);
    } finally {
      attempt.starting = false;
      clearTimeout(attempt.timer);
      if (!current()) {
        releaseMonitor(attempt);
        if (!monitorAttempt) els.monitor.disabled = !sharedBuffer;
      } else {
        renderMonitorState(attempt);
      }
    }
  })();
  return attempt.promise;
}

function updateMonitorChannels() {
  (workletNode ?? monitorAttempt?.node)?.port.postMessage({
    type: "channels",
    left: Number(els.leftChannel.value),
    right: Number(els.rightChannel.value),
  });
}

function handleWorkerMessage(event) {
  const message = event.data;
  if (CONNECTION_REPLIES.has(message.type) &&
      (connectionGeneration === null || message.generation !== connectionGeneration)) return;
  if (message.type === "socket-state") {
    setSocketState(message.state);
    if (message.message) els.streamSummary.textContent = message.message;
  } else if (message.type === "shared-buffer") {
    stopMonitor();
    sharedBuffer = message.sharedBuffer;
    streamInfo = message.stream;
    stateView = new Int32Array(sharedBuffer, 0, STATE_INTS);
    setupStreamUi(streamInfo);
    els.monitor.disabled = false;
  } else if (message.type === "meters") {
    renderMeters(message.peak);
    renderCounters();
  } else if (message.type === "native-input-stats") {
    nativeInputStats = normalizeNativeInputStats(message.stats);
    renderNativeInputStats();
  } else if (message.type === "error") {
    els.streamSummary.textContent = message.message;
  } else if (message.type === "recording-status") {
    const previous = recordingStatus;
    recordingStatus = message.status;
    recordingStartPending = false;
    // An export error must not mask later acquisition state or errors.
    // A first status (previous null) is not a transition.
    if (exportError && ((previous && message.status?.state !== previous.state) ||
        (message.status?.lastError && message.status.lastError !== previous?.lastError))) {
      exportError = "";
    }
    renderRecordingStatus();
  } else if (message.type === "recording-error") {
    exportError = "";
    els.recordError.textContent = message.message;
  } else if (message.type === "export-error") {
    exportError = `Export failed: ${message.message}`;
    els.recordError.textContent = exportError;
  } else if (message.type === "export-status") {
    exportPending = message.pending;
    renderRecordingStatus();
  } else if (message.type === "download") {
    try {
      downloadBlob(message.blob, message.filename);
    } catch (error) {
      exportError = `Download failed: ${error.message}. Retained OPFS audio is unchanged.`;
      els.recordError.textContent = exportError;
    }
  } else if (message.type === "recovery-sessions") {
    if (message.requestId !== undefined && message.requestId !== recoveryRequestId) return;
    recoveryResult = message.result;
    recoveryScanPending = false;
    renderRecovery();
  }
}

function handleWorkletMessage(event) {
  if (event.data.type === "status") {
    renderCounters();
  } else if (event.data.type === "counters-reset") {
    renderCounters();
    worker?.postMessage({ type: "recording-counters-reset" });
  }
}

function setupStreamUi(info) {
  els.streamSummary.textContent =
    `${info.channels} channels, ${info.sampleRate} Hz, ${info.framesPerBlock} frames/block`;
  els.leftChannel.replaceChildren();
  els.rightChannel.replaceChildren();
  els.wavChannel.replaceChildren();
  for (let index = 0; index < info.channels; index += 1) {
    const leftOption = new Option(`Channel ${index + 1}`, String(index));
    const rightOption = new Option(`Channel ${index + 1}`, String(index));
    const wavOption = new Option(`Channel ${index + 1}`, String(index));
    els.leftChannel.append(leftOption);
    els.rightChannel.append(rightOption);
    els.wavChannel.append(wavOption);
  }
  els.rightChannel.value = String(Math.min(1, info.channels - 1));
  els.meters.replaceChildren();
  meterBars = Array.from({ length: info.channels }, (_, index) => {
    const row = document.createElement("div");
    row.className = "meter";
    row.innerHTML = `
      <span class="meter-label">Ch ${index + 1}</span>
      <span class="meter-track"><span class="meter-fill"></span></span>
      <span class="meter-db">-inf</span>
    `;
    els.meters.append(row);
    return {
      fill: row.querySelector(".meter-fill"),
      db: row.querySelector(".meter-db"),
    };
  });
  renderRecordingStatus();
}

function renderMeters(peaks) {
  peaks.forEach((peak, index) => {
    const meter = meterBars[index];
    if (!meter) {
      return;
    }
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    meter.fill.style.width = `${pct}%`;
    meter.db.textContent = Number.isFinite(db) ? `${db.toFixed(1)}` : "-inf";
  });
}

function renderCounters() {
  if (!stateView) {
    els.bufferFill.textContent = "0 frames";
    els.underruns.textContent = "0";
    els.overflows.textContent = "0";
    renderNativeInputStats();
    return;
  }
  const write = Atomics.load(stateView, STATE.WRITE_FRAME);
  const read = Atomics.load(stateView, STATE.READ_FRAME);
  const fill = Math.min((write - read) >>> 0, Atomics.load(stateView, STATE.CAPACITY_FRAMES));
  els.bufferFill.textContent = `${fill} frames`;
  els.underruns.textContent = String(Atomics.load(stateView, STATE.UNDERRUN_COUNT));
  els.overflows.textContent = String(Atomics.load(stateView, STATE.OVERFLOW_COUNT));
  renderNativeInputStats();
}

function renderNativeInputStats() {
  els.nativeDroppedBlocks.textContent = formatNumber(nativeInputStats.nativeDroppedBlocks);
  els.nativeDroppedFrames.textContent = formatNumber(nativeInputStats.nativeDroppedFrames);
  els.nativeDropEvents.textContent = formatNumber(nativeInputStats.nativeDropEvents);
}

function setSocketState(state) {
  socketStateValue = state;
  els.socketState.textContent = state;
  els.connect.textContent = state === "connecting" || state === "open" ? "Disconnect" : "Connect";
  if (state === "closed" || state === "error" || state === "device-lost") {
    connectionGeneration = null;
    stopMonitor();
    sharedBuffer = null;
    stateView = null;
    streamInfo = null;
    els.monitor.disabled = true;
    els.streamSummary.textContent = `Transport ${state}; reconnect to receive audio.`;
  }
  renderRecordingStatus();
}

function renderRecordingStatus() {
  const status =
    recordingStatus ??
    {
      state: "idle",
      durationSeconds: 0,
      recordedFrames: 0,
      recordedBlocks: 0,
      receivedBlocks: 0,
      expectedNextFrame: null,
      chunks: 0,
      bytes: 0,
      gaps: 0,
      overlaps: 0,
      underrunsDuringRecording: 0,
      overflowsDuringRecording: 0,
      nativeDroppedBlocksDuringRecording: 0,
      nativeDroppedFramesDuringRecording: 0,
      nativeDropEventsDuringRecording: 0,
      websocketLagEvents: 0,
      pendingWriteBytes: 0,
      writeBacklogHighWaterBytes: 0,
      storageMode: window.isSecureContext ? "opfs" : "unavailable",
      lastError: "",
  };
  const connected = Boolean(worker && streamInfo && socketStateValue === "open");
  const activeRecording = status.state === "recording" || status.state === "stopping";
  const recorderBusy = isRecorderBusy(status) || recordingStartPending;
  const hasRecording = Boolean(status.sessionId);
  const canExport = hasRecording && !activeRecording && status.recordedFrames > 0;

  els.recordState.textContent = status.state;
  els.recordDuration.textContent = formatDuration(status.durationSeconds);
  els.recordFrames.textContent = formatNumber(status.recordedFrames);
  els.recordBlocks.textContent = `${formatNumber(status.recordedBlocks)} / ${formatNumber(status.receivedBlocks)}`;
  els.recordNextFrame.textContent =
    status.expectedNextFrame === null ? "-" : formatNumber(status.expectedNextFrame);
  els.recordChunks.textContent = `${formatNumber(status.chunks)} (${formatBytes(status.bytes)})`;
  els.recordGaps.textContent = `${formatNumber(status.gaps)} / ${formatNumber(status.overlaps)}`;
  els.recordUnderOver.textContent =
    `${formatNumber(status.underrunsDuringRecording)} / ${formatNumber(status.overflowsDuringRecording)}`;
  els.recordLag.textContent = formatNumber(status.websocketLagEvents);
  els.recordNativeDrops.textContent =
    `${formatNumber(status.nativeDroppedBlocksDuringRecording)} / ${formatNumber(status.nativeDroppedFramesDuringRecording)} / ${formatNumber(status.nativeDropEventsDuringRecording)}`;
  els.recordBacklog.textContent =
    `${formatBytes(status.pendingWriteBytes)} / ${formatBytes(status.writeBacklogHighWaterBytes)}`;
  els.recordStorage.textContent = status.storageMode;
  els.recordError.textContent = exportError || status.lastError || "";

  els.recordStart.disabled = !connected || recorderBusy;
  els.recordStop.disabled = !activeRecording;
  els.recordReset.disabled = !hasRecording || status.state === "recording" || status.state === "stopping";
  els.exportManifest.disabled = !canExport || exportPending;
  els.exportWav.disabled = !canExport || exportPending;
  els.wavChannel.disabled = !canExport;
  els.connect.disabled = recorderBusy || !window.crossOriginIsolated;
  updateRecoveryControls();
}

function requestExport(message) {
  if (!worker || exportPending) return;
  exportPending = true;
  exportError = "";
  renderRecordingStatus();
  try {
    worker.postMessage(message);
  } catch (error) {
    exportPending = false;
    renderRecordingStatus();
    exportError = `Export failed: ${error.message}`;
    els.recordError.textContent = exportError;
  }
}

function scanRecovery() {
  ensureWorker();
  recoveryScanPending = true;
  renderRecovery();
  worker.postMessage({ type: "recovery-scan", requestId: ++recoveryRequestId });
}

function renderRecovery() {
  const previousSelection = els.recoverySession.value;
  const sessions = recoveryResult?.sessions ?? [];
  els.recoverySession.replaceChildren();

  if (sessions.length === 0) {
    els.recoverySession.append(new Option("No OPFS sessions", ""));
  } else {
    for (const session of sessions) {
      const label = `${sessionLabel(session)} · ${session.state} · ${formatBytes(session.recoveredBytes)}`;
      els.recoverySession.append(new Option(label, session.sessionId));
    }
  }

  if (sessions.some((session) => session.sessionId === previousSelection)) {
    els.recoverySession.value = previousSelection;
  }

  const session = selectedRecoverySession();
  const previousChannel = Number(els.recoveryWavChannel.value);
  const preserveChannel = session && recoveryChannelOwner?.sessionId === session.sessionId &&
    recoveryChannelOwner.channels === session.channels && Number.isInteger(previousChannel) &&
    previousChannel >= 0 && previousChannel < session.channels;
  recoveryChannelOwner = session ? { sessionId: session.sessionId, channels: session.channels } : null;
  els.recoveryWavChannel.replaceChildren();
  if (session?.channels > 0) {
    for (let index = 0; index < session.channels; index += 1) {
      els.recoveryWavChannel.append(new Option(`Channel ${index + 1}`, String(index)));
    }
  }

  if (preserveChannel) els.recoveryWavChannel.value = String(previousChannel);

  const unavailable = recoveryResult && !recoveryResult.available;
  const scanState = recoveryScanPending
    ? "Scanning OPFS sessions..."
    : unavailable
      ? recoveryResult.error || "OPFS recovery is unavailable."
      : recoveryResult
        ? `${sessions.length} OPFS session${sessions.length === 1 ? "" : "s"} found. Last scan: ${formatDateTime(recoveryResult.scannedAt)}${recoveryResult.error ? ` — ${recoveryResult.error}` : ""}`
        : "No recovery scan has run.";
  els.recoverySummary.textContent = scanState;

  updateRecoveryControls(session);

  if (!session) {
    els.recoveryDetails.replaceChildren();
    return;
  }

  const details = document.createElement("div");
  details.className = "recovery-detail-grid";
  details.append(
    recoveryMetric("State", session.state),
    recoveryMetric("Started", formatDateTime(session.startedAt)),
    recoveryMetric("Updated", formatDateTime(session.updatedAt)),
    recoveryMetric("Shape", formatShape(session)),
    recoveryMetric("Duration", formatDuration(session.durationSeconds)),
    recoveryMetric("Frames", formatNumber(session.recoveredFrames)),
    recoveryMetric("Chunks", `${formatNumber(session.chunkCount)} (${formatBytes(session.recoveredBytes)})`),
    recoveryMetric("Warnings", formatNumber(session.warnings?.length ?? 0)),
    recoveryMetric("Native Drops", formatNativeDrops(session.nativeInputStats)),
    recoveryMetric(
      "WAV Export",
      session.openInMemory
        ? "stop/reset first"
        : session.exportableWav
          ? "available"
          : session.nonExportableReason,
    ),
  );

  const warnings = document.createElement("div");
  warnings.className = "recovery-warnings";
  const warningList = session.warnings ?? [];
  if (warningList.length === 0) {
    warnings.textContent = "No reconstruction warnings.";
  } else {
    const list = document.createElement("ul");
    for (const warning of warningList.slice(0, 8)) {
      const item = document.createElement("li");
      item.textContent = warning.message;
      list.append(item);
    }
    if (warningList.length > 8) {
      const item = document.createElement("li");
      item.textContent = `${warningList.length - 8} more warning(s) in the recovery manifest.`;
      list.append(item);
    }
    warnings.append(list);
  }

  els.recoveryDetails.replaceChildren(details, warnings);
}

function updateRecoveryControls(session = selectedRecoverySession()) {
  const canUseSelected = Boolean(session);
  const selectedActive = session?.state === "active";
  const recordingActive = recordingStartPending ||
    recordingStatus?.state === "recording" || recordingStatus?.state === "stopping";
  const selectedOpenInMemory = Boolean(session?.openInMemory);
  els.recoverySession.disabled = !(recoveryResult?.sessions?.length) || recoveryScanPending;
  els.recoveryRefresh.disabled = recoveryScanPending;
  els.recoveryExportManifest.disabled =
    !canUseSelected || session.exportableManifest === false || exportPending || recordingActive || selectedActive || selectedOpenInMemory || recoveryScanPending;
  els.recoveryExportWav.disabled =
    !canUseSelected ||
    exportPending ||
    recordingActive ||
    selectedActive ||
    selectedOpenInMemory ||
    !session.exportableWav ||
    recoveryScanPending;
  els.recoveryWavChannel.disabled =
    !canUseSelected ||
    exportPending ||
    recordingActive ||
    selectedActive ||
    selectedOpenInMemory ||
    !session.exportableWav ||
    recoveryScanPending;
  els.recoveryDelete.disabled = !canUseSelected || session.metadataReadOnly === true || selectedActive || recoveryScanPending;
}

function recoveryMetric(label, value) {
  const item = document.createElement("div");
  const labelEl = document.createElement("span");
  const valueEl = document.createElement("strong");
  labelEl.textContent = label;
  valueEl.textContent = value ?? "-";
  item.append(labelEl, valueEl);
  return item;
}

function selectedRecoverySession() {
  const sessionId = els.recoverySession.value;
  return recoveryResult?.sessions?.find((session) => session.sessionId === sessionId) ?? null;
}

function sessionLabel(session) {
  if (session.startedAt) {
    return formatDateTime(session.startedAt);
  }
  return session.sessionId;
}

function formatShape(session) {
  if (!session.channels || !session.sampleRate) {
    return "unknown";
  }
  const blockText = session.framesPerBlock ? `, ${session.framesPerBlock} fpb` : "";
  return `${session.channels} ch, ${session.sampleRate} Hz${blockText}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  let anchor;
  let activated = false;
  try {
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    activated = true;
  } finally {
    try {
      anchor?.remove();
    } finally {
      if (activated) window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      else URL.revokeObjectURL(url);
    }
  }
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value ?? 0);
}

function defaultNativeInputStats() {
  return {
    source: "unknown",
    nativeDroppedBlocks: 0,
    nativeDroppedFrames: 0,
    nativeDropEvents: 0,
  };
}

function normalizeNativeInputStats(stats) {
  if (!stats || typeof stats !== "object") {
    return defaultNativeInputStats();
  }
  return {
    source: typeof stats.source === "string" ? stats.source : "unknown",
    nativeDroppedBlocks: nonNegativeNumber(stats.nativeDroppedBlocks),
    nativeDroppedFrames: nonNegativeNumber(stats.nativeDroppedFrames),
    nativeDropEvents: nonNegativeNumber(stats.nativeDropEvents),
  };
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function formatNativeDrops(nativeStats) {
  const stats = nativeStats?.stop ?? nativeStats?.latest ?? nativeStats?.start;
  if (!stats) {
    return "unknown";
  }
  return `${formatNumber(stats.nativeDroppedBlocks)} / ${formatNumber(stats.nativeDroppedFrames)} / ${formatNumber(stats.nativeDropEvents)}`;
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
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

function isRecorderBusy(status) {
  return status?.state === "recording" || status?.state === "stopping" || status?.state === "error";
}

function websocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

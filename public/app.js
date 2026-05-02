const STATE = {
  WRITE_FRAME: 0,
  READ_FRAME: 1,
  OVERFLOW_COUNT: 2,
  UNDERRUN_COUNT: 3,
  CHANNELS: 4,
  CAPACITY_FRAMES: 5,
  CONNECTED: 6,
  SAMPLE_RATE: 7,
  FRAMES_PER_BLOCK: 8,
  RECEIVED_BLOCKS: 9,
};

const els = {
  connect: document.querySelector("#connect"),
  monitor: document.querySelector("#monitor"),
  streamSummary: document.querySelector("#stream-summary"),
  socketState: document.querySelector("#socket-state"),
  bufferFill: document.querySelector("#buffer-fill"),
  underruns: document.querySelector("#underruns"),
  overflows: document.querySelector("#overflows"),
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
let audioContext = null;
let workletNode = null;
let sharedBuffer = null;
let stateView = null;
let streamInfo = null;
let meterBars = [];
let recordingStatus = null;
let recordingStartPending = false;
let socketStateValue = "closed";
let recoveryResult = null;
let recoveryScanPending = false;

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
  worker?.postMessage({ type: "export-manifest" });
});
els.exportWav.addEventListener("click", () => {
  worker?.postMessage({
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
  worker?.postMessage({
    type: "export-recovered-manifest",
    sessionId: session.sessionId,
  });
});
els.recoveryExportWav.addEventListener("click", () => {
  const session = selectedRecoverySession();
  if (!session) {
    return;
  }
  worker?.postMessage({
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
    worker?.postMessage({
      type: "delete-recovered-session",
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
  worker.postMessage({ type: "connect", url: websocketUrl() });
  els.connect.textContent = "Disconnect";
  setSocketState("connecting");
}

function disconnect() {
  if (isRecorderBusy(recordingStatus)) {
    return;
  }
  worker?.postMessage({ type: "disconnect" });
  workletNode?.disconnect();
  workletNode = null;
  const closingContext = audioContext;
  audioContext = null;
  if (closingContext && closingContext.state !== "closed") {
    closingContext.close().catch(() => {});
  }
  sharedBuffer = null;
  stateView = null;
  streamInfo = null;
  meterBars = [];
  recordingStatus = null;
  recordingStartPending = false;
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
  worker = new Worker("/audio-worker.js", { type: "module" });
  worker.addEventListener("message", handleWorkerMessage);
}

async function startMonitor() {
  if (!sharedBuffer) {
    return;
  }
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: streamInfo?.sampleRate });
    await audioContext.audioWorklet.addModule("/bridge-processor.js");
  }
  if (!workletNode) {
    workletNode = new AudioWorkletNode(audioContext, "native-bridge-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    workletNode.port.addEventListener("message", handleWorkletMessage);
    workletNode.port.start();
    workletNode.connect(audioContext.destination);
    workletNode.port.postMessage({
      type: "configure",
      sharedBuffer,
      left: Number(els.leftChannel.value),
      right: Number(els.rightChannel.value),
    });
  }
  await audioContext.resume();
  els.monitor.textContent = "Monitoring";
}

function updateMonitorChannels() {
  workletNode?.port.postMessage({
    type: "channels",
    left: Number(els.leftChannel.value),
    right: Number(els.rightChannel.value),
  });
}

function handleWorkerMessage(event) {
  const message = event.data;
  if (message.type === "socket-state") {
    setSocketState(message.state);
  } else if (message.type === "shared-buffer") {
    sharedBuffer = message.sharedBuffer;
    streamInfo = message.stream;
    stateView = new Int32Array(sharedBuffer, 0, 64);
    setupStreamUi(streamInfo);
    els.monitor.disabled = false;
    if (workletNode) {
      workletNode.port.postMessage({ type: "configure", sharedBuffer });
    }
  } else if (message.type === "meters") {
    renderMeters(message.peak);
    renderCounters();
  } else if (message.type === "error") {
    els.streamSummary.textContent = message.message;
  } else if (message.type === "recording-status") {
    recordingStatus = message.status;
    recordingStartPending = false;
    renderRecordingStatus();
  } else if (message.type === "recording-error") {
    els.recordError.textContent = message.message;
  } else if (message.type === "download") {
    downloadBlob(message.blob, message.filename);
  } else if (message.type === "recovery-sessions") {
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
    return;
  }
  const write = Atomics.load(stateView, STATE.WRITE_FRAME);
  const read = Atomics.load(stateView, STATE.READ_FRAME);
  const fill = Math.max(0, write - read);
  els.bufferFill.textContent = `${fill} frames`;
  els.underruns.textContent = String(Atomics.load(stateView, STATE.UNDERRUN_COUNT));
  els.overflows.textContent = String(Atomics.load(stateView, STATE.OVERFLOW_COUNT));
}

function setSocketState(state) {
  socketStateValue = state;
  els.socketState.textContent = state;
  els.connect.textContent = state === "connecting" || state === "open" ? "Disconnect" : "Connect";
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
      websocketLagEvents: 0,
      pendingWriteBytes: 0,
      writeBacklogHighWaterBytes: 0,
      storageMode: window.isSecureContext ? "opfs" : "unavailable",
      lastError: "",
  };
  const connected = Boolean(worker && streamInfo);
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
  els.recordBacklog.textContent =
    `${formatBytes(status.pendingWriteBytes)} / ${formatBytes(status.writeBacklogHighWaterBytes)}`;
  els.recordStorage.textContent = status.storageMode;
  els.recordError.textContent = status.lastError ?? "";

  els.recordStart.disabled = !connected || recorderBusy;
  els.recordStop.disabled = !activeRecording;
  els.recordReset.disabled = !hasRecording || status.state === "recording" || status.state === "stopping";
  els.exportManifest.disabled = !canExport;
  els.exportWav.disabled = !canExport;
  els.wavChannel.disabled = !connected || !canExport;
  els.connect.disabled = recorderBusy || !window.crossOriginIsolated;
}

function scanRecovery() {
  ensureWorker();
  recoveryScanPending = true;
  renderRecovery();
  worker.postMessage({ type: "recovery-scan" });
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
  els.recoveryWavChannel.replaceChildren();
  if (session?.channels > 0) {
    for (let index = 0; index < session.channels; index += 1) {
      els.recoveryWavChannel.append(new Option(`Channel ${index + 1}`, String(index)));
    }
  }

  const unavailable = recoveryResult && !recoveryResult.available;
  const scanState = recoveryScanPending
    ? "Scanning OPFS sessions..."
    : unavailable
      ? recoveryResult.error || "OPFS recovery is unavailable."
      : recoveryResult
        ? `${sessions.length} OPFS session${sessions.length === 1 ? "" : "s"} found. Last scan: ${formatDateTime(recoveryResult.scannedAt)}`
        : "No recovery scan has run.";
  els.recoverySummary.textContent = scanState;

  const canUseSelected = Boolean(session);
  const selectedActive = session?.state === "active";
  const selectedOpenInMemory = Boolean(session?.openInMemory);
  els.recoverySession.disabled = sessions.length === 0 || recoveryScanPending;
  els.recoveryRefresh.disabled = recoveryScanPending;
  els.recoveryExportManifest.disabled =
    !canUseSelected || selectedActive || selectedOpenInMemory || recoveryScanPending;
  els.recoveryExportWav.disabled =
    !canUseSelected ||
    selectedActive ||
    selectedOpenInMemory ||
    !session.exportableWav ||
    recoveryScanPending;
  els.recoveryWavChannel.disabled =
    !canUseSelected ||
    selectedActive ||
    selectedOpenInMemory ||
    !session.exportableWav ||
    recoveryScanPending;
  els.recoveryDelete.disabled = !canUseSelected || selectedActive || recoveryScanPending;

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
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
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

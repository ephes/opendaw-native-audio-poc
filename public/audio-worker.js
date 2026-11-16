import { decodePcmBlock } from "./pcm-block.js";
import { PcmRecorder } from "./recorder.js";
import {
  createRingBufferViews,
  writePcmToRingBuffer,
  RING_BUFFER_BYTES_PER_SAMPLE,
  STATE,
  STATE_BYTES,
  STATE_INTS,
} from "./ring-buffer.js";

const CAPACITY_SECONDS = 2;
const CONNECTION_STARTUP_TIMEOUT_MS = 10_000;
const MAX_CONTROL_CHARS = 4096;
const MAX_RING_BYTES = 64 * 1024 * 1024;

let socket = null;
let connectionGeneration = null;
let startupTimer = null;
let detachSocketListeners = null;
let sharedBuffer = null;
let stateView = null;
let sampleView = null;
let streamInfo = null;
let lastMeterPost = 0;
let nativeInputStats = null;
let recordingStartsPending = 0;
let pcmRefused = false;
let exportPending = false;
let recoveryGeneration = 0;
let recoveryQueue = Promise.resolve();
let recorder = new PcmRecorder({
  readCounters,
  postMessage: (message) => postMessage(message),
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "connect") {
    connect(message.url, message.generation);
  } else if (message.type === "disconnect") {
    if (message.generation === connectionGeneration) disconnect();
  } else if (message.type === "recording-start") {
    if (pcmRefused) {
      postMessage({ type: "recording-status", status: recorder.status() });
      postMessage({ type: "recording-error", message: "Reconfigure or reconnect before recording after a geometry change" });
      return;
    }
    const info = streamInfo;
    recordingStartsPending++;
    runRecorderAction(() => recorder.start(info).finally(() => { recordingStartsPending--; }));
  } else if (message.type === "recording-stop") {
    runRecorderAction(() => recorder.stop());
  } else if (message.type === "recording-reset") {
    runRecorderAction(() => recorder.clear());
  } else if (message.type === "recording-counters-reset") {
    recorder.rebaselineCounters("monitor-start-reset");
  } else if (message.type === "export-manifest") {
    runExport(() => recorder.exportManifest());
  } else if (message.type === "export-selected-wav") {
    runExport(() => recorder.exportSelectedChannelWav(message.channelIndex));
  } else if (message.type === "recovery-scan") {
    runRecoveryScan(message.requestId);
  } else if (message.type === "export-recovered-manifest") {
    runExport(() => recorder.exportRecoveredManifest(message.sessionId));
  } else if (message.type === "export-recovered-wav") {
    runExport(() =>
      recorder.exportRecoveredSelectedChannelWav(message.sessionId, message.channelIndex),
    );
  } else if (message.type === "delete-recovered-session") {
    runDeleteRecoveredSession(message.sessionId, message.requestId);
  }
});

function connect(url, generation) {
  let connection;
  try {
    connection = new WebSocket(url);
  } catch {
    postMessage({ type: "socket-state", state: "error", generation,
      code: "connection-construction-failed", message: "WebSocket connection could not be created; retry Connect." });
    return;
  }
  disconnect();
  socket = connection;
  connectionGeneration = generation;
  connection.binaryType = "arraybuffer";
  const listeners = {
    open: () => {
      if (socket !== connection) return;
      postConnectionMessage({ type: "socket-state", state: "open" });
    },
    close: () => terminateConnection(connection, "closed"),
    error: () => terminateConnection(connection, "error"),
    message: (event) => {
      if (socket !== connection) return;
      handleSocketMessage(event);
    },
  };
  for (const [type, listener] of Object.entries(listeners)) {
    connection.addEventListener(type, listener);
  }
  detachSocketListeners = () => {
    for (const [type, listener] of Object.entries(listeners)) {
      connection.removeEventListener(type, listener);
    }
  };
  const timer = setTimeout(() => {
    if (socket !== connection || startupTimer !== timer) return;
    terminateConnection(connection, "error", {
      code: "connection-startup-timeout", message: "WebSocket startup timed out; retry Connect.",
    });
  }, CONNECTION_STARTUP_TIMEOUT_MS);
  startupTimer = timer;
}

function terminateConnection(connection, state, detail = {}) {
  if (socket !== connection) return;
  // Capture counters before disconnect clears this stream; the lifecycle queue
  // also covers a Start that has not finished creating its session yet.
  const generation = connectionGeneration;
  disconnect(state);
  postMessage({ type: "socket-state", state, generation, ...detail });
}

function postConnectionMessage(message, generation = connectionGeneration) {
  postMessage({ ...message, generation });
}

function clearStartupDeadline() {
  clearTimeout(startupTimer);
  startupTimer = null;
}

function disconnect(reason = "disconnected") {
  clearStartupDeadline();
  detachSocketListeners?.();
  detachSocketListeners = null;
  if (socket) {
    runRecorderAction(() => recorder.interrupt(`WebSocket transport ${reason}; recording interrupted`));
  }
  if (stateView) Atomics.store(stateView, STATE.CONNECTED, 0);
  if (socket) {
    const previous = socket;
    socket = null;
    previous.close();
  }
  connectionGeneration = null;
  sharedBuffer = null;
  stateView = null;
  sampleView = null;
  streamInfo = null;
  nativeInputStats = null;
  pcmRefused = false;
}

function handleSocketMessage(event) {
  const generation = connectionGeneration;
  if (typeof event.data === "string") {
    let message;
    try {
      if (event.data.length > MAX_CONTROL_CHARS) throw new Error();
      message = JSON.parse(event.data);
      validateControl(message);
    } catch {
      postConnectionMessage({ type: "error", code: "invalid-control", message: "Invalid or unsupported stream control" });
      return;
    }
    if (message.type === "stream-started") {
      try {
        if (!streamInfo && (recordingStartsPending || recorder.state === "recording" || recorder.state === "stopping")) {
          const connection = socket;
          runRecorderAction(() => recorder.enqueueLifecycle(() => {
            if (socket === connection) configureStream(message);
          }));
          return;
        }
        configureStream(message);
      } catch {
        postConnectionMessage({ type: "error", code: "invalid-control", message: "Stream configuration refused" });
      }
    } else if (message.type === "native-input-stats") {
      // Stats can precede a stream-started deferred behind a pending Start.
      // Drop them without evidence; the next periodic report is admitted.
      if (!streamInfo) return;
      if (message.source !== streamInfo.source ||
          (nativeInputStats && message.atFrame < nativeInputStats.atFrame)) {
        recorder.noteInvalidBlock("Native stats source or frame cursor disagrees with stream generation");
        postConnectionMessage({ type: "error", code: "invalid-native-stats",
          message: "Native stats source or frame cursor disagrees with stream generation" });
        return;
      }
      nativeInputStats = message;
      recorder.setNativeInputStats(message);
      postConnectionMessage({ type: "native-input-stats", stats: nativeInputStats });
    } else if (message.type === "stream-error") {
      if (message.code === "device-lost") {
        // The terminal socket-state retires this generation on the page, so
        // the bridge's explanation travels on that message itself.
        terminateConnection(socket, "device-lost", { code: message.code, message: message.message });
        return;
      }
      if (streamInfo) recorder.noteWebSocketLag({ code: message.code, message: message.message });
      postConnectionMessage({ type: "error", message: message.message, code: message.code }, generation);
    }
    return;
  }
  writePcmBlock(event.data);
}

function validateControl(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
  const integer = (value, max, min = 0) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (message.type === "stream-started") {
    if (!["sine", "input"].includes(message.source) || !integer(message.channels, 64, 1) || !integer(message.sampleRate, 384000, 1) ||
        !integer(message.framesPerBlock, 65536, 1) || message.sampleFormat !== "f32-interleaved" ||
        ringCapacity(message) * message.channels * RING_BUFFER_BYTES_PER_SAMPLE + STATE_BYTES > MAX_RING_BYTES) {
      throw new Error();
    }
  } else if (message.type === "native-input-stats") {
    if (!["sine", "input"].includes(message.source) ||
        !["nativeDroppedBlocks", "nativeDroppedFrames", "nativeDropEvents", "bridgeQueueCapacityBlocks", "atFrame"]
          .every((key) => integer(message[key], Number.MAX_SAFE_INTEGER))) throw new Error();
  } else if (message.type === "stream-error") {
    if (!["server-client-lagged", "device-lost"].includes(message.code) ||
        typeof message.message !== "string" || message.message.length > 1024) throw new Error();
  } else {
    throw new Error();
  }
}

function ringCapacity(info) {
  // A power of two divides the uint32 cursor period, preserving sample
  // positions across cursor wrap. Geometry is checked before allocation.
  return 2 ** Math.ceil(Math.log2(
    Math.max(info.framesPerBlock * 8, info.sampleRate * CAPACITY_SECONDS),
  ));
}

function configureStream(info) {
  const recordingBusy = recordingStartsPending || recorder.state === "recording" || recorder.state === "stopping";
  if (streamInfo && ["source", "sampleRate", "channels", "framesPerBlock", "sampleFormat"]
    .every((key) => streamInfo[key] === info[key])) {
    if (!recordingBusy) pcmRefused = false;
    return;
  }
  if (recordingBusy) {
    pcmRefused = true;
    // Queue the integrity event after any pending Start, before later Stop/Reset.
    runRecorderAction(() => recorder.enqueueLifecycle(() => {
      if (recorder.state === "recording" || recorder.state === "stopping") {
        recorder.noteInvalidBlock("Stream geometry changed during recording; further PCM refused until Stop and reconfiguration/reconnect");
      }
    }));
    throw new Error("Cannot change stream geometry during recording");
  }
  const capacityFrames = ringCapacity(info);
  const sampleBytes = capacityFrames * info.channels * RING_BUFFER_BYTES_PER_SAMPLE;
  const buffer = new SharedArrayBuffer(STATE_BYTES + sampleBytes);
  const state = new Int32Array(buffer, 0, STATE_INTS);
  pcmRefused = false;
  streamInfo = info;
  clearStartupDeadline();
  nativeInputStats = null;
  recorder.setNativeInputStats(null);
  sharedBuffer = buffer;
  stateView = state;
  Atomics.store(stateView, STATE.WRITE_FRAME, 0);
  Atomics.store(stateView, STATE.READ_FRAME, 0);
  Atomics.store(stateView, STATE.OVERFLOW_COUNT, 0);
  Atomics.store(stateView, STATE.UNDERRUN_COUNT, 0);
  Atomics.store(stateView, STATE.CHANNELS, info.channels);
  Atomics.store(stateView, STATE.CAPACITY_FRAMES, capacityFrames);
  Atomics.store(stateView, STATE.CONNECTED, 1);
  Atomics.store(stateView, STATE.SAMPLE_RATE, info.sampleRate);
  Atomics.store(stateView, STATE.FRAMES_PER_BLOCK, info.framesPerBlock);
  Atomics.store(stateView, STATE.RECEIVED_BLOCKS, 0);
  sampleView = createRingBufferViews(sharedBuffer, stateView).sampleView;
  postConnectionMessage({ type: "shared-buffer", sharedBuffer, stream: info });
}

function writePcmBlock(buffer) {
  if (pcmRefused || !stateView || !sampleView || !streamInfo) {
    return;
  }
  const block = decodePcmBlock(buffer, { expectedChannels: streamInfo.channels });
  if (!block.ok) {
    if (block.kind === "channel-mismatch") {
      recorder.noteChannelMismatch({
        frameStart: block.frameStart,
        frameCount: block.frameCount,
        expectedChannels: streamInfo.channels,
        actualChannels: block.channels,
      });
    } else {
      recorder.noteInvalidBlock(block.message);
    }
    postConnectionMessage({ type: "error", message: block.message });
    return;
  }

  const { frameStart, frameCount, channels, samples, dataBytes } = block;
  const receivedBlockIndex = Atomics.load(stateView, STATE.RECEIVED_BLOCKS);
  recorder.recordBlock({ frameStart, frameCount, channels, receivedBlockIndex, dataBytes });
  writePcmToRingBuffer(stateView, sampleView, samples, frameCount);
  Atomics.add(stateView, STATE.RECEIVED_BLOCKS, 1);
  maybePostMeters(samples, frameCount, channels);
}

function maybePostMeters(samples, frameCount, channels) {
  const now = performance.now();
  if (now - lastMeterPost < 80) {
    return;
  }
  lastMeterPost = now;
  const peak = new Array(channels).fill(0);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const value = Math.abs(samples[frame * channels + channel]);
      if (value > peak[channel]) {
        peak[channel] = value;
      }
    }
  }
  postConnectionMessage({ type: "meters", peak });
}

function readCounters() {
  if (!stateView) {
    return {
      underruns: 0,
      overflows: 0,
      receivedBlocks: 0,
    };
  }
  return {
    underruns: Atomics.load(stateView, STATE.UNDERRUN_COUNT),
    overflows: Atomics.load(stateView, STATE.OVERFLOW_COUNT),
    receivedBlocks: Atomics.load(stateView, STATE.RECEIVED_BLOCKS),
  };
}

function runRecorderAction(action) {
  action().catch((error) => {
    postMessage({ type: "recording-error", message: error.message });
    postMessage({ type: "recording-status", status: recorder.status() });
  });
}

function runExport(action) {
  if (exportPending) return;
  exportPending = true;
  postMessage({ type: "export-status", pending: true });
  Promise.resolve().then(action)
    .then((result) => {
      postMessage({ type: "download", filename: result.filename, blob: result.blob });
    })
    .catch((error) => {
      postMessage({ type: "export-error", message: error.message });
      postMessage({ type: "recording-status", status: recorder.status() });
    }).finally(() => {
      exportPending = false;
      postMessage({ type: "export-status", pending: false });
    });
}

function runRecoveryScan(requestId) {
  runRecoveryAction(() => recorder.scanRecoverySessions(), false, requestId);
}

function runDeleteRecoveredSession(sessionId, requestId) {
  runRecoveryAction(() => recorder.deleteRecoveredSession(sessionId), true, requestId);
}

function runRecoveryAction(action, mutation, requestId) {
  const generation = ++recoveryGeneration;
  // A scan requested during deletion must read after that mutation completes.
  recoveryQueue = recoveryQueue.then(action).catch(async (error) => {
    if (mutation) {
      postMessage({ type: "recording-error", message: error.message });
      return recorder.scanRecoverySessions();
    }
    return { available: false, error: error.message,
      scannedAt: new Date().toISOString(), sessions: [] };
  }).then((result) => {
    if (generation === recoveryGeneration) {
      postMessage({ type: "recovery-sessions", generation, requestId, result });
    }
  }).catch((error) => {
    if (generation === recoveryGeneration) {
      postMessage({ type: "recovery-sessions", generation, requestId, result: {
        available: false, error: error.message, sessions: [],
      } });
    }
  });
}

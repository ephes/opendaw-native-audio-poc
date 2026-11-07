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
const MAX_CONTROL_CHARS = 4096;
const MAX_RING_BYTES = 64 * 1024 * 1024;

let socket = null;
let sharedBuffer = null;
let stateView = null;
let sampleView = null;
let streamInfo = null;
let lastMeterPost = 0;
let nativeInputStats = null;
let recordingStartsPending = 0;
let pcmRefused = false;
let recorder = new PcmRecorder({
  readCounters,
  postMessage: (message) => postMessage(message),
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "connect") {
    connect(message.url);
  } else if (message.type === "disconnect") {
    disconnect();
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
    runRecoveryScan();
  } else if (message.type === "export-recovered-manifest") {
    runExport(() => recorder.exportRecoveredManifest(message.sessionId));
  } else if (message.type === "export-recovered-wav") {
    runExport(() =>
      recorder.exportRecoveredSelectedChannelWav(message.sessionId, message.channelIndex),
    );
  } else if (message.type === "delete-recovered-session") {
    runDeleteRecoveredSession(message.sessionId);
  }
});

function connect(url) {
  disconnect();
  const connection = new WebSocket(url);
  socket = connection;
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    if (socket !== connection) return;
    postMessage({ type: "socket-state", state: "open" });
  });
  socket.addEventListener("close", () => terminateConnection(connection, "closed"));
  socket.addEventListener("error", () => terminateConnection(connection, "error"));
  socket.addEventListener("message", (event) => {
    if (socket !== connection) return;
    handleSocketMessage(event);
  });
}

function terminateConnection(connection, state) {
  if (socket !== connection) return;
  // Capture counters before disconnect clears this stream; the lifecycle queue
  // also covers a Start that has not finished creating its session yet.
  disconnect(state);
  postMessage({ type: "socket-state", state });
}

function disconnect(reason = "disconnected") {
  if (socket) {
    runRecorderAction(() => recorder.interrupt(`WebSocket transport ${reason}; recording interrupted`));
  }
  if (stateView) Atomics.store(stateView, STATE.CONNECTED, 0);
  if (socket) {
    const previous = socket;
    socket = null;
    previous.close();
  }
  sharedBuffer = null;
  stateView = null;
  sampleView = null;
  streamInfo = null;
  nativeInputStats = null;
  pcmRefused = false;
}

function handleSocketMessage(event) {
  if (typeof event.data === "string") {
    let message;
    try {
      if (event.data.length > MAX_CONTROL_CHARS) throw new Error();
      message = JSON.parse(event.data);
      validateControl(message);
    } catch {
      postMessage({ type: "error", code: "invalid-control", message: "Invalid or unsupported stream control" });
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
        postMessage({ type: "error", code: "invalid-control", message: "Stream configuration refused" });
      }
    } else if (message.type === "native-input-stats") {
      nativeInputStats = message;
      if (streamInfo) recorder.setNativeInputStats(message);
      postMessage({ type: "native-input-stats", stats: nativeInputStats });
    } else if (message.type === "stream-error") {
      if (streamInfo) recorder.noteWebSocketLag({ code: message.code, message: message.message });
      postMessage({ type: "error", message: message.message, code: message.code });
    }
    return;
  }
  writePcmBlock(event.data);
}

function validateControl(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
  const integer = (value, max, min = 0) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (message.type === "stream-started") {
    if (!integer(message.channels, 64, 1) || !integer(message.sampleRate, 384000, 1) ||
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
  if (streamInfo && ["sampleRate", "channels", "framesPerBlock", "sampleFormat"]
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
  if (nativeInputStats) recorder.setNativeInputStats(nativeInputStats);
  postMessage({ type: "shared-buffer", sharedBuffer, stream: info });
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
    postMessage({ type: "error", message: block.message });
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
  postMessage({ type: "meters", peak });
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
  action()
    .then((result) => {
      postMessage({ type: "download", filename: result.filename, blob: result.blob });
    })
    .catch((error) => {
      postMessage({ type: "recording-error", message: error.message });
      postMessage({ type: "recording-status", status: recorder.status() });
    });
}

function runRecoveryScan() {
  recorder
    .scanRecoverySessions()
    .then((result) => {
      postMessage({ type: "recovery-sessions", result });
    })
    .catch((error) => {
      postMessage({
        type: "recovery-sessions",
        result: {
          available: false,
          error: error.message,
          scannedAt: new Date().toISOString(),
          sessions: [],
        },
      });
    });
}

function runDeleteRecoveredSession(sessionId) {
  recorder
    .deleteRecoveredSession(sessionId)
    .then((result) => {
      postMessage({ type: "recovery-sessions", result });
    })
    .catch((error) => {
      postMessage({ type: "recording-error", message: error.message });
      runRecoveryScan();
    });
}

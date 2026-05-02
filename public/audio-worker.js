import { decodePcmBlock } from "./pcm-block.js";
import { PcmRecorder } from "./recorder.js";

const STATE_BYTES = 256;
const STATE_INTS = 64;
const BYTES_PER_SAMPLE = 4;
const CAPACITY_SECONDS = 2;

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

let socket = null;
let sharedBuffer = null;
let stateView = null;
let sampleView = null;
let streamInfo = null;
let lastMeterPost = 0;
let nativeInputStats = null;
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
    runRecorderAction(() => recorder.start(streamInfo));
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
  socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    postMessage({ type: "socket-state", state: "open" });
  });
  socket.addEventListener("close", () => {
    if (stateView) {
      Atomics.store(stateView, STATE.CONNECTED, 0);
    }
    postMessage({ type: "socket-state", state: "closed" });
  });
  socket.addEventListener("error", () => {
    postMessage({ type: "socket-state", state: "error" });
  });
  socket.addEventListener("message", handleSocketMessage);
}

function disconnect() {
  if (socket) {
    socket.close();
    socket = null;
  }
  sharedBuffer = null;
  stateView = null;
  sampleView = null;
  streamInfo = null;
  nativeInputStats = null;
}

function handleSocketMessage(event) {
  if (typeof event.data === "string") {
    const message = JSON.parse(event.data);
    if (message.type === "stream-started") {
      configureStream(message);
    } else if (message.type === "native-input-stats") {
      nativeInputStats = message;
      recorder.setNativeInputStats(message);
      postMessage({ type: "native-input-stats", stats: nativeInputStats });
    } else if (message.type === "stream-error") {
      recorder.noteWebSocketLag({ code: message.code, message: message.message });
      postMessage({ type: "error", message: message.message, code: message.code });
    }
    return;
  }
  writePcmBlock(event.data);
}

function configureStream(info) {
  streamInfo = info;
  const capacityFrames = Math.max(info.framesPerBlock * 8, info.sampleRate * CAPACITY_SECONDS);
  const sampleBytes = capacityFrames * info.channels * BYTES_PER_SAMPLE;
  sharedBuffer = new SharedArrayBuffer(STATE_BYTES + sampleBytes);
  stateView = new Int32Array(sharedBuffer, 0, STATE_INTS);
  sampleView = new Float32Array(sharedBuffer, STATE_BYTES, capacityFrames * info.channels);
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
  postMessage({ type: "shared-buffer", sharedBuffer, stream: info });
}

function writePcmBlock(buffer) {
  if (!stateView || !sampleView || !streamInfo) {
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
  const capacityFrames = Atomics.load(stateView, STATE.CAPACITY_FRAMES);
  let writeFrame = Atomics.load(stateView, STATE.WRITE_FRAME);
  let readFrame = Atomics.load(stateView, STATE.READ_FRAME);
  const available = writeFrame - readFrame;

  if (available + frameCount > capacityFrames) {
    const newReadFrame = writeFrame + frameCount - capacityFrames;
    Atomics.store(stateView, STATE.READ_FRAME, newReadFrame);
    Atomics.add(stateView, STATE.OVERFLOW_COUNT, 1);
    readFrame = newReadFrame;
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    const ringFrame = (writeFrame + frame) % capacityFrames;
    const ringOffset = ringFrame * channels;
    const inputOffset = frame * channels;
    sampleView.set(samples.subarray(inputOffset, inputOffset + channels), ringOffset);
  }

  Atomics.store(stateView, STATE.WRITE_FRAME, writeFrame + frameCount);
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

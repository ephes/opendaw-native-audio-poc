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

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "connect") {
    connect(message.url);
  } else if (message.type === "disconnect") {
    disconnect();
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
}

function handleSocketMessage(event) {
  if (typeof event.data === "string") {
    const message = JSON.parse(event.data);
    if (message.type === "stream-started") {
      configureStream(message);
    } else if (message.type === "stream-error") {
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
  const view = new DataView(buffer);
  const frameCount = view.getUint32(8, true);
  const channels = view.getUint16(12, true);
  if (channels !== streamInfo.channels) {
    postMessage({
      type: "error",
      message: `PCM block channel mismatch: expected ${streamInfo.channels}, got ${channels}`,
    });
    return;
  }

  const incoming = new Float32Array(buffer, 16);
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
    sampleView.set(incoming.subarray(inputOffset, inputOffset + channels), ringOffset);
  }

  Atomics.store(stateView, STATE.WRITE_FRAME, writeFrame + frameCount);
  Atomics.add(stateView, STATE.RECEIVED_BLOCKS, 1);
  maybePostMeters(incoming, frameCount, channels);
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

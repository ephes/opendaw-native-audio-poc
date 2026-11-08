import {
  alignReadCursor,
  createRingBufferViews,
  readStereoFromRingBuffer,
  STATE,
  STATE_BYTES,
  STATE_INTS,
} from "./ring-buffer.js";

class NativeBridgeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.state = null;
    this.samples = null;
    this.left = 0;
    this.right = 1;
    this.statusCountdown = 0;
    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    const refuse = () => this.port.postMessage({
      type: "control-error", message: "Invalid monitor control",
    });
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return refuse();
    }
    const validChannel = (value, channels) =>
      Number.isInteger(value) && value >= 0 && value < channels;
    if (message.type === "configure") {
      const buffer = message.sharedBuffer;
      if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength < STATE_BYTES ||
          buffer.byteLength > 64 * 1024 * 1024) return refuse();
      const state = new Int32Array(buffer, 0, STATE_INTS);
      const channels = Atomics.load(state, STATE.CHANNELS);
      const capacity = Atomics.load(state, STATE.CAPACITY_FRAMES);
      const sampleRate = Atomics.load(state, STATE.SAMPLE_RATE);
      const blockFrames = Atomics.load(state, STATE.FRAMES_PER_BLOCK);
      if (channels < 1 || channels > 64 || capacity < 1 ||
          (capacity & (capacity - 1)) !== 0 ||
          sampleRate < 1 || sampleRate > 384000 ||
          blockFrames < 1 || blockFrames > 65536 ||
          buffer.byteLength !== STATE_BYTES + capacity * channels * 4) return refuse();
      const left = message.left === undefined ? Math.min(this.left, channels - 1) : message.left;
      const right = message.right === undefined ? Math.min(this.right, channels - 1) : message.right;
      if (!validChannel(left, channels) || !validChannel(right, channels)) return refuse();
      const views = createRingBufferViews(buffer, state);
      this.state = views.stateView;
      this.samples = views.sampleView;
      this.left = left;
      this.right = right;
      alignReadCursor(this.state);
      Atomics.store(this.state, STATE.OVERFLOW_COUNT, 0);
      Atomics.store(this.state, STATE.UNDERRUN_COUNT, 0);
      this.port.postMessage({ type: "counters-reset" });
    } else if (message.type === "channels") {
      const channels = this.state && Atomics.load(this.state, STATE.CHANNELS);
      if (!validChannel(message.left, channels) || !validChannel(message.right, channels)) return refuse();
      this.left = message.left;
      this.right = message.right;
    } else {
      refuse();
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const leftOut = output[0];
    const rightOut = output[1] ?? output[0];

    if (!this.state || !this.samples) {
      leftOut.fill(0);
      rightOut.fill(0);
      return true;
    }

    readStereoFromRingBuffer(
      this.state,
      this.samples,
      leftOut,
      rightOut,
      this.left,
      this.right,
    );
    this.statusCountdown -= 1;
    if (this.statusCountdown <= 0) {
      this.statusCountdown = 20;
      this.port.postMessage({ type: "status" });
    }
    return true;
  }
}

registerProcessor("native-bridge-processor", NativeBridgeProcessor);

import {
  alignReadCursor,
  createRingBufferViews,
  readStereoFromRingBuffer,
  STATE,
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
    if (message.type === "configure") {
      const views = createRingBufferViews(message.sharedBuffer);
      this.state = views.stateView;
      this.samples = views.sampleView;
      if (typeof message.left === "number") {
        this.left = message.left;
      }
      if (typeof message.right === "number") {
        this.right = message.right;
      }
      alignReadCursor(this.state);
      Atomics.store(this.state, STATE.OVERFLOW_COUNT, 0);
      Atomics.store(this.state, STATE.UNDERRUN_COUNT, 0);
      this.port.postMessage({ type: "counters-reset" });
    } else if (message.type === "channels") {
      this.left = message.left;
      this.right = message.right;
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

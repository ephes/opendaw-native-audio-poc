const STATE_BYTES = 256;

const STATE = {
  WRITE_FRAME: 0,
  READ_FRAME: 1,
  OVERFLOW_COUNT: 2,
  UNDERRUN_COUNT: 3,
  CHANNELS: 4,
  CAPACITY_FRAMES: 5,
  FRAMES_PER_BLOCK: 8,
};

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
      this.state = new Int32Array(message.sharedBuffer, 0, 64);
      const channels = Atomics.load(this.state, STATE.CHANNELS);
      const capacityFrames = Atomics.load(this.state, STATE.CAPACITY_FRAMES);
      this.samples = new Float32Array(message.sharedBuffer, STATE_BYTES, capacityFrames * channels);
      if (typeof message.left === "number") {
        this.left = message.left;
      }
      if (typeof message.right === "number") {
        this.right = message.right;
      }
      this.alignReadCursor();
      Atomics.store(this.state, STATE.OVERFLOW_COUNT, 0);
      Atomics.store(this.state, STATE.UNDERRUN_COUNT, 0);
      this.port.postMessage({ type: "counters-reset" });
    } else if (message.type === "channels") {
      this.left = message.left;
      this.right = message.right;
    }
  }

  alignReadCursor() {
    if (!this.state) {
      return;
    }
    const writeFrame = Atomics.load(this.state, STATE.WRITE_FRAME);
    const framesPerBlock = Atomics.load(this.state, STATE.FRAMES_PER_BLOCK) || 960;
    const targetLatencyFrames = framesPerBlock * 3;
    Atomics.store(this.state, STATE.READ_FRAME, Math.max(0, writeFrame - targetLatencyFrames));
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

    const channels = Atomics.load(this.state, STATE.CHANNELS);
    const capacityFrames = Atomics.load(this.state, STATE.CAPACITY_FRAMES);
    let readFrame = Atomics.load(this.state, STATE.READ_FRAME);
    const writeFrame = Atomics.load(this.state, STATE.WRITE_FRAME);
    let underrun = false;

    for (let index = 0; index < leftOut.length; index += 1) {
      if (readFrame >= writeFrame) {
        leftOut[index] = 0;
        rightOut[index] = 0;
        underrun = true;
        continue;
      }

      const ringFrame = readFrame % capacityFrames;
      const offset = ringFrame * channels;
      leftOut[index] = this.samples[offset + Math.min(this.left, channels - 1)] || 0;
      rightOut[index] = this.samples[offset + Math.min(this.right, channels - 1)] || 0;
      readFrame += 1;
    }

    if (underrun) {
      Atomics.add(this.state, STATE.UNDERRUN_COUNT, 1);
    }
    Atomics.store(this.state, STATE.READ_FRAME, readFrame);
    this.statusCountdown -= 1;
    if (this.statusCountdown <= 0) {
      this.statusCountdown = 20;
      this.port.postMessage({ type: "status" });
    }
    return true;
  }
}

registerProcessor("native-bridge-processor", NativeBridgeProcessor);

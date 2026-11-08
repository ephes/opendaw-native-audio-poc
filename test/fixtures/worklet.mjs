import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as ring from "../../public/ring-buffer.js";

// Only replace the module import; execute the actual registered processor with
// the production ring helpers and the same shared-memory primitives as a worklet.
const source = readFileSync(new URL("../../public/bridge-processor.js", import.meta.url), "utf8")
  .replace(/^import\s*\{[^}]*\}\s*from\s*"\.\/ring-buffer\.js";/, "");

export function workletFixture() {
  const messages = [];
  let Processor;
  vm.runInNewContext(source, {
    ...ring, SharedArrayBuffer, Int32Array, Float32Array, Atomics,
    AudioWorkletProcessor: class {
      port = { postMessage: (message) => messages.push(structuredClone(message)) };
    },
    registerProcessor(name, value) {
      assert.equal(name, "native-bridge-processor");
      Processor = value;
    },
  }, { filename: "bridge-processor.js" });
  const processor = new Processor();
  return {
    messages,
    send: (data) => processor.port.onmessage({ data }),
    render(frames = 4) {
      const output = [new Float32Array(frames).fill(99), new Float32Array(frames).fill(99)];
      assert.equal(processor.process([], [output]), true);
      return output.map((channel) => Array.from(channel));
    },
  };
}

export function monitorRing(channels = 3, capacityFrames = 32, framesPerBlock = 4) {
  const sharedBuffer = new SharedArrayBuffer(ring.STATE_BYTES + channels * capacityFrames * 4);
  const state = new Int32Array(sharedBuffer, 0, ring.STATE_INTS);
  state[ring.STATE.CHANNELS] = channels;
  state[ring.STATE.CAPACITY_FRAMES] = capacityFrames;
  state[ring.STATE.SAMPLE_RATE] = 48000;
  state[ring.STATE.FRAMES_PER_BLOCK] = framesPerBlock;
  const { sampleView } = ring.createRingBufferViews(sharedBuffer);
  return { sharedBuffer, state,
    write(start, frames) {
      const samples = Float32Array.from({ length: channels * frames }, (_, i) =>
        (start + Math.floor(i / channels)) * 10 + i % channels + 1);
      ring.writePcmToRingBuffer(state, sampleView, samples, frames);
    },
  };
}

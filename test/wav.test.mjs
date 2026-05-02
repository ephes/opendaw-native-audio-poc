import assert from "node:assert/strict";
import { test } from "node:test";

import { createMonoFloat32WavBlob, extractChannel } from "../public/wav.js";

const FLOAT32_BYTES = 4;
const RIFF_HEADER_BYTES = 44;

test("extractChannel deinterleaves one channel from interleaved Float32 samples", () => {
  const samples = new Float32Array([
    0.1, 1.1, 2.1,
    0.2, 1.2, 2.2,
    0.3, 1.3, 2.3,
  ]);

  assert.deepEqual([...extractChannel(samples, 1, 3, 3)], [
    samples[1],
    samples[4],
    samples[7],
  ]);
});

test("extractChannel pads missing trailing samples with zero", () => {
  const samples = new Float32Array([10, 20, 30]);

  assert.deepEqual([...extractChannel(samples, 1, 2, 3)], [20, 0, 0]);
});

test("createMonoFloat32WavBlob writes a mono IEEE Float32 WAV header and payload", async () => {
  const first = new Float32Array([0.25, -0.5]);
  const second = new Float32Array([1]);
  const blob = createMonoFloat32WavBlob({
    sampleRate: 48_000,
    totalFrames: first.length + second.length,
    channelParts: [first, second],
  });

  assert.equal(blob.type, "audio/wav");

  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);

  assert.equal(readAscii(view, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), RIFF_HEADER_BYTES - 8 + 3 * FLOAT32_BYTES);
  assert.equal(readAscii(view, 8, 4), "WAVE");
  assert.equal(readAscii(view, 12, 4), "fmt ");
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 3);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 48_000);
  assert.equal(view.getUint32(28, true), 48_000 * FLOAT32_BYTES);
  assert.equal(view.getUint16(32, true), FLOAT32_BYTES);
  assert.equal(view.getUint16(34, true), 32);
  assert.equal(readAscii(view, 36, 4), "data");
  assert.equal(view.getUint32(40, true), 3 * FLOAT32_BYTES);
  assert.deepEqual(
    [
      view.getFloat32(44, true),
      view.getFloat32(48, true),
      view.getFloat32(52, true),
    ],
    [0.25, -0.5, 1],
  );
});

test("createMonoFloat32WavBlob rejects files beyond the RIFF size limit", () => {
  const maxFrames = Math.floor((0xffff_ffff - (RIFF_HEADER_BYTES - 8)) / FLOAT32_BYTES);

  assert.throws(
    () =>
      createMonoFloat32WavBlob({
        sampleRate: 48_000,
        totalFrames: maxFrames + 1,
        channelParts: [],
      }),
    /larger than the 4 GiB RIFF limit/,
  );
});

function readAscii(view, offset, length) {
  return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, length));
}

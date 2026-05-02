import assert from "node:assert/strict";
import { test } from "node:test";

import { decodePcmBlock, PCM_BLOCK_HEADER_BYTES } from "../public/pcm-block.js";

test("decodePcmBlock decodes the documented little-endian PCM layout", () => {
  const samples = [0.25, -0.5, 1, 0.125, -0.25, 0.75];
  const buffer = createPcmBlock({
    frameStart: 0x1_0000_0020n,
    frameCount: 3,
    channels: 2,
    samples,
  });

  const block = decodePcmBlock(buffer, { expectedChannels: 2 });

  assert.equal(block.ok, true);
  assert.equal(block.frameStart, Number(0x1_0000_0020n));
  assert.equal(block.frameCount, 3);
  assert.equal(block.channels, 2);
  assert.equal(block.reserved, 0);
  assert.deepEqual([...block.samples], samples);
});

test("decodePcmBlock rejects blocks shorter than the 16-byte header", () => {
  const block = decodePcmBlock(new ArrayBuffer(PCM_BLOCK_HEADER_BYTES - 1));

  assert.equal(block.ok, false);
  assert.equal(block.kind, "too-small");
  assert.equal(block.message, "PCM block too small: 15 bytes");
});

test("decodePcmBlock rejects byte-length mismatches", () => {
  const buffer = new ArrayBuffer(PCM_BLOCK_HEADER_BYTES + 12);
  const view = new DataView(buffer);
  view.setBigUint64(0, 64n, true);
  view.setUint32(8, 2, true);
  view.setUint16(12, 2, true);

  const block = decodePcmBlock(buffer);

  assert.equal(block.ok, false);
  assert.equal(block.kind, "byte-length-mismatch");
  assert.equal(block.frameStart, 64);
  assert.equal(block.frameCount, 2);
  assert.equal(block.channels, 2);
  assert.equal(block.expectedBytes, PCM_BLOCK_HEADER_BYTES + 2 * 2 * 4);
  assert.equal(block.actualBytes, PCM_BLOCK_HEADER_BYTES + 12);
  assert.equal(block.message, "PCM block byte length mismatch: expected 32, got 28");
});

test("decodePcmBlock reports byte-length mismatches before channel mismatches", () => {
  const buffer = new ArrayBuffer(PCM_BLOCK_HEADER_BYTES + 8);
  const view = new DataView(buffer);
  view.setBigUint64(0, 96n, true);
  view.setUint32(8, 2, true);
  view.setUint16(12, 3, true);

  const block = decodePcmBlock(buffer, { expectedChannels: 2 });

  assert.equal(block.ok, false);
  assert.equal(block.kind, "byte-length-mismatch");
  assert.equal(block.expectedBytes, PCM_BLOCK_HEADER_BYTES + 2 * 3 * 4);
  assert.equal(block.actualBytes, PCM_BLOCK_HEADER_BYTES + 8);
});

test("decodePcmBlock reports channel mismatches after validating block shape", () => {
  const buffer = createPcmBlock({
    frameStart: 128n,
    frameCount: 2,
    channels: 3,
    samples: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
  });

  const block = decodePcmBlock(buffer, { expectedChannels: 2 });

  assert.equal(block.ok, false);
  assert.equal(block.kind, "channel-mismatch");
  assert.equal(block.frameStart, 128);
  assert.equal(block.frameCount, 2);
  assert.equal(block.expectedChannels, 2);
  assert.equal(block.actualChannels, 3);
  assert.equal(block.message, "PCM block channel mismatch: expected 2, got 3");
});

test("decodePcmBlock payload views start at byte 16 with the expected Float32 length", () => {
  const buffer = createPcmBlock({
    frameStart: 0n,
    frameCount: 4,
    channels: 2,
    samples: [0, 1, 2, 3, 4, 5, 6, 7],
  });

  const block = decodePcmBlock(buffer);

  assert.equal(block.ok, true);
  assert.equal(block.samples.byteOffset, PCM_BLOCK_HEADER_BYTES);
  assert.equal(block.samples.length, 8);
  assert.equal(block.dataBytes.byteOffset, PCM_BLOCK_HEADER_BYTES);
  assert.equal(block.dataBytes.byteLength, 8 * 4);
});

function createPcmBlock({ frameStart, frameCount, channels, samples }) {
  const buffer = new ArrayBuffer(PCM_BLOCK_HEADER_BYTES + samples.length * 4);
  const view = new DataView(buffer);
  view.setBigUint64(0, frameStart, true);
  view.setUint32(8, frameCount, true);
  view.setUint16(12, channels, true);
  view.setUint16(14, 0, true);
  for (const [index, sample] of samples.entries()) {
    view.setFloat32(PCM_BLOCK_HEADER_BYTES + index * 4, sample, true);
  }
  return buffer;
}

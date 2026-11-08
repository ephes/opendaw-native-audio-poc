import assert from "node:assert/strict";
import { test } from "node:test";
import { workerFixture } from "./fixtures/browser.mjs";
import { memoryLocks, memoryStorage, stream } from "./fixtures/opfs.mjs";
import { pcmBlock } from "./fixtures/pcm.mjs";
import { STATE, STATE_BYTES } from "../public/ring-buffer.js";
const settle = () => new Promise(setImmediate);

for (const [name, first, invalid, next] of [
  ["unsafe cursor", BigInt(Number.MAX_SAFE_INTEGER) - 4n,
    [BigInt(Number.MAX_SAFE_INTEGER) - 1n, 9007199254740992n, 9007199254740993n]
      .map((frameStart) => ({ frameStart })), BigInt(Number.MAX_SAFE_INTEGER) - 2n],
  ["unsupported header", 0n,
    [{ frameCount: 0, channels: 0, samples: [] }, { frameCount: 0, samples: [] },
      { channels: 0, samples: [] }, { frameCount: 65537, samples: [] },
      { channels: 65, samples: [] }, { reserved: 1 }, { reserved: 65535 }], 2n],
  ...[NaN, Infinity, -Infinity].flatMap((value) => [0, 1].map((channel) => {
    const samples = [0.25, -0.5, 0.75, -1];
    samples[2 + channel] = value;
    return [`nonfinite ${value} in channel ${channel}`, 0n, [{ frameStart: 2n, samples }], 4n];
  })),
]) {
  test(`${name} never reaches recording or monitor publication`, async (t) => {
    const root = memoryStorage();
    const f = await workerFixture(t, { navigator: {
      storage: { getDirectory: async () => root, persist: async () => true }, locks: memoryLocks(),
    } });
    f.socket.emit("message", JSON.stringify({ type: "stream-started", ...stream }));
    const buffer = f.messages.find((m) => m.type === "shared-buffer").sharedBuffer;
    f.send("recording-start");
    await settle();
    f.socket.emit("message", pcmBlock({ frameStart: first }));
    await settle();
    for (const header of invalid) {
      const snapshot = new Uint8Array(buffer).slice();
      const meterCount = f.messages.filter((m) => m.type === "meters").length;
      f.socket.emit("message", pcmBlock(header));
      assert.equal(f.messages.at(-1).type, "error");
      assert.deepEqual(new Uint8Array(buffer), snapshot);
      assert.equal(f.messages.filter((m) => m.type === "meters").length, meterCount);
    }
    f.socket.emit("message", pcmBlock({ frameStart: next }));
    f.send("recording-stop");
    await settle(); await settle();
    f.send("export-manifest");
    await settle();
    const manifest = JSON.parse(await f.messages.filter((m) => m.type === "download").at(-1).blob.text());
    assert.equal(manifest.integrity.invalidBlocks.length, invalid.length);
    assert.deepEqual(manifest.integrity.channelMismatches, []);
    if (next === first + 2n) {
      assert.deepEqual(manifest.integrity.gaps, []);
    } else {
      assert.equal(manifest.integrity.gaps.length, 1);
      assert.equal(manifest.integrity.gaps[0].missingFrames, 2);
      assert.equal(manifest.integrity.gaps[0].expectedFrameStart, 2);
      assert.equal(manifest.integrity.gaps[0].actualFrameStart, 4);
    }
    assert.deepEqual(manifest.integrity.overlaps, []);
    assert.equal(manifest.firstFrameStart, Number(first));
    assert.equal(manifest.expectedNextFrame, Number(next + 2n));
    assert.equal(manifest.totalRecordedFrames, 4);
    assert.equal(manifest.recordedBlocks, 2);
    const chunk = manifest.chunks[0];
    assert.equal(chunk.bytes, 32);
    assert.deepEqual([...new Float32Array(root.files.get(chunk.fileName).buffer)],
      [0.25, -0.5, 0.75, -1, 0.25, -0.5, 0.75, -1]);
    assert.equal(new Int32Array(buffer, 0, STATE_BYTES / 4)[STATE.RECEIVED_BLOCKS], 2);
  });
}

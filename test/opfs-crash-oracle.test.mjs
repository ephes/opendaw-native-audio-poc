import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheckpointCrashOracle } from "../scripts/opfs-crash-oracle.mjs";
import { installGlobals } from "./fixtures/browser.mjs";
import { memoryStorage, memoryLocks } from "./fixtures/opfs.mjs";

// Check the browser oracle's dispatcher, barriers and negative control using
// the existing in-memory fixture. This does NOT certify real OPFS durability;
// that acceptance requires `just smoke-opfs-recovery` in a real browser.
test("checkpoint oracle reaches all barriers and detects corrupted trusted audio", async (t) => {
  const root = memoryStorage();
  root.entries = async function* () {
    for (const name of root.files.keys()) yield [name, await root.getFileHandle(name)];
  };
  root.files.set("unrelated", new Uint8Array([7]));
  const blobs = new Map(), workers = [];
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { const id = `blob:${crypto.randomUUID()}`; blobs.set(id, blob); return id; };
  URL.revokeObjectURL = (id) => blobs.delete(id);
  t.after(() => { URL.createObjectURL = create; URL.revokeObjectURL = revoke; });
  const fixtureNavigator = { storage: { getDirectory: async () => root }, locks: memoryLocks() };
  class Worker {
    self = {};
    terminated = false;
    constructor(url) {
      workers.push(this);
      this.ready = blobs.get(url).text().then((source) => {
        // The source is authored locally in the oracle above, never user data.
        new Function("self", "postMessage", "navigator", source)(this.self,
          (data) => { if (!this.terminated) this.onmessage({ data }); }, fixtureNavigator);
      });
    }
    postMessage(data) {
      this.ready.then(() => this.self.onmessage({ data })).catch((error) => this.onerror(error));
    }
    terminate() { this.terminated = true; }
  }
  installGlobals(t, { Worker, navigator: fixtureNavigator });
  const results = await runCheckpointCrashOracle(new URL("../public/recorder.js", import.meta.url).href);
  assert.deepEqual(results.map((entry) => entry.barrier), ["after-pcm-close", "after-sidecar-close", "before-manifest-close"]);
  for (const result of results) {
    assert.equal(result.trustedFrames, 2);
    assert.equal(result.recoveredFrames, 4);
    assert.equal(result.retainedBytesUnchanged, true);
    assert.equal(result.corruptionRefused, true);
    assert.equal(result.deleted, true);
  }
  assert.equal(workers.length, 6);
  assert.ok(workers.every((worker) => worker.terminated));
  assert.equal(blobs.size, 0);
  assert.deepEqual([...root.files.keys()].sort(), ["native-pcm-recordings-index.json", "unrelated"]);
  assert.deepEqual(root.files.get("unrelated"), new Uint8Array([7]));
});

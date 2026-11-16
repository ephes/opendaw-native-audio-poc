import assert from "node:assert/strict";
import { test } from "node:test";
import { appFixture, workerFixture, deferred } from "./fixtures/browser.mjs";
import { PcmRecorder } from "../public/recorder.js";
const settle = () => new Promise(setImmediate);

test("worker admits one export before lifecycle enqueue and releases failure for retry", async (t) => {
  let gate = deferred(), calls = 0;
  const original = PcmRecorder.prototype.exportSelectedChannelWav;
  const originalStop = PcmRecorder.prototype.stop;
  let stops = 0;
  PcmRecorder.prototype.stop = async () => { stops++; };
  PcmRecorder.prototype.exportSelectedChannelWav = () => { calls++; return gate.promise; };
  t.after(() => { PcmRecorder.prototype.exportSelectedChannelWav = original; PcmRecorder.prototype.stop = originalStop; });
  const f = await workerFixture(t);
  f.send("export-selected-wav"); f.send("export-selected-wav");
  await settle();
  assert.equal(calls, 1);
  f.send("recording-stop");
  await settle();
  assert.equal(stops, 1);
  gate.reject(new Error("synthetic export failure"));
  await settle();
  assert.equal(f.messages.filter(m => m.type === "export-status").at(-1).pending, false);
  gate = deferred();
  f.send("export-selected-wav");
  await settle();
  assert.equal(calls, 2);
  gate.resolve({ filename: "synthetic.wav", blob: new Blob() });
  await settle();
  assert.equal(f.messages.filter(m => m.type === "download").length, 1);
});

test("page shares pending export ownership across controls and worker retirement", async (t) => {
  const f = await appFixture(t);
  f.worker.emit({ type: "recovery-sessions", result: { available: true, sessions: [{
    sessionId: "native-pcm-synthetic", state: "stopped", channels: 2, exportableWav: true,
  }] } });
  f.click("#recovery-export-wav"); f.click("#recovery-export-manifest"); f.click("#export-wav");
  assert.equal(f.worker.messages.filter(m => m.type.startsWith("export-")).length, 1);
  assert.equal(f.elements.get("#recovery-export-wav").disabled, true);
  f.worker.emit({ type: "export-status", pending: false });
  assert.equal(f.elements.get("#recovery-export-wav").disabled, false);
  f.click("#recovery-export-wav");
  f.worker.fail("error");
  f.click("#recovery-refresh");
  f.worker.emit({ type: "recovery-sessions", result: { available: true, sessions: [{
    sessionId: "native-pcm-synthetic", state: "stopped", channels: 2, exportableWav: true,
  }] } });
  assert.equal(f.elements.get("#recovery-export-wav").disabled, false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { appFixture, workerFixture, deferred, installGlobals } from "./fixtures/browser.mjs";
import { PcmRecorder } from "../public/recorder.js";
const settle = () => new Promise(setImmediate);

test("a delayed scan cannot republish a session after delete", async (t) => {
  const scan = deferred(), deletion = deferred();
  const oldScan = PcmRecorder.prototype.scanRecoverySessions;
  const oldDelete = PcmRecorder.prototype.deleteRecoveredSession;
  let calls = 0;
  PcmRecorder.prototype.scanRecoverySessions = () => ++calls === 1 ? scan.promise : Promise.resolve({ sessions: [] });
  PcmRecorder.prototype.deleteRecoveredSession = () => deletion.promise;
  t.after(() => { PcmRecorder.prototype.scanRecoverySessions = oldScan; PcmRecorder.prototype.deleteRecoveredSession = oldDelete; });
  const f = await workerFixture(t);
  f.send("recovery-scan");
  await settle();
  f.send("delete-recovered-session", { sessionId: "native-pcm-deleted" });
  deletion.resolve({ sessions: [] });
  await settle();
  scan.resolve({ sessions: [{ sessionId: "native-pcm-deleted" }] });
  await settle(); await settle();
  assert.ok(f.messages.filter(m => m.type === "recovery-sessions").every(m => !m.result.sessions.length));
});

for (const failure of ["append", "click", "none"]) {
  test(`download cleanup on ${failure}`, async (t) => {
    const f = await appFixture(t);
    let removed = 0, revoked = 0, timeout;
    installGlobals(t, { URL: { createObjectURL: () => "blob:synthetic", revokeObjectURL: () => revoked++ } });
    document.createElement = () => ({ click() { if (failure === "click") throw new Error("activation refused"); }, remove() { removed++; } });
    document.body = { append() { if (failure === "append") throw new Error("append refused"); } };
    window.setTimeout = (callback, ms) => { assert.equal(ms, 10000); timeout = callback; };
    assert.doesNotThrow(() => f.worker.emit({ type: "download", blob: new Blob(), filename: "synthetic.wav" }));
    assert.equal(removed, 1);
    if (failure === "none") { assert.equal(revoked, 0); timeout(); }
    assert.equal(revoked, 1);
    if (failure !== "none") assert.match(f.elements.get("#record-error").textContent, /refused/);
  });
}

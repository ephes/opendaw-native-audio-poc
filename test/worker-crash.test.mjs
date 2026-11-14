import assert from "node:assert/strict";
import { test } from "node:test";
import { appFixture } from "./fixtures/browser.mjs";

for (const phase of ["start", "recording", "scan"]) {
  for (const type of ["error", "messageerror"]) {
    test(`worker ${type} during ${phase} releases UI and monitor for fresh recovery`, async (t) => {
      const f = await appFixture(t);
      f.worker.emit({ type: "recovery-sessions", result: { available: true, sessions: [] } });
      f.stream();
      const monitor = f.click("#monitor");
      if (phase === "recording") {
        f.contexts[0].load.resolve();
        await monitor;
        f.worker.emit({ type: "recording-status", status: {
          state: "recording", sessionId: "native-pcm-retained", recordedFrames: 2,
        } });
      } else if (phase === "start") {
        f.click("#record-start");
      } else {
        f.click("#recovery-refresh");
      }
      const old = f.worker;
      old.fail(type);
      assert.equal(old.terminations, 1);
      assert.equal(f.contexts[0].closes, 1);
      assert.ok(f.nodes.every((node) => node.disconnected));
      assert.equal(f.elements.get("#connect").disabled, false);
      assert.equal(f.elements.get("#recovery-refresh").disabled, false);
      assert.equal(f.elements.get("#record-state").textContent, "interrupted");
      assert.match(f.elements.get("#record-error").textContent, /Scan Recovery/);
      for (const selector of ["#record-start", "#record-stop", "#record-reset", "#export-manifest", "#export-wav", "#monitor"]) {
        assert.equal(f.elements.get(selector).disabled, true, selector);
      }
      f.click("#recovery-refresh");
      const replacement = f.worker;
      assert.notEqual(replacement, old);
      assert.equal(f.workers.length, 2);
      assert.equal(replacement.messages.at(-1).type, "recovery-scan");
      const summary = f.elements.get("#stream-summary").textContent;
      old.emit({ type: "recording-status", status: { state: "recording" } });
      old.emit({ type: "socket-state", state: "open" });
      old.emit({ type: "error", message: "stale" });
      old.emit({ type: "download", blob: new Blob(), filename: "stale.wav" });
      old.fail("error");
      old.fail("messageerror");
      assert.equal(old.terminations, 1);
      assert.equal(f.elements.get("#record-state").textContent, "interrupted");
      assert.equal(f.elements.get("#stream-summary").textContent, summary);
      replacement.emit({ type: "recovery-sessions", result: { available: true, sessions: [{
        sessionId: "native-pcm-retained", state: "abandoned", channels: 2,
        recoveredFrames: 2, recoveredBytes: 16, chunkCount: 1, exportableWav: true,
      }] } });
      assert.equal(f.elements.get("#recovery-export-wav").disabled, false);
      f.click("#recovery-export-wav");
      assert.equal(replacement.messages.at(-1).sessionId, "native-pcm-retained");
      assert.ok(!old.messages.some((message) => message.type === "recording-reset"));
      f.contexts[0].load.resolve();
      await monitor;
      f.click("#connect");
      f.stream();
      assert.equal(f.elements.get("#record-start").disabled, false);
    });
  }
}

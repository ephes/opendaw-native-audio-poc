import assert from "node:assert/strict";
import { test } from "node:test";

test("status messages update recovery controls without changing the selected export channel", async (t) => {
  class Element {
    value = "";
    children = [];
    handlers = new Map();
    replacements = 0;
    addEventListener(type, callback) { this.handlers.set(type, callback); }
    replaceChildren(...children) {
      this.replacements++;
      this.children = [];
      this.value = "";
      this.append(...children);
    }
    append(...children) {
      if (!this.children.length && children[0]?.value !== undefined) this.value = children[0].value;
      this.children.push(...children);
    }
    click() { this.handlers.get("click")?.(); }
  }
  const elements = new Map();
  let worker;
  class FixtureWorker {
    messages = [];
    constructor() { worker = this; }
    addEventListener(type, handler) { assert.equal(type, "message"); this.receive = handler; }
    postMessage(message) { this.messages.push(message); }
    emit(message) { this.receive({ data: message }); }
  }
  for (const [key, value] of Object.entries({
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
      },
      createElement: () => new Element(),
    },
    window: { crossOriginIsolated: true, isSecureContext: true },
    Worker: FixtureWorker,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
  await import("../public/app.js");
  worker.emit({ type: "recovery-sessions", result: { available: true, sessions: [{
    sessionId: "native-pcm-synthetic", state: "stopped", channels: 6, sampleRate: 48000,
    recoveredFrames: 2, recoveredBytes: 48, chunkCount: 1, exportableWav: true,
  }] } });
  const channel = elements.get("#recovery-wav-channel");
  channel.value = "4";
  const sessions = elements.get("#recovery-session");
  const replacements = sessions.replacements;
  for (const state of ["idle", "recording", "stopping", "stopped"]) {
    worker.emit({ type: "recording-status", status: { state } });
    assert.equal(channel.value, "4");
    assert.equal(sessions.replacements, replacements);
    const active = state === "recording" || state === "stopping";
    assert.equal(elements.get("#recovery-export-wav").disabled, active);
    assert.equal(elements.get("#recovery-export-manifest").disabled, active);
  }
  elements.get("#recovery-export-wav").click();
  assert.deepEqual(worker.messages.at(-1), {
    type: "export-recovered-wav", sessionId: "native-pcm-synthetic", channelIndex: 4,
  });
});

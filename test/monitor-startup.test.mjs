import assert from "node:assert/strict";
import { test } from "node:test";
import { appFixture, deferred } from "./fixtures/browser.mjs";
const settle = () => new Promise(setImmediate);

test("double click shares module loading and publishes one resumed monitor", async (t) => {
  const f = await appFixture(t);
  const buffer = f.stream();
  const first = f.click("#monitor"), second = f.click("#monitor");
  assert.equal(f.contexts.length, 1);
  assert.equal(f.nodes.length, 0);
  f.contexts[0].load.resolve();
  await Promise.all([first, second]);
  await settle();
  assert.equal(f.nodes.length, 1);
  assert.equal(f.nodes[0].messages[0].sharedBuffer, buffer);
  assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
  assert.equal(f.elements.get("#monitor").disabled, true);
});

test("disconnect cancels loading and cannot publish over a newer monitor", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const old = f.click("#monitor");
  const stale = f.contexts[0];
  f.click("#connect");
  assert.equal(stale.closes, 1);
  const buffer = f.stream();
  const current = f.click("#monitor");
  stale.load.resolve();
  await old;
  assert.equal(f.nodes.length, 0);
  f.contexts[1].load.resolve();
  await current;
  await settle();
  assert.equal(f.nodes.length, 1);
  assert.equal(f.nodes[0].context, f.contexts[1]);
  assert.equal(f.nodes[0].messages[0].sharedBuffer, buffer);
  assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
});

for (const phase of ["load", "resume"]) {
  test(`${phase} rejection closes owned resources and allows retry`, async (t) => {
    const f = await appFixture(t);
    f.stream();
    const result = f.click("#monitor");
    const context = f.contexts[0];
    if (phase === "load") context.load.reject(new Error("synthetic module failure"));
    else {
      const resume = deferred();
      context.resumeResult = resume.promise;
      context.load.resolve();
      await settle();
      resume.reject(new Error("synthetic resume failure"));
    }
    await result;
    await settle();
    assert.equal(context.closes, 1);
    assert.ok(f.nodes.every((node) => node.disconnected));
    assert.equal(f.elements.get("#monitor").disabled, false);
    assert.equal(f.elements.get("#monitor").textContent, "Start Monitor");
    assert.match(f.elements.get("#stream-summary").textContent, /failure/);
    const retry = f.click("#monitor");
    f.contexts[1].load.resolve();
    await retry;
    await settle();
    assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
  });
}

test("disconnect during resume retires the node and ignores stale completion", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const result = f.click("#monitor");
  const resume = deferred();
  f.contexts[0].resumeResult = resume.promise;
  f.contexts[0].load.resolve();
  await settle();
  f.click("#connect");
  resume.resolve();
  await result;
  await settle();
  assert.equal(f.contexts[0].closes, 1);
  assert.ok(f.nodes.every((node) => node.disconnected));
  assert.equal(f.elements.get("#monitor").textContent, "Start Monitor");
  assert.equal(f.elements.get("#monitor").disabled, true);
});

test("channel selection during resume reaches the owned node", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const result = f.click("#monitor"), resume = deferred();
  f.contexts[0].resumeResult = resume.promise;
  f.contexts[0].load.resolve();
  await settle();
  f.elements.get("#left-channel").value = "1";
  f.elements.get("#left-channel").handlers.get("change")();
  assert.deepEqual(f.nodes[0].messages.at(-1), { type: "channels", left: 1, right: 1 });
  resume.resolve();
  await result;
});

async function monitor(f) {
  const start = f.click("#monitor");
  f.contexts.at(-1).load.resolve();
  await start;
  await settle();
  return f.nodes.at(-1);
}

test("retired worklet messages cannot rebaseline the replacement recording", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const old = await monitor(f);
  const late = old.portHandlers.get("message");
  f.stream();
  const current = await monitor(f);
  const before = f.worker.messages.length;
  late({ data: { type: "status" } });
  late({ data: { type: "counters-reset" } });
  assert.equal(f.worker.messages.length, before);
  assert.equal(old.portHandlers.size, 0);
  current.portHandlers.get("message")({ data: { type: "counters-reset" } });
  assert.equal(f.worker.messages.at(-1).type, "recording-counters-reset");
});

test("processor fault releases once, permits retry and fences retired faults", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const old = await monitor(f);
  const fault = old.handlers.get("processorerror");
  assert.equal(typeof fault, "function");
  fault(); fault();
  assert.equal(old.context.closes, 1);
  assert.equal(old.disconnected, true);
  assert.equal(old.handlers.size, 0);
  assert.equal(old.portHandlers.size, 0);
  assert.equal(f.elements.get("#monitor").disabled, false);
  assert.match(f.elements.get("#stream-summary").textContent, /processor.*failed/i);
  const current = await monitor(f);
  fault();
  assert.equal(current.context.closes, 0);
  assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
});

test("processor fault during resume cannot publish failed monitor", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const resume = deferred();
  const start = f.click("#monitor");
  f.contexts[0].resumeResult = resume.promise;
  f.contexts[0].load.resolve();
  await settle();
  const fault = f.nodes[0].handlers.get("processorerror");
  assert.equal(typeof fault, "function");
  fault();
  resume.resolve();
  await start;
  assert.equal(f.elements.get("#monitor").textContent, "Start Monitor");
  assert.equal(f.elements.get("#monitor").disabled, false);
  assert.equal(f.contexts[0].closes, 1);
});

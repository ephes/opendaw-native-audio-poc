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
  const lateState = old.context.handlers.get("statechange");
  f.stream();
  const current = await monitor(f);
  const before = f.worker.messages.length;
  assert.equal(old.context.handlers.size, 0);
  for (const state of ["suspended", "interrupted", "running", "closed"]) {
    old.context.state = state;
    lateState();
    assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
    assert.equal(current.context.closes, 0);
  }
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

for (const phase of ["load", "resume"]) {
  test(`total monitor deadline expires stalled ${phase} and fences late settlement after retry`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = await appFixture(t);
    f.stream();
    const messages = f.worker.messages.slice();
    const first = f.click("#monitor"), duplicate = f.click("#monitor");
    const old = f.contexts[0], resume = deferred();
    t.mock.timers.tick(6_000);
    if (phase === "resume") {
      old.resumeResult = resume.promise;
      old.load.resolve();
      await settle();
    }
    t.mock.timers.tick(3_999);
    await settle();
    assert.equal(f.elements.get("#monitor").disabled, true);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(f.elements.get("#monitor").disabled, false);
    assert.equal(f.elements.get("#monitor").textContent, "Start Monitor");
    assert.match(f.elements.get("#stream-summary").textContent, /timed out.*retry/i);
    assert.equal(old.closes, 1);
    assert.equal(old.handlers.size, 0);
    assert.ok(f.nodes.every(n => n.disconnected));
    assert.ok(f.nodes.every(n => n.handlers.size === 0 && n.portHandlers.size === 0));
    await Promise.all([first, duplicate]); // Settles even if the browser promise never does.
    const retry = f.click("#monitor");
    const current = f.contexts[1];
    current.load.resolve();
    await retry;
    old.load.resolve(); resume.resolve();
    await settle();
    t.mock.timers.tick(10_000);
    await settle();
    assert.equal(f.contexts.length, 2);
    assert.equal(f.nodes.filter(n => !n.disconnected).length, 1);
    assert.equal(current.closes, 0);
    assert.equal(old.closes, 1);
    assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
    assert.deepEqual(f.worker.messages, messages, "monitor timeout must not change recorder/transport ownership");
  });
}

test("disconnect settles a pending monitor and clears only its deadline", async (t) => {
  const timers = new Map();
  let nextTimer = 0;
  const f = await appFixture(t, {
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  f.stream();
  const pending = f.click("#monitor");
  assert.equal(timers.size, 1);
  const staleTimer = [...timers.values()][0];
  assert.equal(staleTimer.delay, 10_000);
  f.click("#connect");
  assert.equal(timers.size, 0);
  await pending;
  f.stream();
  const current = f.click("#monitor");
  staleTimer.callback();
  await settle();
  assert.equal(timers.size, 1);
  assert.equal(f.contexts[1].closes, 0);
  f.contexts[1].load.resolve();
  await current;
  assert.equal(timers.size, 0);
  staleTimer.callback();
  await settle();
  assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
});

for (const state of ["suspended", "interrupted"]) {
  test(`current ${state} context offers a single user-gesture resume without recorder effects`, async (t) => {
    const f = await appFixture(t);
    f.stream();
    f.worker.emit({ type: "recording-status", status: {
      state: "recording", sessionId: "synthetic-session", recordedFrames: 48000, recordedBlocks: 50,
    } });
    const node = await monitor(f), context = node.context;
    const messages = f.worker.messages.slice(), nodeMessages = node.messages.slice();
    const recorder = ["#record-state", "#record-frames", "#record-blocks", "#record-start", "#record-stop", "#connect"]
      .map(id => ({ ...f.elements.get(id) }));
    context.setState(state);
    assert.equal(f.elements.get("#monitor").textContent, "Resume Monitor");
    assert.equal(f.elements.get("#monitor").disabled, false);
    assert.match(f.elements.get("#stream-summary").textContent, new RegExp(`Monitor ${state}`));
    assert.equal(context.resumes, 1, "state changes must not resume without a user gesture");
    const resume = deferred();
    context.resumeResult = resume.promise;
    const first = f.click("#monitor"), second = f.click("#monitor");
    assert.equal(context.resumes, 2, "resume must be invoked synchronously from the click and shared");
    assert.equal(f.elements.get("#monitor").disabled, true);
    context.setState("running"); // A state event alone cannot settle a pending resume.
    assert.equal(f.elements.get("#monitor").disabled, true);
    resume.resolve();
    await Promise.all([first, second]);
    assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
    assert.equal(f.elements.get("#monitor").disabled, true);
    assert.doesNotMatch(f.elements.get("#stream-summary").textContent, /suspended|interrupted/);
    assert.equal(f.contexts.length, 1);
    assert.equal(f.nodes.length, 1);
    assert.deepEqual(node.messages, nodeMessages, "resume must not reconfigure/reset monitor counters");
    assert.deepEqual(f.worker.messages, messages);
    assert.deepEqual(["#record-state", "#record-frames", "#record-blocks", "#record-start", "#record-stop", "#connect"]
      .map(id => ({ ...f.elements.get(id) })), recorder);
    context.setState(state);
    context.setState("running");
    assert.equal(context.resumes, 2);
    assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
    assert.equal(f.elements.get("#monitor").disabled, true);
  });
}

test("closed current context enables restart and retired state events cannot affect its replacement", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const old = await monitor(f), context = old.context;
  const late = context.handlers.get("statechange");
  assert.equal(typeof late, "function");
  context.setState("closed");
  assert.equal(old.disconnected, true);
  assert.equal(context.handlers.size, 0);
  assert.equal(context.closes, 0, "already closed context must not be closed again");
  assert.equal(f.elements.get("#monitor").textContent, "Start Monitor");
  assert.equal(f.elements.get("#monitor").disabled, false);
  assert.match(f.elements.get("#stream-summary").textContent, /closed.*retry/i);
  const current = await monitor(f);
  for (const state of ["suspended", "interrupted", "running", "closed"]) {
    context.state = state;
    late();
    assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
    assert.equal(current.context.closes, 0);
  }
});

for (const outcome of ["rejection", "timeout"]) {
  test(`user resume ${outcome} retires only the monitor and permits restart`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = await appFixture(t);
    f.stream();
    const old = await monitor(f), context = old.context;
    const late = context.handlers.get("statechange");
    assert.equal(typeof late, "function");
    const before = f.worker.messages.slice();
    context.setState("suspended");
    const resume = deferred();
    context.resumeResult = resume.promise;
    const pending = f.click("#monitor");
    if (outcome === "rejection") resume.reject(new Error("synthetic resume failure"));
    else t.mock.timers.tick(10_000);
    await settle();
    assert.equal(f.elements.get("#monitor").disabled, false);
    assert.equal(f.elements.get("#monitor").textContent, "Start Monitor");
    assert.equal(context.closes, 1);
    assert.equal(context.handlers.size, 0);
    assert.equal(old.disconnected, true);
    await pending;
    const current = await monitor(f);
    resume.resolve();
    context.state = "running";
    late();
    await settle();
    t.mock.timers.tick(10_000);
    await settle();
    assert.equal(current.context.closes, 0);
    assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
    assert.deepEqual(f.worker.messages, before);
  });
}

test("resume settlement without running state keeps the explicit recovery control", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const start = f.click("#monitor");
  const context = f.contexts[0];
  context.resumeState = "interrupted";
  context.load.resolve();
  await start;
  assert.equal(f.elements.get("#monitor").textContent, "Resume Monitor");
  assert.equal(f.elements.get("#monitor").disabled, false);
  context.resumeState = "running";
  await f.click("#monitor");
  assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
});

test("closing during module loading settles startup and fences later readiness", async (t) => {
  const f = await appFixture(t);
  f.stream();
  const pending = f.click("#monitor"), context = f.contexts[0];
  context.setState("closed");
  await settle();
  assert.equal(f.elements.get("#monitor").disabled, false);
  await pending;
  context.load.resolve();
  await settle();
  assert.equal(f.nodes.length, 0);
  assert.equal(context.handlers.size, 0);
});

test("a cleared startup timer cannot expire a later resume on the same context", async (t) => {
  const timers = new Map();
  let nextTimer = 0;
  const f = await appFixture(t, {
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  f.stream();
  const start = f.click("#monitor");
  const stale = [...timers.values()][0], context = f.contexts[0];
  context.load.resolve();
  await start;
  assert.equal(timers.size, 0);
  context.setState("suspended");
  const resume = deferred();
  context.resumeResult = resume.promise;
  const pending = f.click("#monitor");
  stale();
  await settle();
  assert.equal(context.closes, 0);
  assert.equal(timers.size, 1);
  resume.resolve();
  await pending;
  assert.equal(timers.size, 0);
  assert.equal(f.elements.get("#monitor").textContent, "Monitoring");
});

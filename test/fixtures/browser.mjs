import assert from "node:assert/strict";

export function installGlobals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    });
  }
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export async function appFixture(t) {
  class Element {
    value = "";
    children = [];
    handlers = new Map();
    style = {};
    addEventListener(type, callback) { this.handlers.set(type, callback); }
    replaceChildren(...children) { this.children = []; this.value = ""; this.append(...children); }
    append(...children) {
      if (!this.children.length && children[0]?.value !== undefined) this.value = children[0].value;
      this.children.push(...children);
    }
    querySelector() { return new Element(); }
    click() { return this.handlers.get("click")?.(); }
  }
  const elements = new Map(), contexts = [], nodes = [], workers = [];
  let worker;
  class FixtureWorker {
    messages = [];
    handlers = new Map();
    terminations = 0;
    constructor() { worker = this; workers.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    terminate() { this.terminations++; }
    fail(type) { this.handlers.get(type)?.({ preventDefault() {} }); }
    postMessage(message) { this.messages.push(message); }
    emit(message) {
      const scoped = ["socket-state", "shared-buffer", "meters", "native-input-stats", "error"].includes(message.type);
      const generation = this.messages.findLast(m => m.type === "connect")?.generation;
      this.handlers.get("message")?.({ data: scoped ? { generation, ...message } : message });
    }
  }
  class Context {
    load = deferred();
    resumeResult = Promise.resolve();
    state = "suspended";
    closes = 0;
    destination = {};
    audioWorklet = { addModule: () => this.load.promise };
    constructor() { contexts.push(this); }
    resume() { return this.resumeResult; }
    async close() { this.closes++; this.state = "closed"; }
  }
  class Node {
    disconnected = false;
    messages = [];
    handlers = new Map();
    portHandlers = new Map();
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    removeEventListener(type, handler) { if (this.handlers.get(type) === handler) this.handlers.delete(type); }
    port = {
      addEventListener: (type, handler) => this.portHandlers.set(type, handler),
      removeEventListener: (type, handler) => { if (this.portHandlers.get(type) === handler) this.portHandlers.delete(type); },
      start() {},
      postMessage: (message) => this.messages.push(message),
    };
    constructor(context) { this.context = context; nodes.push(this); }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  installGlobals(t, {
    document: {
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
      },
      createElement: () => new Element(),
    },
    window: { crossOriginIsolated: true, isSecureContext: true },
    location: { protocol: "http:", host: "synthetic.invalid" },
    Worker: FixtureWorker, AudioContext: Context, AudioWorkletNode: Node,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
  });
  await import(`../../public/app.js?fixture=${crypto.randomUUID()}`);
  const stream = (sharedBuffer = new SharedArrayBuffer(256 + 16)) => {
    if (worker.messages.at(-1)?.type !== "connect") elements.get("#connect").click();
    worker.emit({ type: "socket-state", state: "open" });
    worker.emit({ type: "shared-buffer", sharedBuffer,
      stream: { sampleRate: 48000, channels: 2, framesPerBlock: 1 } });
    return sharedBuffer;
  };
  return { elements, contexts, nodes, workers, get worker() { return worker; }, stream,
    click: (selector) => elements.get(selector).click() };
}

export async function workerFixture(t, values = {}) {
  const messages = [], sockets = [];
  let receive;
  class Socket {
    handlers = new Map();
    constructor() { sockets.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    removeEventListener(type, handler) { if (this.handlers.get(type) === handler) this.handlers.delete(type); }
    close() { this.emit("close"); }
    emit(type, data) { this.handlers.get(type)?.({ data }); }
  }
  installGlobals(t, {
    self: { addEventListener(type, handler) { assert.equal(type, "message"); receive = handler; } },
    setTimeout: () => 0, clearTimeout() {},
    WebSocket: Socket, postMessage: (message) => messages.push(message), ...values,
  });
  await import(`../../public/audio-worker.js?fixture=${crypto.randomUUID()}`);
  let generation = 0;
  const send = (type, fields = {}) => {
    if (type === "connect") generation++;
    receive({ data: { type, url: "ws://synthetic.invalid/ws", generation, ...fields } });
  };
  send("connect");
  return { messages, sockets, send, socket: sockets[0] };
}

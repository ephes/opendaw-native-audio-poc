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
  const elements = new Map(), contexts = [], nodes = [];
  let worker;
  class FixtureWorker {
    messages = [];
    constructor() { worker = this; }
    addEventListener(type, handler) { this.receive = handler; }
    postMessage(message) { this.messages.push(message); }
    emit(message) { this.receive({ data: message }); }
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
    port = {
      addEventListener() {}, start() {},
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
    worker.emit({ type: "socket-state", state: "open" });
    worker.emit({ type: "shared-buffer", sharedBuffer,
      stream: { sampleRate: 48000, channels: 2, framesPerBlock: 1 } });
    return sharedBuffer;
  };
  return { elements, contexts, nodes, worker, stream,
    click: (selector) => elements.get(selector).click() };
}

export async function workerFixture(t, values = {}) {
  const messages = [], sockets = [];
  let receive;
  class Socket {
    handlers = new Map();
    constructor() { sockets.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    close() { this.emit("close"); }
    emit(type, data) { this.handlers.get(type)?.({ data }); }
  }
  installGlobals(t, {
    self: { addEventListener(type, handler) { assert.equal(type, "message"); receive = handler; } },
    WebSocket: Socket, postMessage: (message) => messages.push(message), ...values,
  });
  await import(`../../public/audio-worker.js?fixture=${crypto.randomUUID()}`);
  const send = (type, fields = {}) => receive({ data: { type, url: "ws://synthetic.invalid/ws", ...fields } });
  send("connect");
  return { messages, sockets, send, socket: sockets[0] };
}

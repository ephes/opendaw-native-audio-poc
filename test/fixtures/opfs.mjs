export function memoryStorage() {
  const files = new Map();
  const root = {
    files,
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new DOMException("Missing fixture file", "NotFoundError");
        files.set(name, new Uint8Array());
      }
      return {
        kind: "file",
        async getFile() { return new Blob([files.get(name)]); },
        async createWritable() {
          const parts = [];
          return {
            async write(data) { parts.push(data); },
            async close() {
              if (root.beforeClose) await root.beforeClose(name);
              files.set(name, new Uint8Array(await new Blob(parts).arrayBuffer()));
            },
          };
        },
      };
    },
    async removeEntry(name) { files.delete(name); },
    async *entries() {
      for (const name of files.keys()) yield [name, { kind: "file" }];
    },
  };
  return root;
}

export function barrier() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

export const stream = {
  sampleRate: 48000, channels: 2, framesPerBlock: 2, sampleFormat: "f32-interleaved",
};

export function record(recorder, frameStart = 0) {
  recorder.recordBlock({
    frameStart, frameCount: 2, channels: 2, receivedBlockIndex: frameStart / 2,
    dataBytes: new Uint8Array(new Float32Array([0.25, -0.5, 0.75, -1]).buffer),
  });
  return recorder.writeChain;
}

// Origin-shared exclusive lock fixture: rejected holders release the queue too.
export function memoryLocks() {
  const queues = new Map();
  return {
    request(name, callback) {
      const result = (queues.get(name) ?? Promise.resolve()).then(() => callback({ name, mode: "exclusive" }));
      queues.set(name, result.catch(() => {}));
      return result;
    },
  };
}

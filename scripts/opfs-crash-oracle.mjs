// Serialized into the isolated smoke page. All data is synthetic and all
// barriers wrap real OPFS APIs; production recorder code has no test hooks.
export async function runCheckpointCrashOracle(recorderUrl) {
  async function workerMain(url) {
    // Install the dispatcher before awaiting import, so the parent's first
    // message cannot be lost while the module graph loads.
    self.onmessage = async ({ data }) => {
      try {
        const { PcmRecorder } = await import(url);
        const recorder = new PcmRecorder({
          readCounters: () => ({ underruns: 0, overflows: 0, receivedBlocks: 2 }),
          postMessage() {},
        });
        const root = await navigator.storage.getDirectory();
        if (data.action === "record") {
          let armed = false;
          const pause = async () => {
            postMessage({ barrier: data.barrier, sessionId: recorder.session.sessionId });
            await new Promise(() => {}); // Parent terminates us here, without Stop.
          };
          recorder.openStorageRoot = async () => ({
            getFileHandle: async (name, options) => {
              const handle = await root.getFileHandle(name, options);
              return {
                getFile: () => handle.getFile(),
                createWritable: async () => {
                  const writable = await handle.createWritable({ mode: "exclusive" });
                  return {
                    write: (bytes) => writable.write(bytes),
                    abort: () => writable.abort(),
                    close: async () => {
                      if (armed && data.barrier === "before-manifest-close" && name.endsWith("-manifest.json")) await pause();
                      await writable.close();
                      if (armed && (
                        (data.barrier === "after-pcm-close" && name.endsWith(".f32")) ||
                        (data.barrier === "after-sidecar-close" && name.endsWith(".f32.json"))
                      )) await pause();
                    },
                  };
                },
              };
            },
            entries: () => root.entries(),
            removeEntry: (name) => root.removeEntry(name),
          });
          await recorder.start({ sampleRate: 48000, channels: 2, framesPerBlock: 2, sampleFormat: "f32-interleaved" });
          const record = async (frameStart, values) => {
            recorder.recordBlock({
              frameStart, frameCount: 2, channels: 2, receivedBlockIndex: frameStart / 2,
              dataBytes: new Uint8Array(new Float32Array(values).buffer),
            });
            await recorder.writeChain;
            if (recorder.state !== "recording") throw new Error(recorder.lastError);
          };
          // One fully trusted prefix, followed by a distinct closed PCM tail.
          await record(0, [0.25, -0.5, 0.75, -1]);
          await recorder.closeCurrentChunk();
          await record(2, [0.125, 2.5, -0.125, -3]);
          armed = true;
          await recorder.closeCurrentChunk();
          throw new Error("Checkpoint barrier was not reached");
        }
        if (data.action !== "recover") throw new Error("Unknown oracle action");
        const id = data.sessionId;
        const before = new Map();
        for await (const [name, handle] of root.entries()) {
          if (!name.startsWith(id)) continue;
          before.set(name, [...new Uint8Array(await (await handle.getFile()).arrayBuffer())]);
          // An exclusive open must succeed after the previous worker died;
          // abort the probe so retained bytes cannot be republished or changed.
          const probe = await handle.createWritable({ mode: "exclusive", keepExistingData: true });
          await probe.abort();
        }
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const scan = await recorder.scanRecoverySessions();
        const session = scan.sessions.find((entry) => entry.sessionId === id);
        check(scan.complete && session, "Fresh worker did not rediscover the interrupted session");
        check(session.state === "abandoned" && session.originalStoppedAt === null, "Crash was labelled as clean completion");
        const metadata = JSON.parse(await (await recorder.exportRecoveredManifest(id)).blob.text());
        const trusted = metadata.originalManifest.chunks;
        check(trusted.length === 1 && trusted[0].index === 0 && trusted[0].frames === 2 && trusted[0].blocks.length === 1 && trusted[0].blocks[0].frameStart === 0,
          "Recovery changed the trusted checkpoint prefix");
        check(metadata.originalManifest.chunkMetadata.count === 1, "Unclosed manifest published a new checkpoint");
        const listed = session.chunks.filter((chunk) => chunk.listedInManifest);
        check(listed.length === 1 && listed[0].index === 0, "Unpublished tail gained trusted evidence");
        check(session.warnings.some((warning) => warning.code === "missing-stopped-at") &&
          session.warnings.some((warning) => warning.code === "unmanifested-chunk"), "Crash/tail warnings were omitted");
        const wav = await recorder.exportRecoveredSelectedChannelWav(id, 0);
        const samples = [...new Float32Array(await wav.blob.arrayBuffer(), 44)];
        check(JSON.stringify(samples) === JSON.stringify([0.25, 0.75, 0.125, -0.125]), "Recovered synthetic PCM changed");
        check(session.recoveredFrames === 4, "Closed recoverable PCM tail was lost");
        const afterNames = [];
        for await (const [name, handle] of root.entries()) {
          if (!name.startsWith(id)) continue;
          afterNames.push(name);
          const bytes = [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
          check(JSON.stringify(bytes) === JSON.stringify(before.get(name)), `Recovery mutated ${name}`);
        }
        check(afterNames.length === before.size, "Recovery removed an owned artifact");
        const sidecars = afterNames.filter((name) => name.endsWith(".f32.json")).length;
        check(sidecars === (data.barrier === "after-pcm-close" ? 1 : 2), "Sidecar publication barrier was not exercised");
        // Negative control: corruption in the trusted prefix must trip the
        // actual recovery/export oracle. Restore bytes before explicit cleanup.
        const name = trusted[0].fileName;
        const handle = await root.getFileHandle(name);
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array([1]));
        await writer.close();
        let refused = false;
        try { await recorder.exportRecoveredSelectedChannelWav(id, 0); } catch { refused = true; }
        const restore = await handle.createWritable();
        await restore.write(new Uint8Array(before.get(name)));
        await restore.close();
        check(refused, "Negative control: truncated trusted PCM was accepted");
        const deleted = await recorder.deleteRecoveredSession(id);
        check(!deleted.sessions.some((entry) => entry.sessionId === id), "Explicit cleanup retained the test session");
        postMessage({ result: { barrier: data.barrier, state: session.state, trustedFrames: 2,
          recoveredFrames: session.recoveredFrames, samples, sidecars, writersReleased: true,
          retainedBytesUnchanged: true, corruptionRefused: true, deleted: true } });
      } catch (error) {
        postMessage({ error: error.stack || error.message });
      }
    };
  }
  const source = `(${workerMain.toString()})(${JSON.stringify(recorderUrl)}).catch(error => postMessage({ error: error.stack || error.message }));`;
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const request = (worker, data) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OPFS oracle timed out at ${data.barrier}`)), 8000);
    worker.onmessage = ({ data: reply }) => {
      clearTimeout(timer);
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply);
    };
    worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message)); };
    worker.postMessage(data);
  });
  const results = [];
  try {
    for (const barrier of ["after-pcm-close", "after-sidecar-close", "before-manifest-close"]) {
      const recordingWorker = new Worker(blobUrl, { type: "module" });
      let reached;
      try { reached = await request(recordingWorker, { action: "record", barrier }); }
      finally { recordingWorker.terminate(); }
      if (reached.barrier !== barrier || !reached.sessionId) throw new Error("Worker stopped at the wrong checkpoint");
      const recoveryWorker = new Worker(blobUrl, { type: "module" });
      try {
        const reply = await request(recoveryWorker, { action: "recover", barrier, sessionId: reached.sessionId });
        results.push(reply.result);
      } finally { recoveryWorker.terminate(); }
    }
  } finally { URL.revokeObjectURL(blobUrl); }
  return results;
}

const STATE = {
  WRITE_FRAME: 0,
  READ_FRAME: 1,
  OVERFLOW_COUNT: 2,
  UNDERRUN_COUNT: 3,
  CHANNELS: 4,
  CAPACITY_FRAMES: 5,
  CONNECTED: 6,
  SAMPLE_RATE: 7,
  FRAMES_PER_BLOCK: 8,
  RECEIVED_BLOCKS: 9,
};

const els = {
  connect: document.querySelector("#connect"),
  monitor: document.querySelector("#monitor"),
  streamSummary: document.querySelector("#stream-summary"),
  socketState: document.querySelector("#socket-state"),
  bufferFill: document.querySelector("#buffer-fill"),
  underruns: document.querySelector("#underruns"),
  overflows: document.querySelector("#overflows"),
  meters: document.querySelector("#meters"),
  leftChannel: document.querySelector("#left-channel"),
  rightChannel: document.querySelector("#right-channel"),
};

let worker = null;
let audioContext = null;
let workletNode = null;
let sharedBuffer = null;
let stateView = null;
let streamInfo = null;
let meterBars = [];

els.connect.addEventListener("click", () => {
  if (worker) {
    disconnect();
  } else {
    connect();
  }
});

els.monitor.addEventListener("click", async () => {
  await startMonitor();
});

els.leftChannel.addEventListener("change", updateMonitorChannels);
els.rightChannel.addEventListener("change", updateMonitorChannels);

if (!window.crossOriginIsolated) {
  els.streamSummary.textContent = "Cross-origin isolation is missing; SharedArrayBuffer is unavailable.";
  els.connect.disabled = true;
}

function connect() {
  worker = new Worker("/audio-worker.js", { type: "module" });
  worker.addEventListener("message", handleWorkerMessage);
  worker.postMessage({ type: "connect", url: websocketUrl() });
  els.connect.textContent = "Disconnect";
  setSocketState("connecting");
}

function disconnect() {
  worker?.postMessage({ type: "disconnect" });
  worker?.terminate();
  worker = null;
  workletNode?.disconnect();
  workletNode = null;
  const closingContext = audioContext;
  audioContext = null;
  if (closingContext && closingContext.state !== "closed") {
    closingContext.close().catch(() => {});
  }
  sharedBuffer = null;
  stateView = null;
  streamInfo = null;
  meterBars = [];
  els.meters.replaceChildren();
  els.leftChannel.replaceChildren();
  els.rightChannel.replaceChildren();
  els.monitor.disabled = true;
  els.monitor.textContent = "Start Monitor";
  els.connect.textContent = "Connect";
  els.streamSummary.textContent = "Disconnected";
  setSocketState("closed");
  renderCounters();
}

async function startMonitor() {
  if (!sharedBuffer) {
    return;
  }
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: streamInfo?.sampleRate });
    await audioContext.audioWorklet.addModule("/bridge-processor.js");
  }
  if (!workletNode) {
    workletNode = new AudioWorkletNode(audioContext, "native-bridge-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    workletNode.port.addEventListener("message", handleWorkletMessage);
    workletNode.port.start();
    workletNode.connect(audioContext.destination);
    workletNode.port.postMessage({
      type: "configure",
      sharedBuffer,
      left: Number(els.leftChannel.value),
      right: Number(els.rightChannel.value),
    });
  }
  await audioContext.resume();
  els.monitor.textContent = "Monitoring";
}

function updateMonitorChannels() {
  workletNode?.port.postMessage({
    type: "channels",
    left: Number(els.leftChannel.value),
    right: Number(els.rightChannel.value),
  });
}

function handleWorkerMessage(event) {
  const message = event.data;
  if (message.type === "socket-state") {
    setSocketState(message.state);
  } else if (message.type === "shared-buffer") {
    sharedBuffer = message.sharedBuffer;
    streamInfo = message.stream;
    stateView = new Int32Array(sharedBuffer, 0, 64);
    setupStreamUi(streamInfo);
    els.monitor.disabled = false;
    if (workletNode) {
      workletNode.port.postMessage({ type: "configure", sharedBuffer });
    }
  } else if (message.type === "meters") {
    renderMeters(message.peak);
    renderCounters();
  } else if (message.type === "error") {
    els.streamSummary.textContent = message.message;
  }
}

function handleWorkletMessage(event) {
  if (event.data.type === "status") {
    renderCounters();
  }
}

function setupStreamUi(info) {
  els.streamSummary.textContent =
    `${info.channels} channels, ${info.sampleRate} Hz, ${info.framesPerBlock} frames/block`;
  els.leftChannel.replaceChildren();
  els.rightChannel.replaceChildren();
  for (let index = 0; index < info.channels; index += 1) {
    const leftOption = new Option(`Channel ${index + 1}`, String(index));
    const rightOption = new Option(`Channel ${index + 1}`, String(index));
    els.leftChannel.append(leftOption);
    els.rightChannel.append(rightOption);
  }
  els.rightChannel.value = String(Math.min(1, info.channels - 1));
  els.meters.replaceChildren();
  meterBars = Array.from({ length: info.channels }, (_, index) => {
    const row = document.createElement("div");
    row.className = "meter";
    row.innerHTML = `
      <span class="meter-label">Ch ${index + 1}</span>
      <span class="meter-track"><span class="meter-fill"></span></span>
      <span class="meter-db">-inf</span>
    `;
    els.meters.append(row);
    return {
      fill: row.querySelector(".meter-fill"),
      db: row.querySelector(".meter-db"),
    };
  });
}

function renderMeters(peaks) {
  peaks.forEach((peak, index) => {
    const meter = meterBars[index];
    if (!meter) {
      return;
    }
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    meter.fill.style.width = `${pct}%`;
    meter.db.textContent = Number.isFinite(db) ? `${db.toFixed(1)}` : "-inf";
  });
}

function renderCounters() {
  if (!stateView) {
    els.bufferFill.textContent = "0 frames";
    els.underruns.textContent = "0";
    els.overflows.textContent = "0";
    return;
  }
  const write = Atomics.load(stateView, STATE.WRITE_FRAME);
  const read = Atomics.load(stateView, STATE.READ_FRAME);
  const fill = Math.max(0, write - read);
  els.bufferFill.textContent = `${fill} frames`;
  els.underruns.textContent = String(Atomics.load(stateView, STATE.UNDERRUN_COUNT));
  els.overflows.textContent = String(Atomics.load(stateView, STATE.OVERFLOW_COUNT));
}

function setSocketState(state) {
  els.socketState.textContent = state;
}

function websocketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws`;
}

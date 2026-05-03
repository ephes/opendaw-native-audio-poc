import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HOST = "127.0.0.1";
const config = readConfig();

async function main() {
  const resources = { chrome: null, server: null };
  let cleanupPromise = null;
  const cleanup = async () => {
    cleanupPromise ??= cleanupResources(resources);
    await cleanupPromise;
  };
  const handleSignal = (signal) => {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    process.exitCode = exitCode;
    cleanup().finally(() => process.exit(exitCode));
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    const chromePath = findChromePath();
    const serverPort = process.env.SMOKE_PORT
      ? Number.parseInt(process.env.SMOKE_PORT, 10)
      : await findFreePort();
    const chromeDebugPort = process.env.SMOKE_CHROME_DEBUG_PORT
      ? Number.parseInt(process.env.SMOKE_CHROME_DEBUG_PORT, 10)
      : await findFreePort();

    if (!globalThis.WebSocket) {
      throw new Error("Node.js global WebSocket is required for the browser smoke test");
    }

    resources.server = startServer(config, serverPort);
    resources.chrome = startChrome(chromePath, chromeDebugPort);

    console.error(
      `${config.label}: source=${config.source} device=${config.device ?? "<default>"} channels=${config.channels} sampleRate=${config.sampleRate} framesPerBlock=${config.framesPerBlock} monitorMs=${config.monitorMs}`,
    );

    await waitForHttp(`http://${HOST}:${serverPort}/`, resources.server);
    const result = await runBrowserSmoke(config, serverPort, chromeDebugPort, resources.chrome.output);
    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof SmokeStartupError ? error.message : error.stack || error.message);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await cleanup();
  }
}

function readConfig() {
  const source = readEnum("SMOKE_SOURCE", "sine", ["sine", "input"]);
  const channels = readPositiveInt("SMOKE_CHANNELS", 12);
  const sampleRate = readPositiveInt("SMOKE_SAMPLE_RATE", 48_000);
  const framesPerBlock = readPositiveInt("SMOKE_FRAMES_PER_BLOCK", 960);
  const monitorMs = readPositiveInt("SMOKE_MONITOR_MS", 30_000);
  const serverTimeoutMs = readPositiveInt("SMOKE_SERVER_TIMEOUT_MS", 60_000);
  const expectedActiveMeters = readPositiveInt("SMOKE_EXPECT_ACTIVE_METERS", channels);
  const device = process.env.SMOKE_DEVICE || null;
  const expectNativeDropsZero = readBool("SMOKE_EXPECT_NATIVE_DROPS_ZERO", true);
  const label = process.env.SMOKE_LABEL || `${source} browser smoke`;

  return {
    source,
    device,
    channels,
    sampleRate,
    framesPerBlock,
    monitorMs,
    serverTimeoutMs,
    expectedActiveMeters,
    expectNativeDropsZero,
    label,
  };
}

function readEnum(name, fallback, allowed) {
  const value = process.env[name] ?? fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function readPositiveInt(name, fallback) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (["1", "true", "yes"].includes(raw.toLowerCase())) {
    return true;
  }
  if (["0", "false", "no"].includes(raw.toLowerCase())) {
    return false;
  }
  throw new Error(`${name} must be true/false or 1/0, got ${JSON.stringify(raw)}`);
}

async function cleanupResources({ chrome, server }) {
  await chrome?.stop();
  await server?.stop();
}

function findChromePath() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Chrome was not found. Set CHROME_PATH to a Chromium-based browser binary.");
  }
  return found;
}

function startServer(config, port) {
  const output = [];
  const args = [
    "run",
    "--",
    "serve",
    "--source",
    config.source,
    "--channels",
    String(config.channels),
    "--sample-rate",
    String(config.sampleRate),
    "--port",
    String(port),
    "--frames-per-block",
    String(config.framesPerBlock),
  ];
  if (config.source === "input" && config.device) {
    args.splice(5, 0, "--device", config.device);
  }
  const child = spawn(
    "cargo",
    args,
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let exitInfo = null;

  child.stdout.on("data", (chunk) => appendOutput(output, chunk));
  child.stderr.on("data", (chunk) => appendOutput(output, chunk));
  child.on("error", (error) => appendOutput(output, `server spawn failed: ${error.message}\n`));
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
  });

  return {
    command: `cargo ${args.join(" ")}`,
    config,
    output,
    getExitInfo() {
      return exitInfo;
    },
    async stop() {
      await stopProcessGroup(child);
    },
  };
}

function startChrome(chromePath, debugPort) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opendaw-smoke-chrome-"));
  const output = [];
  const child = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.on("data", (chunk) => appendOutput(output, chunk));
  child.on("error", (error) => appendOutput(output, `Chrome spawn failed: ${error.message}\n`));

  return {
    output,
    async stop() {
      await stopProcess(child);
      fs.rmSync(userDataDir, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
    },
  };
}

async function runBrowserSmoke(config, port, debugPort, chromeOutput) {
  const target = await waitForPageTarget(debugPort, chromeOutput);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await onceSocketOpen(socket);

  const cdp = new CdpClient(socket);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");

  const pageUrl = `http://${HOST}:${port}/`;
  await cdp.send("Page.navigate", { url: pageUrl });
  await waitFor(
    cdp,
    `document.location.href === ${JSON.stringify(pageUrl)} && document.readyState === "complete"`,
  );

  const isolation = await evalExpr(cdp, `({
    crossOriginIsolated,
    hasSharedArrayBuffer: typeof SharedArrayBuffer === "function",
    title: document.title,
    initialSocket: document.querySelector("#socket-state")?.textContent,
    monitorDisabled: document.querySelector("#monitor")?.disabled,
  })`);

  await evalExpr(cdp, `document.querySelector("#connect").click(); undefined`);
  await waitFor(cdp, `document.querySelector("#socket-state")?.textContent === "open"`);
  await waitFor(cdp, `!document.querySelector("#monitor")?.disabled`);
  await waitFor(cdp, `document.querySelector("#meters")?.children.length === ${config.channels}`);

  const beforeMonitor = await evalExpr(cdp, `({
    summary: document.querySelector("#stream-summary")?.textContent,
    socket: document.querySelector("#socket-state")?.textContent,
    meterCount: document.querySelector("#meters")?.children.length,
    bufferFill: document.querySelector("#buffer-fill")?.textContent,
    underruns: document.querySelector("#underruns")?.textContent,
    overflows: document.querySelector("#overflows")?.textContent,
    nativeDrops: document.querySelector("#native-dropped-blocks")?.textContent,
  })`);

  await evalExpr(cdp, `document.querySelector("#monitor").click(); undefined`);
  await waitFor(cdp, `document.querySelector("#monitor")?.textContent === "Monitoring"`);
  await sleep(config.monitorMs);

  const afterMonitor = await evalExpr(cdp, `(() => {
    const fills = [...document.querySelectorAll(".meter-fill")]
      .map((element) => Number.parseFloat(element.style.width || "0"));
    const dbs = [...document.querySelectorAll(".meter-db")]
      .map((element) => element.textContent);
    const active = fills.map(
      (value, index) => value > 0 || (typeof dbs[index] === "string" && dbs[index] !== "-inf"),
    );
    return {
      monitorText: document.querySelector("#monitor")?.textContent,
      socket: document.querySelector("#socket-state")?.textContent,
      summary: document.querySelector("#stream-summary")?.textContent,
      meterCount: document.querySelector("#meters")?.children.length,
      // db text catches real input below the -60 dB meter-fill floor.
      activeMeters: active.filter(Boolean).length,
      inactiveMeters: active
        .map((isActive, index) => isActive ? null : index + 1)
        .filter((channel) => channel !== null),
      firstMeterWidth: fills[0] ?? null,
      firstMeterDb: dbs[0] ?? null,
      meterWidths: fills,
      meterDbs: dbs,
      bufferFill: document.querySelector("#buffer-fill")?.textContent,
      underruns: document.querySelector("#underruns")?.textContent,
      overflows: document.querySelector("#overflows")?.textContent,
      nativeDroppedBlocks: document.querySelector("#native-dropped-blocks")?.textContent,
      nativeDroppedFrames: document.querySelector("#native-dropped-frames")?.textContent,
      nativeDropEvents: document.querySelector("#native-drop-events")?.textContent,
    };
  })()`);

  const pageEvents = cdp.events
    .filter((event) => ["Runtime.exceptionThrown", "Log.entryAdded"].includes(event.method))
    .map((event) => event.params);
  const runtimeExceptions = pageEvents.filter((event) => event.exceptionDetails);
  const failures = collectFailures({
    config,
    isolation,
    beforeMonitor,
    afterMonitor,
    runtimeExceptions,
  });

  socket.close();
  return { config, isolation, beforeMonitor, afterMonitor, pageEvents, failures };
}

function collectFailures({ config, isolation, beforeMonitor, afterMonitor, runtimeExceptions }) {
  const failures = [];
  if (!isolation.crossOriginIsolated) {
    failures.push("page is not crossOriginIsolated");
  }
  if (!isolation.hasSharedArrayBuffer) {
    failures.push("SharedArrayBuffer is unavailable");
  }
  if (beforeMonitor.socket !== "open") {
    failures.push("socket did not open");
  }
  const expectedSummary =
    `${config.channels} channels, ${config.sampleRate} Hz, ${config.framesPerBlock} frames/block`;
  if (beforeMonitor.summary !== expectedSummary) {
    failures.push(`expected stream summary ${JSON.stringify(expectedSummary)}, saw ${JSON.stringify(beforeMonitor.summary)}`);
  }
  if (beforeMonitor.meterCount !== config.channels) {
    failures.push(`expected ${config.channels} meters, saw ${beforeMonitor.meterCount}`);
  }
  if (afterMonitor.monitorText !== "Monitoring") {
    failures.push("monitor did not enter Monitoring state");
  }
  if (afterMonitor.activeMeters !== config.expectedActiveMeters) {
    const inactive = afterMonitor.inactiveMeters?.length
      ? `; inactive channels: ${afterMonitor.inactiveMeters.join(", ")}`
      : "";
    failures.push(
      `expected ${config.expectedActiveMeters} active meters, saw ${afterMonitor.activeMeters}${inactive}`,
    );
  }
  if (afterMonitor.underruns !== "0") {
    failures.push(`expected 0 underruns after monitor start, saw ${afterMonitor.underruns}`);
  }
  if (afterMonitor.overflows !== "0") {
    failures.push(`expected 0 overflows after monitor start, saw ${afterMonitor.overflows}`);
  }
  if (
    config.expectNativeDropsZero &&
    (afterMonitor.nativeDroppedBlocks !== "0" ||
      afterMonitor.nativeDroppedFrames !== "0" ||
      afterMonitor.nativeDropEvents !== "0")
  ) {
    failures.push(
      `expected zero native drops, saw ${afterMonitor.nativeDroppedBlocks}/${afterMonitor.nativeDroppedFrames}/${afterMonitor.nativeDropEvents}`,
    );
  }
  if (runtimeExceptions.length > 0) {
    failures.push(`expected no runtime exceptions, saw ${runtimeExceptions.length}`);
  }
  return failures;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener("message", (event) => this.handleMessage(event));
  }

  handleMessage(event) {
    const message = JSON.parse(event.data);
    if (message.id && this.pending.has(message.id)) {
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      } else {
        resolve(message.result);
      }
      return;
    }
    this.events.push(message);
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout for ${method}`));
        }
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}

async function evalExpr(cdp, expression, awaitPromise = true) {
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise,
    expression,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`Evaluation failed: ${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evalExpr(cdp, expression);
    if (lastValue) {
      return lastValue;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${expression}; last=${JSON.stringify(lastValue)}`);
}

async function waitForPageTarget(debugPort, chromeOutput) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://${HOST}:${debugPort}/json/list`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) {
        return page;
      }
    } catch (_error) {
      // Chrome may still be starting.
    }
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for Chrome page target\nChrome output:\n${chromeOutput.join("")}`,
  );
}

async function waitForHttp(url, server) {
  const deadline = Date.now() + server.config.serverTimeoutMs;
  while (Date.now() < deadline) {
    const exitInfo = server.getExitInfo();
    if (exitInfo) {
      throw serverStartupError(server, {
        reason: `server exited with code ${exitInfo.code} signal ${exitInfo.signal}`,
        mode: "exited",
      });
    }
    if (await fetchOk(url, 1_000)) {
      return;
    }
    await sleep(100);
  }
  const exitInfo = server.getExitInfo();
  if (exitInfo) {
    throw serverStartupError(server, {
      reason: `server exited with code ${exitInfo.code} signal ${exitInfo.signal}`,
      mode: "exited",
    });
  }
  throw serverStartupError(server, {
    reason: `timed out after ${server.config.serverTimeoutMs} ms waiting for ${url}`,
    mode: "timeout",
  });
}

function serverStartupError(server, { reason, mode }) {
  const hardwareNote =
    mode === "exited" && server.config.source === "input"
      ? "\nThis hardware-dependent smoke did not run. Check that the input device is connected and that the requested device substring, channel count, sample rate, and frames/block are supported."
      : "";
  const timeoutNote =
    mode === "timeout"
      ? "\nThe Rust server did not become ready before the smoke timeout. A first run after a clean checkout or dependency change may still be compiling; try `cargo build` first or increase SMOKE_SERVER_TIMEOUT_MS."
      : "";
  return new SmokeStartupError(
    `${server.config.label}: ${reason}\nCommand: ${server.command}${hardwareNote}${timeoutNote}\nServer output:\n${server.output.join("")}`,
  );
}

async function fetchOk(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch (_error) {
    // The Rust server may still be compiling, binding, or hidden by another process on the port.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

class SmokeStartupError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeStartupError";
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.json();
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function onceSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

async function stopProcessGroup(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (_error) {
    return;
  }
  await waitForExit(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (_error) {
      // Process already exited.
    }
  }
}

async function stopProcess(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await waitForExit(child, 2_000);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function appendOutput(output, chunk) {
  output.push(chunk.toString());
  if (output.length > 80) {
    output.splice(0, output.length - 80);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();

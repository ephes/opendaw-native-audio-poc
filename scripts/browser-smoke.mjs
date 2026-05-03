import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const HOST = "127.0.0.1";
const CHANNELS = 12;
const SAMPLE_RATE = 48_000;
const FRAMES_PER_BLOCK = 960;
const MONITOR_MS = Number.parseInt(process.env.SMOKE_MONITOR_MS ?? "30000", 10);

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

    resources.server = startServer(serverPort);
    resources.chrome = startChrome(chromePath, chromeDebugPort);

    await waitForHttp(`http://${HOST}:${serverPort}/`, resources.server.output);
    const result = await runBrowserSmoke(serverPort, chromeDebugPort, resources.chrome.output);
    console.log(JSON.stringify(result, null, 2));
    if (result.failures.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    await cleanup();
  }
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

function startServer(port) {
  const output = [];
  const child = spawn(
    "cargo",
    [
      "run",
      "--",
      "serve",
      "--source",
      "sine",
      "--channels",
      String(CHANNELS),
      "--sample-rate",
      String(SAMPLE_RATE),
      "--port",
      String(port),
      "--frames-per-block",
      String(FRAMES_PER_BLOCK),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => appendOutput(output, chunk));
  child.stderr.on("data", (chunk) => appendOutput(output, chunk));
  child.on("error", (error) => appendOutput(output, `server spawn failed: ${error.message}\n`));

  return {
    output,
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

async function runBrowserSmoke(port, debugPort, chromeOutput) {
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
  await waitFor(cdp, `document.querySelector("#meters")?.children.length === ${CHANNELS}`);

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
  await sleep(MONITOR_MS);

  const afterMonitor = await evalExpr(cdp, `(() => {
    const fills = [...document.querySelectorAll(".meter-fill")]
      .map((element) => Number.parseFloat(element.style.width || "0"));
    const dbs = [...document.querySelectorAll(".meter-db")]
      .map((element) => element.textContent);
    return {
      monitorText: document.querySelector("#monitor")?.textContent,
      socket: document.querySelector("#socket-state")?.textContent,
      summary: document.querySelector("#stream-summary")?.textContent,
      meterCount: document.querySelector("#meters")?.children.length,
      activeMeters: fills.filter((value) => value > 0).length,
      firstMeterWidth: fills[0] ?? null,
      firstMeterDb: dbs[0] ?? null,
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
  const failures = collectFailures({ isolation, beforeMonitor, afterMonitor, runtimeExceptions });

  socket.close();
  return { isolation, beforeMonitor, afterMonitor, pageEvents, failures };
}

function collectFailures({ isolation, beforeMonitor, afterMonitor, runtimeExceptions }) {
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
  if (beforeMonitor.meterCount !== CHANNELS) {
    failures.push(`expected ${CHANNELS} meters, saw ${beforeMonitor.meterCount}`);
  }
  if (afterMonitor.monitorText !== "Monitoring") {
    failures.push("monitor did not enter Monitoring state");
  }
  if (afterMonitor.activeMeters !== CHANNELS) {
    failures.push(`expected ${CHANNELS} active meters, saw ${afterMonitor.activeMeters}`);
  }
  if (afterMonitor.underruns !== "0") {
    failures.push(`expected 0 underruns after monitor start, saw ${afterMonitor.underruns}`);
  }
  if (afterMonitor.overflows !== "0") {
    failures.push(`expected 0 overflows after monitor start, saw ${afterMonitor.overflows}`);
  }
  if (
    afterMonitor.nativeDroppedBlocks !== "0" ||
    afterMonitor.nativeDroppedFrames !== "0" ||
    afterMonitor.nativeDropEvents !== "0"
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

async function waitForHttp(url, serverOutput) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (_error) {
      // The Rust server may still be compiling or binding.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}\nServer output:\n${serverOutput.join("")}`);
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

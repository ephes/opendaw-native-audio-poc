import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  session: "opendaw-l12",
  port: 4545,
  framesPerBlock: 960,
  device: "ZOOM",
  channels: 14,
  sampleRate: 48_000,
  smokeMs: 1_000,
  runRoot: ".runs/l12-recording",
};

const HOST = "127.0.0.1";

export function parseCliArgs(argv) {
  const options = { ...DEFAULTS, replace: false, open: false, attach: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, options };
    }
    if (arg === "--replace") {
      options.replace = true;
      continue;
    }
    if (arg === "--open") {
      options.open = true;
      continue;
    }
    if (arg === "--attach") {
      options.attach = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument ${JSON.stringify(arg)}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    if (arg === "--session") {
      options.session = parseSessionName(arg, value);
    } else if (arg === "--port") {
      options.port = parsePositiveIntOption(arg, value);
    } else if (arg === "--frames-per-block") {
      options.framesPerBlock = parsePositiveIntOption(arg, value);
    } else if (arg === "--device") {
      options.device = value;
    } else if (arg === "--channels") {
      options.channels = parsePositiveIntOption(arg, value);
    } else if (arg === "--sample-rate") {
      options.sampleRate = parsePositiveIntOption(arg, value);
    } else if (arg === "--smoke-ms") {
      options.smokeMs = parseNonNegativeIntOption(arg, value);
    } else if (arg === "--run-root") {
      options.runRoot = value;
    } else {
      throw new Error(`Unknown option ${arg}`);
    }
  }
  options.session = parseSessionName("--session", options.session);
  if (options.runRoot.trim() === "") {
    throw new Error("--run-root must not be empty");
  }
  return { help: false, options };
}

export function buildRunPlan(options, cwd = process.cwd(), now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const runDir = path.resolve(cwd, options.runRoot, timestamp);
  const browserUrl = `http://${HOST}:${options.port}/`;
  const serverArgs = [
    "run",
    "--",
    "serve",
    "--source",
    "input",
    "--device",
    options.device,
    "--channels",
    String(options.channels),
    "--sample-rate",
    String(options.sampleRate),
    "--port",
    String(options.port),
    "--frames-per-block",
    String(options.framesPerBlock),
  ];
  const smokeArgs = [
    "smoke-l12",
    String(options.smokeMs),
    "",
    String(options.framesPerBlock),
    options.device,
    String(options.channels),
    String(options.sampleRate),
  ];
  const inspectCommand = [
    "just",
    "inspect-recording",
    "MANIFEST_PATH",
    String(options.channels),
    String(options.sampleRate),
    String(options.framesPerBlock),
  ];

  return {
    cwd,
    timestamp,
    runDir,
    runReadmePath: path.join(runDir, "run.md"),
    serverLogPath: path.join(runDir, "server.log"),
    smokeLogPath: path.join(runDir, "preflight.log"),
    notesLogPath: path.join(runDir, "notes.log"),
    preflightDonePath: path.join(runDir, "preflight.done"),
    preflightFailedPath: path.join(runDir, "preflight.failed"),
    browserUrl,
    serverArgs,
    serverCommand: commandToString("cargo", serverArgs),
    smokeArgs,
    smokeCommand: commandToString("just", smokeArgs),
    inspectCommand: commandToString("just", inspectCommand.slice(1)),
  };
}

export function renderRunReadme(options, plan) {
  const preflight = options.smokeMs > 0
    ? plan.smokeCommand
    : "Disabled with --smoke-ms 0.";
  return `# L-12 Recording Session

- Created: ${plan.timestamp}
- tmux session: ${options.session}
- Run directory: ${plan.runDir}
- Browser URL: ${plan.browserUrl}
- Server log: ${plan.serverLogPath}
- Preflight log: ${plan.smokeLogPath}

## Server Command

\`\`\`sh
${plan.serverCommand}
\`\`\`

## Optional Preflight

\`\`\`sh
${preflight}
\`\`\`

The preflight is a short hardware/browser monitor smoke. It does not record audio and it does not replace the manual browser recording workflow.
When enabled, the tmux server window waits for the preflight to pass before starting the long-running L-12 server, so the L-12 device is not opened by both commands at once.

## Manual Browser Recording

1. Open ${plan.browserUrl}.
2. Click Connect.
3. Optionally click Start Monitor and choose a stereo monitor pair.
4. Click Start Recording.
5. Let the L-12 stream run for the target duration.
6. Click Stop Recording.
7. Click Export Manifest.
8. Keep the inspector PASS/FAIL output with this run note.

Recording chunks and manifests remain in browser OPFS until exported or deleted through the page. This tmux workflow does not read OPFS, automate browser recording controls, export manifests, import into a DAW, or require raw .f32 chunk files.

## Post-Export Manifest Inspection

\`\`\`sh
${plan.inspectCommand}
\`\`\`

Paste the inspector report here:

\`\`\`text

\`\`\`

## Notes From docs/l12-recording-test.md

- Browser and version:
- macOS version:
- Device name from cargo run -- list:
- Browser storage persistence granted: yes/no
- Monitor enabled: yes/no
- Monitor pair:
- Target duration:
- Actual duration:
- Channels reported:
- Recorded frames:
- Gaps / overlaps / discontinuities:
- Underruns / overflows during recording:
- WebSocket lag events:
- Native dropped callback buffers / frames / events:
- Exported manifest filename:
- Exported WAV channel(s):
- DAW/import result:
- Issues found:
- Next action:
`;
}

async function main() {
  let runDirForError = null;
  try {
    const { help, options } = parseCliArgs(process.argv.slice(2));
    if (help) {
      console.log(usage());
      return;
    }
    const cwd = process.cwd();
    const plan = buildRunPlan(options, cwd);
    await fs.mkdir(plan.runDir, { recursive: true });
    await fs.writeFile(plan.runReadmePath, renderRunReadme(options, plan));
    if (!options.dryRun) {
      runDirForError = plan.runDir;
    }

    if (options.dryRun) {
      printSummary(options, plan, { dryRun: true });
      return;
    }

    assertTmuxAvailable();
    const exists = tmuxSessionExists(options.session);
    if (exists && !options.replace) {
      throw new Error(
        `tmux session ${JSON.stringify(options.session)} already exists. Attach with "tmux attach -t ${options.session}", kill it with "tmux kill-session -t ${options.session}", or rerun with --replace.`,
      );
    }
    if (exists && options.replace) {
      runTmux(["kill-session", "-t", options.session]);
    }

    createTmuxSession(options, plan);
    if (options.open) {
      openBrowser(plan.browserUrl);
    }
    printSummary(options, plan, { dryRun: false });
    if (options.attach) {
      runTmux(["attach", "-t", options.session], { stdio: "inherit" });
    }
  } catch (error) {
    const runDirNote = runDirForError
      ? `\nRun directory was created at ${runDirForError}; you may delete it if setup failed before session startup.`
      : "";
    console.error(`${error.message}${runDirNote}`);
    process.exitCode = 1;
  }
}

function createTmuxSession(options, plan) {
  runTmux(["new-session", "-d", "-s", options.session, "-n", "server", "-c", plan.cwd]);
  pipePane(options.session, "server", plan.serverLogPath);
  const serverCommand = options.smokeMs > 0
    ? [
        `echo ${shellQuote("Waiting for preflight smoke to pass before starting the L-12 server.")}`,
        `while [ ! -f ${shellQuote(plan.preflightDonePath)} ]; do if [ -f ${shellQuote(plan.preflightFailedPath)} ]; then echo ${shellQuote(`Preflight failed; server not started. See ${plan.smokeLogPath}`)}; exec "$SHELL" -l; fi; sleep 1; done`,
        plan.serverCommand,
      ].join("; ")
    : plan.serverCommand;
  sendKeys(
    options.session,
    "server",
    shellScript([
      "clear",
      `echo ${shellQuote(`L-12 server log: ${plan.serverLogPath}`)}`,
      serverCommand,
    ]),
  );

  runTmux(["new-window", "-t", options.session, "-n", "preflight", "-c", plan.cwd]);
  pipePane(options.session, "preflight", plan.smokeLogPath);
  const preflightCommand = options.smokeMs > 0
    ? `${plan.smokeCommand}; status=$?; if [ "$status" -eq 0 ]; then touch ${shellQuote(plan.preflightDonePath)}; else touch ${shellQuote(plan.preflightFailedPath)}; fi; echo; echo "Preflight exited with status $status"; exec "$SHELL" -l`
    : `echo "Preflight disabled with --smoke-ms 0"; exec "$SHELL" -l`;
  sendKeys(
    options.session,
    "preflight",
    shellScript([
      "clear",
      `echo ${shellQuote(`Preflight log: ${plan.smokeLogPath}`)}`,
      preflightCommand,
    ]),
  );

  runTmux(["new-window", "-t", options.session, "-n", "notes", "-c", plan.cwd]);
  pipePane(options.session, "notes", plan.notesLogPath);
  sendKeys(
    options.session,
    "notes",
    shellScript([
      "clear",
      `cat ${shellQuote(plan.runReadmePath)}`,
      "echo",
      `echo ${shellQuote(`Run "cat ${plan.runReadmePath}" to redisplay these notes.`)}`,
      'exec "$SHELL" -l',
    ]),
  );
  runTmux(["select-window", "-t", `${options.session}:notes`]);
}

function assertTmuxAvailable() {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new Error("tmux is required for this opt-in L-12 recording session workflow, but it was not found on PATH.");
  }
  if (result.status !== 0) {
    throw new Error(`tmux check failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

function tmuxSessionExists(session) {
  const result = spawnSync("tmux", ["has-session", "-t", session], { encoding: "utf8" });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(`tmux session check failed: ${(result.stderr || result.stdout || "").trim()}`);
}

function pipePane(session, windowName, logPath) {
  runTmux(["pipe-pane", "-o", "-t", `${session}:${windowName}`, `cat >> ${shellQuote(logPath)}`]);
}

function sendKeys(session, windowName, command) {
  runTmux(["send-keys", "-t", `${session}:${windowName}`, command, "C-m"]);
}

function runTmux(args, options = {}) {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function openBrowser(url) {
  const result = spawnSync("open", [url], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    throw new Error("--open is only supported when the macOS open command is available");
  }
  if (result.status !== 0) {
    throw new Error(`open ${url} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

function printSummary(options, plan, { dryRun }) {
  const prefix = dryRun ? "Dry run: " : "";
  console.log(`${prefix}L-12 recording session ${dryRun ? "planned" : "created"}`);
  console.log(`tmux attach: tmux attach -t ${options.session}`);
  console.log(`browser URL: ${plan.browserUrl}`);
  console.log(`run directory: ${plan.runDir}`);
  console.log(`run notes: ${plan.runReadmePath}`);
  console.log(`server log: ${plan.serverLogPath}`);
  console.log(`preflight log: ${plan.smokeLogPath}`);
  console.log(`server command: ${plan.serverCommand}`);
  if (options.smokeMs > 0) {
    console.log(`preflight command: ${plan.smokeCommand}`);
  } else {
    console.log("preflight command: disabled");
  }
  console.log(`post-export inspect: ${plan.inspectCommand}`);
  if (!options.open) {
    console.log("browser opening: not requested; open the browser URL manually or rerun with --open");
  }
}

function commandToString(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellScript(commands) {
  return `sh -lc ${shellQuote(commands.join("; "))}`;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function parseSessionName(name, raw) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(raw)) {
    throw new Error(`${name} must contain only letters, numbers, underscore, dot, colon, or hyphen`);
  }
  return raw;
}

function parsePositiveIntOption(name, raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== raw) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function parseNonNegativeIntOption(name, raw) {
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== raw) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function usage() {
  return `Usage: node scripts/l12-recording-session.mjs [options]

Creates an opt-in tmux run harness for a manual ZOOM LiveTrak L-12 browser recording validation.

Options:
  --session <name>             tmux session name (default: ${DEFAULTS.session})
  --port <n>                   server/browser port (default: ${DEFAULTS.port})
  --frames-per-block <n>       PCM frames per WebSocket block (default: ${DEFAULTS.framesPerBlock})
  --device <substring>         CoreAudio input device substring (default: ${DEFAULTS.device})
  --channels <n>               expected input channels (default: ${DEFAULTS.channels})
  --sample-rate <n>            input sample rate (default: ${DEFAULTS.sampleRate})
  --smoke-ms <n>               run just smoke-l12 for n ms; use 0 to disable (default: ${DEFAULTS.smokeMs})
  --run-root <path>            local run artifact root (default: ${DEFAULTS.runRoot})
  --replace                    kill and recreate an existing tmux session with the same name
  --open                       open the browser URL with macOS open
  --attach                     attach to tmux after creating the session
  --dry-run                    write run notes and print planned commands without starting tmux or hardware
  --help                       show this help
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

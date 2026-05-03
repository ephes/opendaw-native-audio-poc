import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRunPlan,
  parseCliArgs,
  renderRunReadme,
} from "../scripts/l12-recording-session.mjs";

test("parseCliArgs uses L-12 defaults", () => {
  assert.deepEqual(parseCliArgs([]), {
    help: false,
    options: {
      session: "opendaw-l12",
      port: 4545,
      framesPerBlock: 960,
      device: "ZOOM",
      channels: 14,
      sampleRate: 48000,
      smokeMs: 1000,
      runRoot: ".runs/l12-recording",
      replace: false,
      open: false,
      attach: false,
      dryRun: false,
    },
  });
});

test("parseCliArgs parses session options", () => {
  const parsed = parseCliArgs([
    "--session",
    "opendaw-l12-test",
    "--port",
    "4546",
    "--frames-per-block",
    "240",
    "--device",
    "ZOOM L-12",
    "--channels",
    "12",
    "--sample-rate",
    "48000",
    "--smoke-ms",
    "0",
    "--replace",
    "--open",
    "--attach",
    "--dry-run",
  ]);

  assert.equal(parsed.help, false);
  assert.deepEqual(parsed.options, {
    session: "opendaw-l12-test",
    port: 4546,
    framesPerBlock: 240,
    device: "ZOOM L-12",
    channels: 12,
    sampleRate: 48000,
    smokeMs: 0,
    runRoot: ".runs/l12-recording",
    replace: true,
    open: true,
    attach: true,
    dryRun: true,
  });
});

test("parseCliArgs rejects unsafe or invalid options", () => {
  assert.throws(
    () => parseCliArgs(["--session", "bad session"]),
    /--session must contain only/,
  );
  assert.throws(
    () => parseCliArgs(["--port", "0"]),
    /--port must be a positive integer/,
  );
  assert.throws(
    () => parseCliArgs(["--smoke-ms", "-1"]),
    /--smoke-ms must be a non-negative integer/,
  );
  assert.throws(
    () => parseCliArgs(["--run-root", ""]),
    /--run-root must not be empty/,
  );
  assert.throws(
    () => parseCliArgs(["--unknown", "1"]),
    /Unknown option --unknown/,
  );
});

test("buildRunPlan constructs server, smoke, and inspector commands", () => {
  const options = parseCliArgs([
    "--port",
    "4546",
    "--frames-per-block",
    "240",
    "--device",
    "ZOOM L-12",
    "--channels",
    "14",
    "--sample-rate",
    "48000",
    "--smoke-ms",
    "1500",
  ]).options;
  const plan = buildRunPlan(
    options,
    "/repo",
    new Date("2026-05-03T10:20:30.123Z"),
  );

  assert.equal(plan.timestamp, "2026-05-03T10-20-30-123Z");
  assert.equal(plan.runDir, "/repo/.runs/l12-recording/2026-05-03T10-20-30-123Z");
  assert.equal(plan.browserUrl, "http://127.0.0.1:4546/");
  assert.equal(
    plan.serverCommand,
    "cargo run -- serve --source input --device 'ZOOM L-12' --channels 14 --sample-rate 48000 --port 4546 --frames-per-block 240",
  );
  assert.equal(
    plan.smokeCommand,
    "just smoke-l12 1500 '' 240 'ZOOM L-12' 14 48000",
  );
  assert.equal(
    plan.inspectCommand,
    "just inspect-recording MANIFEST_PATH 14 48000 240",
  );
});

test("renderRunReadme documents manual boundaries and post-export inspection", () => {
  const options = parseCliArgs(["--smoke-ms", "0"]).options;
  const plan = buildRunPlan(options, "/repo", new Date("2026-05-03T10:20:30.123Z"));
  const readme = renderRunReadme(options, plan);

  assert.match(readme, /Disabled with --smoke-ms 0/);
  assert.match(readme, /Click Start Recording/);
  assert.match(readme, /Click Export Manifest/);
  assert.match(readme, /does not read OPFS, automate browser recording controls/);
  assert.match(readme, /just inspect-recording MANIFEST_PATH 14 48000 960/);
});

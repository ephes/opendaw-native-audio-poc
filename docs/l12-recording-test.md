# L-12 Recording Reliability Test Notes

Use this file as a repeatable manual checklist for browser-side recording tests with the ZOOM LiveTrak L-12.

See the README Browser Recording Mode section for the full workflow and artifact format. If `127.0.0.1:4545` is already in use, start the server with another port, for example `--port 4546`, and open that URL instead. Prefer starting monitor playback before recording when monitor counters matter; starting monitor during recording intentionally resets and rebases underrun/overflow deltas.

After exporting a manifest, run the offline manifest inspector and keep its report with these notes:

```sh
just inspect-recording <manifest.json>
```

The command does not use the L-12, Chrome, OPFS, browser automation, DAW import, or raw `.f32` chunk files. It fails on stream-shape mismatches, gaps, overlaps, discontinuities, channel mismatches, invalid blocks, chunk/block frame or byte inconsistencies, fatal recovery warnings, and native dropped callback buffers/frames/events. It reports monitor underruns/overflows, WebSocket lag, counter resets, and write-backlog high-water counters as warnings.

Before a longer recording run, the opt-in monitor smoke can check the real-device path quickly:

```sh
just smoke-l12 1000
```

The smoke requires connected ZOOM hardware. By default it opens the input source with device substring `ZOOM`, 14 channels, 48 kHz, and 960 frames per block, then drives the browser monitor path headlessly and expects 14 active meters with zero underruns, overflows, and native dropped callback buffers/frames/events. If the device is absent or the requested config cannot open, the command reports that the hardware smoke did not run and includes the Rust server output. First runs compile the Rust server inside the smoke's startup window; run `cargo build` first or increase `SMOKE_SERVER_TIMEOUT_MS` if startup times out while cargo is still compiling. Overrides follow the `just` target order: `just smoke-l12 <monitor-ms> <port> <frames-per-block> <device-substring> <channels> <sample-rate>`. Set `CHROME_PATH` for a non-default Chromium binary. Set `SMOKE_EXPECT_ACTIVE_METERS` only when deliberately running with known silent inputs.

For the longer manual L-12 recording validation, prefer the opt-in tmux orchestration harness:

```sh
just l12-recording-session
```

The harness requires `tmux` and connected L-12 hardware. It creates a timestamped run directory under `.runs/l12-recording/`, starts a named tmux session with server, preflight, and notes windows, captures pane output to logs, prints the browser URL, and writes a run checklist with the exact post-export inspector command. When preflight is enabled, the server window waits until the smoke passes before opening the L-12 for the long-running server. It does not click browser controls, read OPFS, export the manifest, import into a DAW, or run in `just test`.

Useful overrides:

```sh
just l12-recording-session opendaw-l12 4545 960 ZOOM 14 48000 1000
node scripts/l12-recording-session.mjs --replace
node scripts/l12-recording-session.mjs --open --attach
node scripts/l12-recording-session.mjs --dry-run
```

## Setup

- Date:
- Browser and version:
- macOS version:
- Device name from `cargo run -- list`:
- Command:

  ```sh
  just l12-recording-session
  ```

- Run directory:
- tmux session:
- Preflight monitor smoke result:
- Browser storage persistence granted: yes/no
- Monitor enabled: yes/no
- Monitor pair:

## Short Test

- Duration:
- Channels reported:
- Sample rate reported:
- Recorded frames:
- Recorded blocks / received blocks:
- Expected next frame:
- Chunks / bytes:
- Gaps:
- Overlaps:
- Discontinuities:
- Counter resets:
- Write-backlog events:
- Backlog high-water:
- Underruns during recording:
- Overflows during recording:
- WebSocket lag events:
- Native dropped callback buffers:
- Native dropped frames:
- Native drop events:
- Storage or export errors:
- Exported manifest filename:
- Manifest inspector command:
- Manifest inspector result:
- Exported WAV channel(s):
- DAW/import result:

## Long Test

- Target duration:
- Actual duration:
- Recorded frames:
- Chunks / bytes:
- Gaps:
- Overlaps:
- Discontinuities:
- Counter resets:
- Write-backlog events:
- Backlog high-water:
- Underruns during recording:
- Overflows during recording:
- WebSocket lag events:
- Native dropped callback buffers:
- Native dropped frames:
- Native drop events:
- Storage or export errors:
- Exported manifest filename:
- Manifest inspector command:
- Manifest inspector result:
- DAW/import result:

## Recovery Test

- Failure simulated by: reload/tab close/browser quit
- Recording duration before failure:
- Chunks expected before failure:
- Reopened page listed abandoned session: yes/no
- Recovery state shown:
- Recovery warnings:
- Reconstructed channels / sample rate / frames-per-block:
- Reconstructed frames:
- Reconstructed chunks / bytes:
- Native dropped callback buffers / frames / events in recovered manifest:
- Exported recovery manifest filename:
- Manifest inspector command:
- Manifest inspector result:
- Exported recovered WAV channel(s):
- WAV export result:
- Deleted recovered session: yes/no
- Scan after delete lists session: yes/no

## Channel Mapping Notes

- Channel 1 source:
- Channel 9 source:
- Channel 13 source:
- Observed alignment or drift:

## Follow-Up

- Issues found:
- Next action:

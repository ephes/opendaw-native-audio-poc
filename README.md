# openDAW Native Audio Bridge PoC

This repository is a minimal feasibility probe for feeding native macOS multichannel audio into a Web Audio / AudioWorklet graph, with openDAW integration as a later step.

The question to answer is not whether a native app can record multichannel audio. The question is whether native CoreAudio capture can be bridged into a browser/WebView AudioWorklet reliably enough that openDAW could eventually use it as a desktop-only capture backend.

## Target Architecture

```text
CoreAudio device
  -> Rust/cpal native process
  -> localhost WebSocket with interleaved Float32 PCM blocks
  -> browser Worker
  -> SharedArrayBuffer ring buffer
  -> AudioWorkletProcessor
  -> meters and selectable stereo monitor output
```

The protocol should stay implementation-neutral so the Rust backend can later be replaced by Swift/CoreAudio without rewriting the browser side.

## First Questions

1. Can the native backend enumerate the ZOOM LiveTrak L-12 as a multichannel CoreAudio input device?
2. Can it open the device at 48 kHz with 8-12 input channels?
3. Can a browser page receive those channels and feed an AudioWorklet without persistent underruns or overflows?
4. Can the Web Audio side display per-channel meters and play a selected stereo monitor pair?

## Non-Goals

- Full openDAW integration.
- Tauri, Electron, or SwiftUI app shell.
- Production recording file format.
- Virtual audio device drivers.
- Remote guest recording or WebRTC call flow.

## Commands

List native input devices and supported input configs:

```sh
cargo run -- list
```

Run the localhost browser test page with 12 channels of synthetic Float32 audio:

```sh
cargo run -- serve --source sine --channels 12 --sample-rate 48000
```

Attempt to open a native input device by case-insensitive name substring and stream it to the same browser page:

```sh
cargo run -- serve --source input --device "ZOOM" --channels 14 --sample-rate 48000
```

`--device` is a case-insensitive substring match against the cpal input device name. It is ignored for `--source sine`.

The server defaults to `http://127.0.0.1:4545` and exposes its PCM WebSocket at `/ws`. Use `--port` to choose another port and `--frames-per-block` to change the WebSocket block size. The page is served with COOP/COEP headers so `SharedArrayBuffer` is available.

Development shorthand:

```sh
just test
just inspect-recording <manifest.json>
just smoke-browser
just smoke-l12
just l12-recording-session
just list
just serve-sine
just serve-l12
```

`just test` runs `cargo fmt --check`, `cargo check`, `cargo test`, Node.js unit tests, and JavaScript syntax checks for the static browser modules and offline scripts. It does not run any browser smoke checks; run `just smoke-browser` for the sine path and `just smoke-l12` for the opt-in hardware path.

`just inspect-recording <manifest.json>` validates an exported or recovered recording manifest from disk without hardware, Chrome, OPFS access, browser automation, or raw `.f32` chunk files. The target defaults to the observed L-12 shape: 14 channels, 48 kHz, 960 frames per block, `f32-interleaved`, and zero native input drop deltas.
For known-bad or exploratory artifacts where native drops are expected, run `node scripts/inspect-recording-manifest.mjs <manifest.json>` directly and choose only the expectations that apply.

`just smoke-browser` starts a temporary 12-channel sine server, opens Chrome headless, connects the browser page, starts monitor playback, and verifies the AudioWorklet path for 30 seconds; override the duration with `just smoke-browser <milliseconds>`, or set `CHROME_PATH` if Chrome is not installed in the default macOS location. The smoke uses free local ports by default; set `SMOKE_PORT` or `SMOKE_CHROME_DEBUG_PORT` when a fixed port is needed. First runs compile the Rust server inside the smoke's startup window; run `cargo build` first or increase `SMOKE_SERVER_TIMEOUT_MS` if startup times out while cargo is still compiling.

`just smoke-l12` is an opt-in real-device monitor smoke for the observed ZOOM LiveTrak L-12 path. It starts a temporary input-source server with device substring `ZOOM`, 14 channels, 48 kHz, and 960 frames per block, then runs the same headless browser monitor checks for 30 seconds. It requires the L-12 to be connected and available through CoreAudio. If the device is missing or the requested config cannot open, the command reports that the hardware smoke did not run and includes the Rust server output, such as device selection, config, or stream-open errors. Override the duration with `just smoke-l12 <milliseconds>`, or use the full form `just smoke-l12 <milliseconds> <port> <frames-per-block> <device-substring> <channels> <sample-rate>`. First runs compile the Rust server inside the smoke's startup window; run `cargo build` first or increase `SMOKE_SERVER_TIMEOUT_MS` if startup times out while cargo is still compiling. The smoke expects all 14 meters to become active and native dropped callback buffers/frames/events to remain `0`; set `SMOKE_EXPECT_ACTIVE_METERS` only when deliberately running with known silent inputs, and set `SMOKE_EXPECT_NATIVE_DROPS_ZERO=0` only when deliberately investigating a known hardware drop condition.

`just l12-recording-session` is an opt-in tmux harness for the real-device 10-20 minute L-12 recording validation. It creates a timestamped local run directory under `.runs/l12-recording/`, writes a run checklist, starts a named tmux session with a server window, a one-shot `just smoke-l12` preflight window, and a notes window, and captures pane output to run logs. When preflight is enabled, the server window waits until the smoke passes before opening the L-12 for the long-running server. It does not automate browser recording controls, export manifests, read OPFS, import into a DAW, or run as part of `just test`. After stopping the browser recording and exporting the manifest manually, run the generated `just inspect-recording <manifest.json>` command and keep the report with the run notes. Override the just defaults positionally with `just l12-recording-session <session> <port> <frames-per-block> <device-substring> <channels> <sample-rate> <smoke-ms>`, or run `node scripts/l12-recording-session.mjs --help` for named flags such as `--replace`, `--open`, `--attach`, and `--dry-run`.

`just serve-sine` defaults to 12 channels at 48 kHz on port 4545 with 960 frames per block; override with `just serve-sine <channels> <sample-rate> <port> <frames-per-block>`. `just serve-l12` starts the observed ZOOM LiveTrak L-12 path with 14 channels at 48 kHz and 960 frames per block; override with `just serve-l12 <port> <frames-per-block>`.

## Current Implementation

The first functional slice includes:

- `cargo run -- list` device/config enumeration through cpal.
- `serve --source sine` synthetic multichannel sine/noise generation.
- `serve --source input` cpal input capture for `f32`, `i16`, and `u16` input sample formats converted to interleaved Float32.
- Static browser test page under `public/`.
- Worker-owned WebSocket receiver writing PCM into a `SharedArrayBuffer` ring buffer.
- `AudioWorkletProcessor` stereo monitor output with selectable source channels.
- Per-channel peak meters, underrun counter, overflow counter, buffer fill display, and native input drop counters.
- Browser-side recording mode that captures received WebSocket PCM blocks into OPFS Float32 chunks with an exportable manifest.
- Selected-channel Float32 WAV export for manual DAW inspection.

The input path requires the device to report the requested exact channel count and sample rate through cpal. If that combination is not available, the CLI exits with a device/config-specific error.

## Browser Recording Mode

The static page can now record the received native PCM stream before it is written to the monitor ring buffer. This is still a PoC reliability probe, not a production recorder.

Workflow:

1. Start the server, for example:

   ```sh
   just serve-sine
   ```

   or, with the observed ZOOM LiveTrak L-12 CoreAudio device:

   ```sh
   just serve-l12
   ```

   For a repeatable L-12 hardware run with tmux logging and a generated checklist, use:

   ```sh
   just l12-recording-session
   ```

   Then attach with the printed `tmux attach -t ...` command and use the printed browser URL.

2. Open `http://127.0.0.1:4545`.
3. Click Connect.
4. Optionally click Start Monitor and choose a stereo monitor pair.
5. Click Start Recording.
6. Let the stream run.
7. Click Stop Recording.
8. Inspect the recording counters and export artifacts.
9. Run offline manifest inspection on the exported manifest.

For the observed L-12 path, inspect the exported manifest with:

```sh
just inspect-recording ./native-pcm-...-manifest.json
```

The inspector checks the manifest stream shape, continuity arrays, chunk/block frame and byte math, top-level frame/block totals, and native input drop deltas. It fails on gaps, overlaps, discontinuities, channel mismatches, invalid blocks, malformed chunk metadata, fatal recovery warnings, and native dropped callback buffers/frames/events when the zero-drop expectation is enabled. It reports monitor underruns/overflows, WebSocket lag events, monitor counter resets, and write-backlog high-water counters as warnings because those are browser/monitor observability signals rather than direct proof of native input loss.

Recording uses the Origin Private File System through `navigator.storage.getDirectory()`. Use a Chromium-class desktop browser for this slice. If OPFS is unavailable, recording refuses to arm and monitoring remains usable. The page asks the browser for persistent storage when recording starts, but the browser may still return `false`; long tests should be run in a profile with sufficient free disk space.

Raw size is substantial:

```text
14 channels * 48000 frames/s * 4 bytes = 2.688 MB/s
20 minutes at 14 channels ~= 3.2 GB
```

The recorder stores chunk files in OPFS as interleaved Float32 little-endian PCM with no file header. Chunks are currently targeted at 64 MiB each. A small OPFS index file, `native-pcm-recordings-index.json`, tracks known PoC recording sessions and points at their manifest/chunk naming pattern. The manifest is written when recording starts, when chunks close, and when recording stops, and can be downloaded with Export Manifest.

The manifest includes:

- session id, start/stop wall-clock timestamps, sample rate, channel count, frames per block, and sample format
- first `frameStart`, expected next frame, total recorded frames, recorded block count, chunk count, and byte count
- per-chunk file names, frame spans, byte sizes, and per-block `frameStart`/`frameCount` metadata
- native input stats snapshots under `nativeInputStats`, including start/latest/stop counters for dropped callback buffers, dropped frames, drop events, bridge queue capacity, source, and backend `atFrame`
- detected gaps, overlaps, discontinuities, channel mismatches, invalid blocks, WebSocket lag events, monitor counter resets, byte-based write-backlog warnings, and underrun/overflow deltas during recording

Export Selected WAV writes one mono 32-bit float WAV for the selected source channel. This is intended for DAW import and channel-mapping checks. WAV export reads OPFS chunks and deinterleaves the selected channel, but the resulting mono WAV is assembled as a browser `Blob`; exporting very long channels can still be memory-intensive. All-channel WAV export is intentionally left out of this slice.

The top status counters show cumulative native dropped cpal callback buffers, dropped frames, and drop events from the Rust backend. The recording status panel also shows native dropped callback buffers/frames/events during the active recording. These counters are separate from WebSocket PCM blocks, browser-side gaps/overlaps, WebSocket lag, and monitor underrun/overflow counters.

The Disconnect button is disabled while recording is active or the recorder is in an error state. Stop the recording first so the Worker can flush queued OPFS writes, close the current chunk, and write the final manifest. If recording enters an error state, use Reset/Clear Recording before disconnecting so OPFS chunks from the current session are removed. Starting monitor playback during a recording resets the existing monitor underrun/overflow counters; the recorder records that reset and rebases the recording deltas.

## OPFS Recovery

The page now scans OPFS for PoC recording artifacts on load and through the OPFS Sessions panel. Recovery is browser-side only; it does not change the WebSocket protocol or write files from Rust.

Recovery scan looks only at this PoC's `native-pcm-*` OPFS artifacts:

- `native-pcm-recordings-index.json`
- `native-pcm-*-manifest.json`
- `native-pcm-*-chunk-*.f32`

After a reload, tab close, or browser failure before Stop Recording, reopen the page and use OPFS Sessions:

1. Click Scan Recovery if the list is stale.
2. Select an abandoned or stopped session.
3. Inspect state, stream shape, duration/frames, chunk count/bytes, and reconstruction warnings.
4. Export Recovery Manifest to download `<sessionId>-recovered-manifest.json`.
5. Export Recovered WAV for one selected channel when the stream shape and required chunks validate.
6. Delete Session to remove that session's OPFS manifest and chunks and its index entry.

Recovered manifests are explicit recovery artifacts. They include `recovered: true`, `recoveredAt`, structured `recoveryWarnings` with warning code and fatal/non-fatal status, original start/stop information, native input stats from the original manifest when present, reconstructed frame/byte/chunk totals, and per-chunk validation results. Abandoned sessions are not silently treated as clean stops; a missing `stoppedAt`, missing native input stats in an older manifest, missing chunks, truncated chunks, unknown stream shape, unmanifested chunks, or manifest/file-size mismatch is reported as a warning. WAV export fails rather than zero-padding missing or corrupt audio. A trailing unmanifested empty/truncated chunk can be skipped with an explicit warning so already-closed chunks remain exportable.

Cleanly stopped prior sessions may also appear in OPFS Sessions after a reload. They can be exported through the recovery controls or deleted from OPFS. Delete only removes files whose names match the selected `native-pcm-*` session; it does not clear unrelated site data.

While a recording is active or still has an open in-memory chunk, OPFS Sessions may list it for visibility but disables recovery manifest and WAV export until the recording is stopped or reset.

For lower-latency browser monitoring, restart with a smaller block size, for example `just serve-l12 4545 240`. Smaller blocks reduce WebSocket aggregation and AudioWorklet target latency, but they increase message rate and should be re-tested for gaps, overflows, and backlog.

Known limits:

- OPFS support and persistence behavior vary by browser and profile.
- OPFS has no normal user-visible filesystem path. Use the recovery/delete UI to inspect and remove PoC recording artifacts.
- A browser/tab crash may leave the currently-open OPFS writable absent or truncated; recovery surfaces this as warnings and does not hide corruption.
- OPFS write throughput is not backpressured into the WebSocket stream. The recorder serializes writes, displays pending/high-water backlog bytes, and records repeated write-backlog warnings at 64 MiB high-water increments, but extreme storage stalls can still end the session.
- Selected-channel WAV export still assembles one mono Blob and can be memory-intensive for very long sessions.
- Browser background throttling and tab lifecycle behavior are not fully proven.
- `frameStart` is the bridge aggregation timeline, not a hardware clock timestamp.
- Native input drop counters are cumulative observability counters, not recovery data. If they increase, audio was lost before browser delivery; the browser cannot reconstruct those missing frames.
- The Rust cpal callback still allocates before queue backpressure can be observed; this is PoC-only.

## Verification

Automated checks:

```sh
cargo fmt --check
cargo check
cargo clippy --all-targets
cargo test
just test
just smoke-browser 1000
cargo run -- list
cargo run -- serve --source sine --channels 12 --sample-rate 48000
```

Manual checks:

1. Open `http://127.0.0.1:4545`.
2. Click Connect.
3. Confirm the page reports the stream settings and the channel meters move.
4. Click Start Monitor and choose the left/right monitor channels.
5. Leave the stream running and watch underrun/overflow counters.
6. Confirm native dropped callback buffers, frames, and events stay at `0` for the sine source.

Short recording check with the sine source:

1. Start `just serve-sine`.
2. Open `http://127.0.0.1:4545`.
3. Click Connect.
4. Click Start Recording.
5. Let it run for 30-60 seconds.
6. Click Stop Recording.
7. Confirm the manifest counters report 12 channels, 48 kHz, plausible duration/frames, no unexpected gaps, and `nativeInputStats` with zero native drops.
8. Export the manifest.
9. Run `node scripts/inspect-recording-manifest.mjs <manifest.json> --expect-channels 12 --expect-sample-rate 48000 --expect-frames-per-block 960 --expect-native-drops-zero`.
10. Choose a source channel and export the selected-channel WAV.
11. Import or inspect the WAV as 32-bit float mono audio.

If ZOOM hardware is attached:

```sh
cargo run -- serve --source input --device "ZOOM" --channels 14 --sample-rate 48000
just smoke-l12 1000
just l12-recording-session
```

Record whether cpal exposes the device with more than two channels and whether the requested config opens. `just smoke-l12` is a short monitor smoke, not recording automation; it verifies the browser page reaches monitoring, shows 14 active meters, and reports clean monitor and native-drop counters. `just l12-recording-session` wraps the longer manual recording check in tmux, logs the server/preflight panes, and writes the run checklist under `.runs/l12-recording/`. For recording checks, speak into known channels such as channel 1 and a later channel such as 9 or 13, then export selected-channel WAVs and verify mapping/alignment in a DAW.
After exporting the L-12 recording manifest, run `just inspect-recording <manifest.json>` and keep the PASS/FAIL report with the manual test notes.

## Success Criteria

The monitor path is successful when the browser test page can show independent meters for at least 8-12 channels at 48 kHz and run for 10-20 minutes without recurring buffer underruns or overflows.

The recording reliability slice is successful when the browser can record a 10-20 minute 14-channel native stream into OPFS chunks, export a manifest with aligned `frameStart`/`frameCount` metadata, report gaps/overlaps/underrun/overflow/WebSocket lag counters, and export selected-channel WAVs that can be inspected in a DAW.

## Hardware Notes

Observed on 2026-04-30 with a ZOOM LiveTrak L-12 connected over CoreAudio:

```text
Input device: ZOOM L-12 Driver
channels: 14
format: f32
sample rates: 48000..48000 Hz
```

`--channels 12` correctly fails because cpal reports the device as exactly 14 input channels, not 12. `--channels 14 --sample-rate 48000` opens successfully and streams interleaved Float32 PCM to the browser test page.

Manual browser check: connecting the page and starting monitor playback produced audible local microphone monitoring from the L-12 input. The monitor path intentionally starts near the current write cursor so it does not play back the whole buffer accumulated before monitoring starts.

15-minute browser soak check with the L-12 showed stable monitoring with `0` underruns, 14 meters active, and 23 overflows visible at the end of the run. Those overflows are consistent with ring-buffer fill before monitor playback starts, so monitor startup now resets underrun/overflow counters after aligning the read cursor.

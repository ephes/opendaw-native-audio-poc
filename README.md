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
cargo run -- serve --source input --device "ZOOM" --channels 12 --sample-rate 48000
```

`--device` is a case-insensitive substring match against the cpal input device name. It is ignored for `--source sine`.

The server defaults to `http://127.0.0.1:4545` and exposes its PCM WebSocket at `/ws`. Use `--port` to choose another port and `--frames-per-block` to change the WebSocket block size. The page is served with COOP/COEP headers so `SharedArrayBuffer` is available.

Development shorthand:

```sh
just test
```

This runs `cargo fmt --check` and `cargo check`.

## Current Implementation

The first functional slice includes:

- `cargo run -- list` device/config enumeration through cpal.
- `serve --source sine` synthetic multichannel sine/noise generation.
- `serve --source input` cpal input capture for `f32`, `i16`, and `u16` input sample formats converted to interleaved Float32.
- Static browser test page under `public/`.
- Worker-owned WebSocket receiver writing PCM into a `SharedArrayBuffer` ring buffer.
- `AudioWorkletProcessor` stereo monitor output with selectable source channels.
- Per-channel peak meters, underrun counter, overflow counter, and buffer fill display.

The input path requires the device to report the requested exact channel count and sample rate through cpal. If that combination is not available, the CLI exits with a device/config-specific error.

## Verification

Automated checks:

```sh
cargo fmt --check
cargo check
cargo run -- list
cargo run -- serve --source sine --channels 12 --sample-rate 48000
```

Manual checks:

1. Open `http://127.0.0.1:4545`.
2. Click Connect.
3. Confirm the page reports the stream settings and the channel meters move.
4. Click Start Monitor and choose the left/right monitor channels.
5. Leave the stream running and watch underrun/overflow counters.

If ZOOM hardware is attached:

```sh
cargo run -- serve --source input --device "ZOOM" --channels 14 --sample-rate 48000
```

Record whether cpal exposes the device with more than two channels and whether the requested config opens.

## Success Criteria

The PoC is successful when the browser test page can show independent meters for at least 8-12 channels at 48 kHz and run for 10-20 minutes without recurring buffer underruns or overflows.

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

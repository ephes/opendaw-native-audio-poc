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

## Suggested Commands

These commands are placeholders for the first implementation slice:

```text
cargo run -- list
cargo run -- serve --source sine --channels 12 --sample-rate 48000
cargo run -- serve --source input --device "ZOOM" --channels 12 --sample-rate 48000
```

## Success Criteria

The PoC is successful when the browser test page can show independent meters for at least 8-12 channels at 48 kHz and run for 10-20 minutes without recurring buffer underruns or overflows.

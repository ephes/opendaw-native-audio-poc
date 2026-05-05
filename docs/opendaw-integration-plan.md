# openDAW Native Audio Bridge Integration Plan

## Purpose

This document is the bridge from the native audio bridge PoC back into openDAW-oriented work. It does not define an openDAW implementation slice yet. It captures the PoC evidence, the current native/browser contract, the smallest useful openDAW-facing proof, and the boundaries that should stay out of scope until that proof exists.

The immediate goal is to let a later slice integrate against a concrete localhost PCM bridge contract without changing openDAW, the WebSocket protocol, the OPFS recorder, or the recording manifest schema in this planning slice.

## Validated PoC Assumptions

- Native device discovery works through `cargo run -- list`. The observed ZOOM LiveTrak device appeared as `ZOOM L-12 Driver` with 14-channel `f32` input support at 48000 Hz.
- The native server can open the L-12 through cpal with `--source input --device "ZOOM" --channels 14 --sample-rate 48000` when the device reports the exact requested shape.
- The browser Worker receives native PCM over the localhost WebSocket, validates block shape, writes interleaved Float32 samples into a `SharedArrayBuffer` ring buffer, computes per-channel meters, and forwards the buffer to an `AudioWorkletProcessor`.
- The AudioWorklet path can monitor a selectable stereo pair from the multichannel ring buffer. Its underrun and overflow counters are monitor/browser observability signals, not direct native input loss counters.
- The browser recorder captures received WebSocket PCM blocks into OPFS `.f32` chunks before the monitor ring-buffer write, stores a manifest, exports selected-channel Float32 WAV files, and can recover stopped or abandoned OPFS sessions.
- The offline manifest inspector validates stream shape, chunk/block frame and byte math, continuity arrays, recovery warnings, and native drop deltas without hardware, Chrome, OPFS access, browser automation, or raw chunk files.
- Commit `0d8a2c1` added the opt-in L-12 tmux recording-session harness for real-device manual validation. The harness is not part of normal tests and does not automate browser recording controls or DAW import.

The strongest current hardware evidence is a real L-12 recording validation run:

- Session id: `native-pcm-2026-05-03T06-30-15-569Z`
- Duration: 779.400 seconds, about 13 minutes
- Shape: 14 channels, 48000 Hz, 960 frames/block, `f32-interleaved`
- Recorded: 37,411,200 frames, 38,970 blocks, 32 chunks, about 2.0 GiB
- Manifest inspection: PASS
- Continuity: gaps=0, overlaps=0, discontinuities=0, channelMismatches=0, invalidBlocks=0
- Native drops during recording: blocks=0, frames=0, events=0
- Warnings: monitor overflows during recording=38,970; write backlog high-water=9 blocks / 483,840 bytes

The monitor overflow count is a follow-up observability risk. It should not block planning the first openDAW integration step because the recording manifest passed continuity validation and native input drop deltas stayed at zero.

## Current Bridge Contract

The current compatibility boundary is the localhost WebSocket protocol, not the Rust implementation, browser UI, ring-buffer layout, OPFS manifest, or exported WAV artifacts.

Current native process surface:

- HTTP server bound to `127.0.0.1`, default port `4545`, serving the static page from `public/`.
- Cross-origin isolation headers on the served page: `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, and `Cross-Origin-Resource-Policy: same-origin`.
- WebSocket endpoint at `/ws`.
- Configurable source: synthetic `sine` or cpal `input`.
- Configurable stream shape: `channels`, `sampleRate`, and `framesPerBlock`; defaults are 12 channels, 48000 Hz, and 960 frames/block for the sine shorthand.
- Input devices are selected by case-insensitive name substring. The cpal input path requires the device to report the exact requested channel count and sample rate.
- The cpal input path accepts `f32`, `i16`, and `u16` input sample formats and converts them to interleaved Float32 before bridge delivery.

WebSocket text messages currently include:

- `stream-started`: sent first on connect. Fields are `type`, `sampleRate`, `channels`, `framesPerBlock`, and `sampleFormat`. The current sample format is `f32-interleaved`.
- `native-input-stats`: sent after `stream-started` and then about once per second. Fields are `type`, `source`, `nativeDroppedBlocks`, `nativeDroppedFrames`, `nativeDropEvents`, `bridgeQueueCapacityBlocks`, and `atFrame`.
- `stream-error`: sent when the server detects a lagging WebSocket receiver. Fields are `type`, `code`, and `message`; the current lag code is `server-client-lagged`.

WebSocket binary PCM blocks currently use this layout:

```text
bytes 0..8    u64 little-endian frameStart
bytes 8..12   u32 little-endian frameCount
bytes 12..14  u16 little-endian channelCount
bytes 14..16  u16 reserved, currently zero
bytes 16..N   Float32 little-endian interleaved PCM
```

`frameStart` is the bridge aggregation timeline. It is useful for continuity checks, but it is not a hardware timestamp. `frameCount * channelCount` Float32 samples follow the 16-byte header. The browser receiver rejects too-small blocks, byte-length mismatches, and channel mismatches against the `stream-started` metadata.

## openDAW Consumption Contract

Phase 1 must consume only the stable bridge surface above.

Must have for phase 1:

- Stream metadata from `stream-started`: sample rate, channel count, frames per block, and sample format.
- Audio payload from binary PCM blocks: `frameStart`, `frameCount`, channel count, and interleaved Float32 samples.
- Channel mapping assumption: preserve bridge channel order directly. UI labels may present these as Channel 1 through Channel N, but the implementation should treat the payload as zero-based channel indexes.
- Timeline assumption: consume monotonically increasing `frameStart` values and detect gaps or overlaps. Phase 1 should not treat `frameStart` as a device clock timestamp.
- Observability from `native-input-stats`: display or surface native dropped callback buffers, dropped frames, drop events, source, bridge queue capacity, and `atFrame`.
- Error observability from `stream-error`: surface lag or delivery errors without trying to synthesize missing audio.
- Localhost assumption: the initial openDAW-facing proof connects to an already running bridge URL, rather than launching or supervising the native process.

Later, after phase 1 proves the live input abstraction:

- Device enumeration and selection from openDAW.
- Native process launch, restart, shutdown, permissions, and version negotiation.
- A richer control protocol, if needed, for device loss, stream restart, channel names, latency metadata, or backend capabilities.
- A production recording/project model that does not depend on the PoC OPFS manifest format.
- A native backend swap from Rust/cpal to Swift/CoreAudio while preserving the browser/OpenDAW receiver contract.

## Phase 1 Proof Target

The chosen phase 1 target is an openDAW-side live input and meter proof, not project recording.

The proof should connect an openDAW dev/prototype surface to the existing bridge, consume the WebSocket stream, and display all 14 L-12 channels as live meters using openDAW-compatible input plumbing where practical. This is the smallest useful target because it verifies openDAW can ingest the bridge stream shape, channel order, and native-drop observability before committing to recorder semantics, project persistence, desktop process management, or a production native backend.

Phase 1 should avoid importing OPFS chunks, automating DAW import, changing the bridge protocol, or treating the PoC manifest as an openDAW project format.

## Proposed Phases

Phase 0: keep PoC harness and evidence

- Keep `just test` hardware-independent.
- Keep opt-in real-device validation behind `just smoke-l12` and `just l12-recording-session`.
- Preserve the 13-minute L-12 PASS as the current confidence baseline.
- Track monitor overflow and write-backlog warnings as observability follow-ups.

Phase 1: openDAW live input/meter proof

- Connect an openDAW-side dev/prototype consumer to `ws://127.0.0.1:<port>/ws`.
- Consume `stream-started`, `native-input-stats`, `stream-error`, and binary PCM blocks.
- Display 14 channel meters for the L-12 path and surface native drop counters.
- Detect and report frame timeline gaps or overlaps.
- Keep the native bridge manually launched for this phase.

Phase 2: recording/project model experiment

- Decide whether openDAW records from the live PCM input abstraction, imports exported WAVs, or consumes a new export format.
- Keep OPFS manifest inspection as PoC evidence unless deliberately promoted or replaced.
- Define channel mapping persistence and project metadata expectations.

Phase 3: desktop launch and process-management strategy

- Decide how an openDAW desktop shell starts, configures, monitors, and stops the native bridge.
- Handle permissions, native binary distribution, port selection, restart behavior, and user-facing failure states.
- Keep normal automated tests free of ZOOM hardware, tmux, Chrome, and long-running servers.

Phase 4: production protocol and hardening decisions

- Decide whether the current WebSocket protocol remains sufficient or needs version/capability negotiation.
- Investigate device-loss events, stream restarts, latency reporting, clock metadata, channel names, and backend health.
- Decide whether Rust/cpal remains the bridge backend or is replaced by Swift/CoreAudio for macOS.

## Boundaries And Non-Goals

- Do not implement openDAW integration in this planning slice.
- Do not modify openDAW code or add an openDAW dependency here.
- Do not add npm dependencies, browser automation, Playwright, Puppeteer, or package metadata.
- Do not change the native WebSocket protocol, OPFS recorder, or manifest schema in this slice.
- Do not automate DAW import.
- Do not require tmux, Chrome, ZOOM hardware, long-running servers, or real recordings for `just test`.
- Do not commit generated `.runs/` artifacts, downloaded manifests, OPFS chunks, or exported WAV files.
- Do not treat the PoC recorder as the production openDAW recorder.
- Do not expose raw OPFS access from Node or an openDAW backend as the first integration path.
- Do not build a virtual audio driver, remote guest path, or WebRTC path as part of the native bridge proof.

## Risks And Open Questions

- Browser/WebView constraints: openDAW's eventual host must preserve COOP/COEP requirements for `SharedArrayBuffer`, or the receiver design must change.
- Localhost lifecycle: phase 1 can assume a manually launched server, but production needs launch, readiness, restart, shutdown, port conflict, and stale process handling.
- Native permissions: macOS microphone/input permissions and native binary signing/distribution are outside the PoC but required for a desktop integration.
- Exact L-12 channel mapping: bridge order is preserved, but openDAW still needs explicit mapping checks for physical channel labels, stereo pairs, and saved project metadata.
- Monitor overflow warning: the validation run reported 38,970 monitor overflows while native drops and recording continuity stayed clean. Confirm whether this is expected monitor cursor behavior, a display/counter interpretation issue, or a real monitoring-latency problem.
- Long-run storage behavior: the 13-minute, about 2.0 GiB run passed, but longer sessions and storage-pressure behavior still need investigation before production recording decisions.
- Clock semantics: `frameStart` is currently an aggregation timeline, not a hardware clock timestamp. Drift, latency, and synchronization requirements need a later design.
- Backend implementation: Rust/cpal is a PoC backend. A future Swift/CoreAudio implementation should be able to emit the same compatibility boundary, but parity is unproven.
- Callback allocation: the current Rust cpal callback allocates before queue backpressure can be observed. This is acceptable for the PoC but not a production low-latency recorder shape.

## Acceptance Criteria For First openDAW Slice

- An openDAW-side prototype or dev-only surface can connect to a manually launched bridge WebSocket URL.
- It consumes the actual `stream-started` metadata and rejects unsupported sample formats or malformed stream shape.
- It decodes binary PCM blocks using the current 16-byte header and interleaved Float32 payload.
- It displays live meters for the observed 14-channel L-12 stream at 48000 Hz and 960 frames/block.
- It preserves channel order and documents any UI mapping from zero-based indexes to user-facing channel labels.
- It tracks `frameStart` continuity and reports gaps, overlaps, malformed blocks, and server `stream-error` events.
- It surfaces native dropped callback buffers, dropped frames, drop events, source, bridge queue capacity, and `atFrame`.
- It does not implement project recording, OPFS import, DAW import automation, native process launch, or protocol changes.
- Its normal automated validation remains hardware-independent and does not require tmux, Chrome, ZOOM hardware, or long-running servers.
- The implementation includes updated documentation describing how to run the proof and how to interpret native drop and continuity signals.

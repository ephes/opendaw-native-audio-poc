# Native Audio Bridge Protocol

The first implementation should use a boring localhost WebSocket protocol. This keeps the browser/OpenDAW side independent from whether the native backend is written in Rust, Swift, C++, or something else.

## Control Events

JSON messages describe device and stream state:

```json
{
  "type": "stream-started",
  "sampleRate": 48000,
  "channels": 12,
  "framesPerBlock": 960,
  "sampleFormat": "f32-interleaved"
}
```

```json
{
  "type": "stream-error",
  "code": "server-client-lagged",
  "message": "WebSocket client skipped 3 audio blocks"
}
```

```json
{
  "type": "native-input-stats",
  "source": "input",
  "nativeDroppedBlocks": 0,
  "nativeDroppedFrames": 0,
  "nativeDropEvents": 0,
  "bridgeQueueCapacityBlocks": 64,
  "atFrame": 1234560
}
```

The current Rust server sends `stream-started` when a WebSocket client connects, then sends an initial `native-input-stats` event, then sends additional stats events about once per second. It sends `stream-error` when the server detects a client-side stream delivery problem such as a lagging WebSocket receiver. `device-lost` is reserved for a later backend path that can report input-device loss through the protocol. Per-channel browser meters are computed in the Worker from received PCM blocks rather than sent as JSON.

`native-input-stats` is a cumulative backend observability event. It does not change the binary PCM block layout and older clients can ignore it. Fields:

- `source`: `"sine"` or `"input"`.
- `nativeDroppedBlocks`: count of cpal callback buffers that the Rust input bridge could not enqueue before browser delivery. For `source: "sine"`, this remains `0`.
- `nativeDroppedFrames`: cumulative frames in those dropped callback buffers.
- `nativeDropEvents`: cumulative failed enqueue attempts. In the current Rust PoC this increments with each dropped callback buffer.
- `bridgeQueueCapacityBlocks`: capacity of the Rust callback-to-aggregation queue for `source: "input"`; `0` for `source: "sine"`.
- `atFrame`: latest backend source frame cursor. For `source: "input"` this advances in the cpal callback timeline, including dropped frames. It does not necessarily equal the latest emitted PCM `frameStart + frameCount` because aggregation can hold pending frames and dropped callback buffers still advance the source cursor. For `source: "sine"` this advances in the synthetic source timeline.

## PCM Blocks

PCM blocks should be binary WebSocket messages.

Implemented layout:

```text
bytes 0..8    u64 little-endian frameStart
bytes 8..12   u32 little-endian frameCount
bytes 12..14  u16 little-endian channelCount
bytes 14..16  reserved
bytes 16..N   Float32 little-endian interleaved PCM
```

`frameStart` is the first frame index in the backend stream timeline. `frameCount * channelCount` Float32 samples follow the 16-byte header.

For 12 channels at 48 kHz, raw throughput is modest:

```text
12 * 48000 * 4 bytes = 2.304 MB/s
```

The hard part is smooth scheduling and clock behavior, not raw bandwidth.

## Browser Side

The browser should receive PCM in a Worker, write it into a `SharedArrayBuffer` ring buffer, and let an `AudioWorkletProcessor` pull blocks from that buffer.

The first browser test page implements:

- underrun count
- overflow count
- native dropped block/frame/event counters from `native-input-stats`
- read/write distance
- per-channel peak meters computed by the Worker
- selectable left/right source channels for stereo monitor output

The static page must be served with cross-origin isolation headers for `SharedArrayBuffer`:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

The current in-page ring buffer state is an implementation detail, not part of the backend compatibility boundary. It uses a 256-byte metadata prefix with atomic Int32 counters followed by interleaved Float32 ring-buffer samples.

Browser recording artifacts are also outside the backend compatibility boundary. This includes `native-pcm-recordings-index.json`, `native-pcm-*-manifest.json`, `native-pcm-*-recovered-manifest.json`, `native-pcm-*-chunk-*.f32`, and exported `native-pcm-*.wav` files. The current OPFS chunk, manifest, and recovery artifact formats are documented in the README's Browser Recording Mode and OPFS Recovery sections.

## Compatibility Boundary

The WebSocket protocol is the compatibility boundary. A later Swift backend should be able to emit the same messages and binary PCM blocks without changing the browser receiver.

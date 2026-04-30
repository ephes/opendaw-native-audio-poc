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
  "type": "meters",
  "frameStart": 96000,
  "rms": [0.01, 0.02],
  "peak": [0.08, 0.12],
  "clip": [false, false]
}
```

```json
{
  "type": "stream-error",
  "code": "device-lost",
  "message": "Input device disappeared"
}
```

## PCM Blocks

PCM blocks should be binary WebSocket messages.

Initial simple layout:

```text
bytes 0..8    u64 little-endian frameStart
bytes 8..12   u32 little-endian frameCount
bytes 12..14  u16 little-endian channelCount
bytes 14..16  reserved
bytes 16..N   Float32 little-endian interleaved PCM
```

For 12 channels at 48 kHz, raw throughput is modest:

```text
12 * 48000 * 4 bytes = 2.304 MB/s
```

The hard part is smooth scheduling and clock behavior, not raw bandwidth.

## Browser Side

The browser should receive PCM in a Worker, write it into a `SharedArrayBuffer` ring buffer, and let an `AudioWorkletProcessor` pull blocks from that buffer.

The AudioWorklet should report:

- underrun count
- overflow count
- read/write distance
- current playback latency estimate
- per-channel meters, or enough data for the UI to compute them

## Compatibility Boundary

The WebSocket protocol is the compatibility boundary. A later Swift backend should be able to emit the same messages and binary PCM blocks without changing the browser receiver.

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

The Worker accepts only the three control types above. Stream geometry must use
positive integers: at most 64 channels, 384,000 Hz and 65,536 frames/block,
with `sampleFormat: "f32-interleaved"`. The rounded power-of-two monitor ring,
including its 256-byte metadata, must fit in 64 MiB:
`nextPowerOfTwo(max(framesPerBlock * 8, sampleRate * 2)) * channels * 4 + 256`.
The Rust CLI applies the same ranges and combined byte ceiling with checked
arithmetic before listener/source startup for both sine and input sources.
For example, 31 channels at 262,144 Hz and 65,536 frames/block fit; 32 do not.
The per-field maxima are not jointly admissible. Control text is limited to 4,096 UTF-16
code units; stats counters must be nonnegative safe integers and error messages
at most 1,024 code units with one of the documented error codes. Invalid JSON,
unsupported controls and excessive geometry produce a bounded error without
replacing the last valid configuration. Duplicate configuration is a no-op;
geometry changes are refused during recording or queued recording startup,
recorded in manifest integrity errors, and block further PCM until Stop followed
by reconfiguration or reconnect.

Each local client send (stream metadata, stats, lag control and PCM) has a two-second
deadline. A stalled send, sink failure or receive-side close/error ends that client
and releases its subscription; the owned receive task is aborted and reaped when
the producer exits. This per-client transport limit does not change capture queues
or buffering and does not interrupt other clients. The browser records unexpected
transport loss as an interrupted session, retaining flushed recoverable audio.

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

`frameStart` is the first frame index in the backend stream timeline. Both the
u64 cursor and its exclusive end (`frameStart + frameCount`) must be at most
`Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991). The decoder checks these as
BigInts before conversion; unsafe positions are invalid blocks, never rounded.
`frameCount` must be 1–65,536 and `channelCount` 1–64, matching the stream's
channel count. Reserved bytes must be zero. Exactly `frameCount * channelCount`
Float32 samples follow the 16-byte header; no trailing or missing bytes are
accepted. Unsupported headers fail before sample views are exposed.
Every sample must be a finite Float32 value. NaN and either infinity invalidate
the whole block before publication; finite PCM bytes (including signed zero and
subnormals) are preserved exactly, with no clamping or zero substitution.

Invalid blocks produce an error and, during recording, an `integrity.invalidBlocks`
event (a supported but unexpected channel count uses `channelMismatches`). They
never enter OPFS, the monitor ring, received-block counters or meters. The next
valid block is accepted; recording continuity compares it with the last accepted
exclusive end, preserving any gap or overlap evidence.

### Native callback queue and aggregation

The native callback advances `atFrame` by the callback's frame count before
attempting a nonblocking enqueue. A full or disconnected bridge queue rejects
the entire callback buffer and increments `nativeDroppedBlocks` and
`nativeDropEvents` once, plus `nativeDroppedFrames` by that buffer's frame count.
A later successful enqueue advances the source cursor without resetting the
cumulative loss counters. These counters describe capture-bridge loss separately
from WebSocket client lag and monitor underruns/overflows.

The aggregator concatenates accepted interleaved callback samples in arrival
order and emits only complete `framesPerBlock` blocks. Callback boundaries need
not match block boundaries; one callback can produce several blocks. On queue
closure any final incomplete block is discarded, without zero-padding or a
partial broadcast. Aggregation keeps draining when there are no subscribers.
For native input, PCM `frameStart` starts at zero and advances by the size of
each emitted full block in the **accepted-sample** timeline. Rejected callback
buffers therefore do not create PCM frame-index gaps; native loss must be read
from the stats counters and source `atFrame`, not inferred from PCM continuity.

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

### Monitor worklet controls and output

The worklet supports one stereo output (as configured by the page); a mono
source can feed both output channels. Before configuration it renders silence.
`configure` takes a `sharedBuffer` and optional zero-based `left`/`right` source
indices. The buffer must be shared, at most 64 MiB, and exactly match its
256-byte metadata prefix plus `capacityFrames * channels * 4` sample bytes.
Metadata requires 1–64 channels, a positive power-of-two capacity, 1–384,000 Hz,
and 1–65,536 frames per block. These geometry fields stay fixed for the buffer's
lifetime. Configuration validates all fields before publishing any new state.
Omitted channels retain the previous selection, clamped to the new source count
(initially 0/1, or 0/0 for mono). `channels` requires both indices and an existing
configuration. Explicit indices must be finite integers in the source range.

Malformed or unsupported messages produce one fixed-size `control-error`
diagnostic notification (currently not displayed by the page), without echoing
input or changing the last valid configuration,
routing, cursors or counters. Each accepted configure aligns to at most three
blocks of retained, unconsumed audio, resets overflow/underrun counters, and
emits one `counters-reset`. Channel rerouting does not reset counters. Short
renders zero-fill missing frames and increment underruns once per quantum.
`status` is emitted on the first configured render and every 20 configured
render quanta afterward; reconfiguration preserves this cadence.

Browser recording artifacts are also outside the backend compatibility boundary. This includes `native-pcm-recordings-index.json`, `native-pcm-*-manifest.json`, `native-pcm-*-recovered-manifest.json`, `native-pcm-*-chunk-*.f32`, and exported `native-pcm-*.wav` files. The current OPFS chunk, manifest, and recovery artifact formats are documented in the README's Browser Recording Mode and OPFS Recovery sections.

Manifests written to OPFS use `chunkMetadata: {format: "per-chunk-v1", count: N}`
and immutable `native-pcm-*-chunk-*.f32.json` sidecars for the first N closed
chunks; only chunks without a committed sidecar stay inline in `chunks`. Each
sidecar is committed before the manifest count advances. Recovery expands these
references in order, validating the chunk index, file name, completion
timestamp and block-list presence, then appends the inline chunks; an
incomplete metadata read is fatal for WAV export. Exported manifests retain
full inline block evidence, and legacy inline-only manifests remain supported. Recovery checks each OPFS JSON
file's size and nesting depth before using it; the budgets, recovery and
cleanup behavior are documented in the README.

Manifests carry `counterEpochTotals: {underruns, overflows}` with the monitor
counter deltas closed by earlier monitor counter resets; `counterDeltasAtStop`
includes them.

## Compatibility Boundary

The WebSocket protocol is the compatibility boundary. A later Swift backend should be able to emit the same messages and binary PCM blocks without changing the browser receiver.

## WebSocket access boundary

Before `/ws` upgrades, the bridge requires exactly one `Host: 127.0.0.1:<bound-port>`
and one `Origin: http://127.0.0.1:<bound-port>`. Open the printed numeric loopback
URL; `localhost`, other aliases, foreign origins, `null`, missing Origin,
noncanonical values, and duplicate headers receive HTTP 403 with no stream.
The bound port is used even with `--port 0`; for HTTP port 80, both
headers omit `:80` to match browser serialization.

Nonbrowser clients must explicitly send the same Origin header as the served
page. There is no missing-Origin bypass. This protects against unrelated browser
pages; it does not authenticate local programs, which can forge these headers.
COOP/COEP response headers provide isolation, not WebSocket authorization.

### Bounded recorder admission and diagnostics

Pending PCM, including the write in progress, is limited to 64 MiB. A block
that would exceed this ceiling is refused before enqueue; admission stops
immediately and queued audio drains and closes through the lifecycle queue.
The manifest ends in `error`, with `admissionError` and no `stoppedAt`, preserving
committed audio for export/recovery without claiming complete capture.

Integrity arrays and native-input `events` retain at most 32 samples: the first
16 and most recent 16. Each owning object has `eventCounts` and `omittedCounts`
maps keyed by array name; totals remain exact and omissions equal total minus
retained samples. Status and offline inspection use totals. Historical manifests
without these maps still use array lengths. Recovery exports preserve integrity
samples and totals; any retained integrity failure still fails inspection.

default:
    @just --list

test:
    cargo fmt --check
    cargo check
    cargo test
    node --test
    node --check public/app.js
    node --check public/audio-worker.js
    node --check public/pcm-block.js
    node --check public/recorder.js
    node --check public/ring-buffer.js
    node --check public/wav.js
    node --check public/bridge-processor.js
    node --check scripts/browser-smoke.mjs
    node --check scripts/inspect-recording-manifest.mjs

inspect-recording manifest channels="14" sample_rate="48000" frames_per_block="960":
    node scripts/inspect-recording-manifest.mjs {{manifest}} --expect-channels {{channels}} --expect-sample-rate {{sample_rate}} --expect-frames-per-block {{frames_per_block}} --expect-native-drops-zero

smoke-browser monitor_ms="30000":
    SMOKE_MONITOR_MS={{monitor_ms}} node scripts/browser-smoke.mjs

smoke-l12 monitor_ms="30000" port="" frames_per_block="960" device="ZOOM" channels="14" sample_rate="48000":
    SMOKE_LABEL='L-12 browser smoke' SMOKE_SOURCE=input SMOKE_DEVICE='{{device}}' SMOKE_CHANNELS={{channels}} SMOKE_SAMPLE_RATE={{sample_rate}} SMOKE_FRAMES_PER_BLOCK={{frames_per_block}} SMOKE_MONITOR_MS={{monitor_ms}} SMOKE_PORT='{{port}}' node scripts/browser-smoke.mjs

list:
    cargo run -- list

serve-sine channels="12" sample_rate="48000" port="4545" frames_per_block="960":
    cargo run -- serve --source sine --channels {{channels}} --sample-rate {{sample_rate}} --port {{port}} --frames-per-block {{frames_per_block}}

serve-l12 port="4545" frames_per_block="960":
    cargo run -- serve --source input --device "ZOOM" --channels 14 --sample-rate 48000 --port {{port}} --frames-per-block {{frames_per_block}}

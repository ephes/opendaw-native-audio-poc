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
    node --check public/wav.js
    node --check public/bridge-processor.js

list:
    cargo run -- list

serve-sine channels="12" sample_rate="48000" port="4545" frames_per_block="960":
    cargo run -- serve --source sine --channels {{channels}} --sample-rate {{sample_rate}} --port {{port}} --frames-per-block {{frames_per_block}}

serve-l12 port="4545" frames_per_block="960":
    cargo run -- serve --source input --device "ZOOM" --channels 14 --sample-rate 48000 --port {{port}} --frames-per-block {{frames_per_block}}

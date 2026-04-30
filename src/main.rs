use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{SyncSender, TrySendError},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderValue, header},
    response::IntoResponse,
    routing::get,
};
use clap::{Parser, Subcommand, ValueEnum};
use cpal::{
    SampleFormat, SampleRate, Stream, StreamConfig,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::{net::TcpListener, sync::broadcast, time::Instant};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

const DEFAULT_PORT: u16 = 4545;
const DEFAULT_FRAMES_PER_BLOCK: u32 = 960;

#[derive(Parser, Debug)]
#[command(version, about = "openDAW native audio bridge PoC")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// List cpal input devices and supported input configs.
    List,
    /// Serve the browser test page and PCM WebSocket stream.
    Serve(ServeArgs),
}

#[derive(Parser, Debug, Clone)]
struct ServeArgs {
    #[arg(long, value_enum)]
    source: Source,
    #[arg(long)]
    device: Option<String>,
    #[arg(long, default_value_t = 12)]
    channels: u16,
    #[arg(long, default_value_t = 48_000)]
    sample_rate: u32,
    #[arg(long, default_value_t = DEFAULT_FRAMES_PER_BLOCK)]
    frames_per_block: u32,
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,
}

#[derive(Clone, Debug, ValueEnum)]
enum Source {
    Sine,
    Input,
}

#[derive(Clone)]
struct AppState {
    stream_info: StreamStarted,
    blocks: broadcast::Sender<Arc<AudioBlock>>,
}

#[derive(Clone, Debug)]
struct AudioBlock {
    frame_start: u64,
    frame_count: u32,
    channels: u16,
    samples: Vec<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamStarted {
    #[serde(rename = "type")]
    event_type: &'static str,
    sample_rate: u32,
    channels: u16,
    frames_per_block: u32,
    sample_format: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamError<'a> {
    #[serde(rename = "type")]
    event_type: &'static str,
    code: &'a str,
    message: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::List => list_devices(),
        Command::Serve(args) => serve(args).await,
    }
}

fn list_devices() -> Result<()> {
    let host = cpal::default_host();
    println!("Host: {}", host.id().name());

    let default_input_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());

    let mut devices = host
        .input_devices()
        .context("failed to enumerate input devices")?
        .peekable();

    if devices.peek().is_none() {
        println!("No input devices found.");
        return Ok(());
    }

    for (index, device) in devices.enumerate() {
        let name = device
            .name()
            .unwrap_or_else(|error| format!("<unavailable name: {error}>"));
        let default_marker = if default_input_name.as_deref() == Some(name.as_str()) {
            " (default)"
        } else {
            ""
        };

        println!();
        println!("Input device {index}: {name}{default_marker}");

        match device.supported_input_configs() {
            Ok(configs) => {
                let mut any = false;
                for config in configs {
                    any = true;
                    println!(
                        "  channels: {:>2}, format: {:>4}, sample rates: {}..{} Hz",
                        config.channels(),
                        config.sample_format(),
                        config.min_sample_rate().0,
                        config.max_sample_rate().0
                    );
                }
                if !any {
                    println!("  No supported input configs reported.");
                }
            }
            Err(error) => {
                println!("  Could not read supported input configs: {error}");
            }
        }
    }

    Ok(())
}

async fn serve(args: ServeArgs) -> Result<()> {
    validate_serve_args(&args)?;
    if matches!(args.source, Source::Sine) && args.device.is_some() {
        eprintln!("Warning: --device is ignored when --source sine is selected");
    }

    let (block_tx, _) = broadcast::channel::<Arc<AudioBlock>>(256);
    let stream_info = StreamStarted {
        event_type: "stream-started",
        sample_rate: args.sample_rate,
        channels: args.channels,
        frames_per_block: args.frames_per_block,
        sample_format: "f32-interleaved",
    };

    let _input_stream = match args.source {
        Source::Sine => {
            spawn_sine_source(args.clone(), block_tx.clone());
            None
        }
        Source::Input => Some(start_input_source(args.clone(), block_tx.clone())?),
    };

    let state = AppState {
        stream_info,
        blocks: block_tx,
    };
    let public_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("public");
    let app = Router::new()
        .route("/ws", get(ws_handler))
        .fallback_service(ServeDir::new(&public_dir))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-embedder-policy"),
            HeaderValue::from_static("require-corp"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        ))
        .with_state(state);

    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, args.port));
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind http server on http://{addr}"))?;

    println!(
        "Serving {}-channel {:?} stream at {} Hz on http://{}",
        args.channels, args.source, args.sample_rate, addr
    );
    println!("WebSocket endpoint: ws://{addr}/ws");

    axum::serve(listener, app).await.context("server failed")
}

fn validate_serve_args(args: &ServeArgs) -> Result<()> {
    if args.channels == 0 {
        bail!("--channels must be greater than zero");
    }
    if args.sample_rate == 0 {
        bail!("--sample-rate must be greater than zero");
    }
    if args.frames_per_block == 0 {
        bail!("--frames-per-block must be greater than zero");
    }
    Ok(())
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| websocket_stream(socket, state))
}

async fn websocket_stream(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut blocks = state.blocks.subscribe();

    let Ok(started) = serde_json::to_string(&state.stream_info) else {
        return;
    };
    if sender.send(Message::Text(started.into())).await.is_err() {
        return;
    }

    let drain_client_messages =
        tokio::spawn(async move { while receiver.next().await.is_some() {} });

    loop {
        match blocks.recv().await {
            Ok(block) => {
                let payload = encode_pcm_block(&block);
                if sender.send(Message::Binary(payload.into())).await.is_err() {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                let error = StreamError {
                    event_type: "stream-error",
                    code: "server-client-lagged",
                    message: format!("WebSocket client skipped {skipped} audio blocks"),
                };
                if let Ok(json) = serde_json::to_string(&error) {
                    let _ = sender.send(Message::Text(json.into())).await;
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }

    drain_client_messages.abort();
}

fn spawn_sine_source(args: ServeArgs, block_tx: broadcast::Sender<Arc<AudioBlock>>) {
    tokio::spawn(async move {
        let channels = usize::from(args.channels);
        let frames_per_block = args.frames_per_block as usize;
        let mut phases = vec![0.0_f32; channels];
        let mut frame_start = 0_u64;
        let mut next_tick = Instant::now();
        let block_duration =
            Duration::from_secs_f64(f64::from(args.frames_per_block) / f64::from(args.sample_rate));

        loop {
            let mut samples = Vec::with_capacity(frames_per_block * channels);
            for frame in 0..frames_per_block {
                for (channel, phase) in phases.iter_mut().enumerate() {
                    let frequency = 110.0 + (channel as f32 * 37.0);
                    let sine = (std::f32::consts::TAU * *phase).sin();
                    let noise = deterministic_noise(frame_start + frame as u64, channel as u64);
                    let gain = 0.12 + (channel % 4) as f32 * 0.025;
                    samples.push((sine * gain) + (noise * 0.015));

                    *phase += frequency / args.sample_rate as f32;
                    if *phase >= 1.0 {
                        *phase -= phase.floor();
                    }
                }
            }

            let block = Arc::new(AudioBlock {
                frame_start,
                frame_count: args.frames_per_block,
                channels: args.channels,
                samples,
            });
            let _ = block_tx.send(block);
            frame_start += u64::from(args.frames_per_block);

            next_tick += block_duration;
            tokio::time::sleep_until(next_tick).await;
        }
    });
}

fn deterministic_noise(frame: u64, channel: u64) -> f32 {
    let mut value = frame
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add(channel.wrapping_mul(0xBF58_476D_1CE4_E5B9));
    value ^= value >> 30;
    value = value.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94D0_49BB_1331_11EB);
    value ^= value >> 31;
    ((value as u32) as f32 / u32::MAX as f32) * 2.0 - 1.0
}

fn start_input_source(
    args: ServeArgs,
    block_tx: broadcast::Sender<Arc<AudioBlock>>,
) -> Result<Stream> {
    let host = cpal::default_host();
    let device = select_input_device(&host, args.device.as_deref())?;
    let device_name = device.name().unwrap_or_else(|_| "unknown".to_string());
    let supported_config = find_supported_input_config(&device, args.channels, args.sample_rate)
        .with_context(|| {
            format!(
                "input device '{device_name}' does not report {} channels at {} Hz",
                args.channels, args.sample_rate
            )
        })?;
    let sample_format = supported_config.sample_format();
    let stream_config = StreamConfig {
        channels: args.channels,
        sample_rate: SampleRate(args.sample_rate),
        buffer_size: cpal::BufferSize::Default,
    };
    let (sample_tx, sample_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(64);
    let dropped_callback_buffers = Arc::new(AtomicU64::new(0));
    let err_fn = move |error| {
        eprintln!("Input stream error: {error}");
    };

    // First-slice callback path: allocation is acceptable for this PoC, but it is
    // not the shape to keep if this backend becomes a real low-latency recorder.
    // The borrowed cpal buffer must be owned before try_send can reveal backpressure,
    // so a full queue still pays this allocation cost before the drop is counted.
    let stream = match sample_format {
        SampleFormat::F32 => {
            let dropped = dropped_callback_buffers.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    send_input_samples(&sample_tx, data.to_vec(), &dropped);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::I16 => {
            let dropped = dropped_callback_buffers.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let samples = data
                        .iter()
                        .map(|sample| *sample as f32 / i16::MAX as f32)
                        .collect();
                    send_input_samples(&sample_tx, samples, &dropped);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::U16 => {
            let dropped = dropped_callback_buffers.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let samples = data
                        .iter()
                        .map(|sample| (*sample as f32 - 32767.5) / 32767.5)
                        .collect();
                    send_input_samples(&sample_tx, samples, &dropped);
                },
                err_fn,
                None,
            )?
        }
        other => {
            bail!("unsupported input sample format for first slice: {other}");
        }
    };

    stream
        .play()
        .with_context(|| format!("failed to start input stream for '{device_name}'"))?;
    println!(
        "Opened input device '{device_name}' with {} channels at {} Hz ({sample_format})",
        args.channels, args.sample_rate
    );

    std::thread::spawn(move || {
        aggregate_input_blocks(sample_rx, block_tx, args.channels, args.frames_per_block);
    });

    Ok(stream)
}

fn send_input_samples(
    sample_tx: &SyncSender<Vec<f32>>,
    samples: Vec<f32>,
    dropped_callback_buffers: &AtomicU64,
) {
    match sample_tx.try_send(samples) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            let dropped = dropped_callback_buffers.fetch_add(1, Ordering::Relaxed) + 1;
            if dropped == 1 || dropped.is_power_of_two() {
                eprintln!(
                    "Input callback dropped {dropped} buffers because the bridge queue is full"
                );
            }
        }
        Err(TrySendError::Disconnected(_)) => {
            let dropped = dropped_callback_buffers.fetch_add(1, Ordering::Relaxed) + 1;
            if dropped == 1 {
                eprintln!(
                    "Input callback cannot forward buffers because the bridge queue is closed"
                );
            }
        }
    }
}

fn select_input_device(host: &cpal::Host, needle: Option<&str>) -> Result<cpal::Device> {
    if let Some(needle) = needle {
        let needle = needle.to_lowercase();
        for device in host.input_devices()? {
            let name = device.name().unwrap_or_default();
            if name.to_lowercase().contains(&needle) {
                return Ok(device);
            }
        }
        bail!("no input device name contains '{needle}'");
    }

    host.default_input_device()
        .ok_or_else(|| anyhow!("no default input device available"))
}

fn find_supported_input_config(
    device: &cpal::Device,
    channels: u16,
    sample_rate: u32,
) -> Result<cpal::SupportedStreamConfigRange> {
    let mut candidates = Vec::new();
    for config in device.supported_input_configs()? {
        if config.channels() == channels
            && config.min_sample_rate().0 <= sample_rate
            && config.max_sample_rate().0 >= sample_rate
        {
            candidates.push(config);
        }
    }

    candidates
        .into_iter()
        .find(|config| config.sample_format() == SampleFormat::F32)
        .or_else(|| {
            device
                .supported_input_configs()
                .ok()?
                .filter(|config| {
                    config.channels() == channels
                        && config.min_sample_rate().0 <= sample_rate
                        && config.max_sample_rate().0 >= sample_rate
                })
                .find(|config| {
                    matches!(
                        config.sample_format(),
                        SampleFormat::I16 | SampleFormat::U16
                    )
                })
        })
        .ok_or_else(|| {
            anyhow!("no f32/i16/u16 input config for {channels} channels at {sample_rate} Hz")
        })
}

fn aggregate_input_blocks(
    sample_rx: std::sync::mpsc::Receiver<Vec<f32>>,
    block_tx: broadcast::Sender<Arc<AudioBlock>>,
    channels: u16,
    frames_per_block: u32,
) {
    let block_samples = usize::from(channels) * frames_per_block as usize;
    let mut pending = Vec::with_capacity(block_samples * 2);
    let mut frame_start = 0_u64;

    while let Ok(mut samples) = sample_rx.recv() {
        pending.append(&mut samples);
        while pending.len() >= block_samples {
            let samples: Vec<f32> = pending.drain(0..block_samples).collect();
            let block = Arc::new(AudioBlock {
                frame_start,
                frame_count: frames_per_block,
                channels,
                samples,
            });
            let _ = block_tx.send(block);
            frame_start += u64::from(frames_per_block);
        }
    }
}

fn encode_pcm_block(block: &AudioBlock) -> Vec<u8> {
    let mut payload = Vec::with_capacity(16 + block.samples.len() * size_of::<f32>());
    payload.extend_from_slice(&block.frame_start.to_le_bytes());
    payload.extend_from_slice(&block.frame_count.to_le_bytes());
    payload.extend_from_slice(&block.channels.to_le_bytes());
    payload.extend_from_slice(&0_u16.to_le_bytes());
    for sample in &block.samples {
        payload.extend_from_slice(&sample.to_le_bytes());
    }
    payload
}

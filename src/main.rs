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
use tokio::{
    net::TcpListener,
    sync::broadcast,
    task::JoinHandle,
    time::{Instant, MissedTickBehavior},
};
use tower_http::{services::ServeDir, set_header::SetResponseHeaderLayer};

const DEFAULT_PORT: u16 = 4545;
const DEFAULT_FRAMES_PER_BLOCK: u32 = 960;
const PCM_BROADCAST_QUEUE_CAPACITY_BLOCKS: usize = 256;
const INPUT_BRIDGE_QUEUE_CAPACITY_BLOCKS: usize = 64;
const NATIVE_STATS_INTERVAL: Duration = Duration::from_secs(1);

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

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Source {
    Sine,
    Input,
}

#[derive(Clone)]
struct AppState {
    stream_info: StreamStarted,
    blocks: broadcast::Sender<Arc<AudioBlock>>,
    native_stats: Arc<NativeInputStats>,
}

struct SourceRuntime {
    input_stream: Option<Stream>,
    sine_task: Option<JoinHandle<()>>,
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

#[derive(Debug)]
struct NativeInputStats {
    source: &'static str,
    bridge_queue_capacity_blocks: u64,
    native_dropped_blocks: AtomicU64,
    native_dropped_frames: AtomicU64,
    native_drop_events: AtomicU64,
    at_frame: AtomicU64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeInputStatsEvent {
    #[serde(rename = "type")]
    event_type: &'static str,
    source: &'static str,
    native_dropped_blocks: u64,
    native_dropped_frames: u64,
    native_drop_events: u64,
    bridge_queue_capacity_blocks: u64,
    at_frame: u64,
}

impl NativeInputStats {
    fn new(source: Source, bridge_queue_capacity_blocks: u64) -> Self {
        Self {
            source: source.protocol_name(),
            bridge_queue_capacity_blocks,
            native_dropped_blocks: AtomicU64::new(0),
            native_dropped_frames: AtomicU64::new(0),
            native_drop_events: AtomicU64::new(0),
            at_frame: AtomicU64::new(0),
        }
    }

    fn advance_to_frame(&self, at_frame: u64) {
        self.at_frame.store(at_frame, Ordering::Relaxed);
    }

    fn advance_by_frames(&self, frames: u64) -> u64 {
        self.at_frame.fetch_add(frames, Ordering::Relaxed) + frames
    }

    fn note_dropped_callback_buffer(&self, frames: u64) -> u64 {
        self.native_dropped_blocks.fetch_add(1, Ordering::Relaxed);
        self.native_dropped_frames
            .fetch_add(frames, Ordering::Relaxed);
        self.native_drop_events.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn snapshot(&self) -> NativeInputStatsEvent {
        NativeInputStatsEvent {
            event_type: "native-input-stats",
            source: self.source,
            native_dropped_blocks: self.native_dropped_blocks.load(Ordering::Relaxed),
            native_dropped_frames: self.native_dropped_frames.load(Ordering::Relaxed),
            native_drop_events: self.native_drop_events.load(Ordering::Relaxed),
            bridge_queue_capacity_blocks: self.bridge_queue_capacity_blocks,
            at_frame: self.at_frame.load(Ordering::Relaxed),
        }
    }
}

impl Source {
    fn protocol_name(self) -> &'static str {
        match self {
            Source::Sine => "sine",
            Source::Input => "input",
        }
    }
}

impl Drop for SourceRuntime {
    fn drop(&mut self) {
        if let Some(task) = &self.sine_task {
            task.abort();
        }
    }
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

    let (app, source_runtime) = build_app(args.clone())?;
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, args.port));
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("failed to bind http server on http://{addr}"))?;

    println!(
        "Serving {}-channel {:?} stream at {} Hz on http://{}",
        args.channels, args.source, args.sample_rate, addr
    );
    println!("WebSocket endpoint: ws://{addr}/ws");

    let result = axum::serve(listener, app).await.context("server failed");
    drop(source_runtime);
    result
}

fn build_app(args: ServeArgs) -> Result<(Router, SourceRuntime)> {
    let (block_tx, _) = broadcast::channel::<Arc<AudioBlock>>(PCM_BROADCAST_QUEUE_CAPACITY_BLOCKS);
    let native_stats = Arc::new(NativeInputStats::new(
        args.source,
        match args.source {
            Source::Sine => 0,
            Source::Input => INPUT_BRIDGE_QUEUE_CAPACITY_BLOCKS as u64,
        },
    ));
    let stream_info = StreamStarted {
        event_type: "stream-started",
        sample_rate: args.sample_rate,
        channels: args.channels,
        frames_per_block: args.frames_per_block,
        sample_format: "f32-interleaved",
    };

    let mut source_runtime = SourceRuntime {
        input_stream: None,
        sine_task: None,
    };
    match args.source {
        Source::Sine => {
            source_runtime.sine_task = Some(spawn_sine_source(
                args.clone(),
                block_tx.clone(),
                native_stats.clone(),
            ));
        }
        Source::Input => {
            source_runtime.input_stream = Some(start_input_source(
                args.clone(),
                block_tx.clone(),
                native_stats.clone(),
            )?);
        }
    };

    let state = AppState {
        stream_info,
        blocks: block_tx,
        native_stats,
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

    Ok((app, source_runtime))
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
    if send_native_stats(&mut sender, &state.native_stats)
        .await
        .is_err()
    {
        return;
    }

    let drain_client_messages =
        tokio::spawn(async move { while receiver.next().await.is_some() {} });

    let mut stats_interval = tokio::time::interval_at(
        Instant::now() + NATIVE_STATS_INTERVAL,
        NATIVE_STATS_INTERVAL,
    );
    stats_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = stats_interval.tick() => {
                if send_native_stats(&mut sender, &state.native_stats).await.is_err() {
                    break;
                }
            }
            result = blocks.recv() => {
                match result {
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
        }
    }

    drain_client_messages.abort();
}

async fn send_native_stats(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    stats: &NativeInputStats,
) -> Result<(), axum::Error> {
    match serde_json::to_string(&stats.snapshot()) {
        Ok(json) => sender.send(Message::Text(json.into())).await,
        Err(error) => {
            eprintln!("Failed to serialize native input stats: {error}");
            Ok(())
        }
    }
}

fn spawn_sine_source(
    args: ServeArgs,
    block_tx: broadcast::Sender<Arc<AudioBlock>>,
    native_stats: Arc<NativeInputStats>,
) -> JoinHandle<()> {
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
            native_stats.advance_to_frame(frame_start);

            next_tick += block_duration;
            tokio::time::sleep_until(next_tick).await;
        }
    })
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
    native_stats: Arc<NativeInputStats>,
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
    let (sample_tx, sample_rx) =
        std::sync::mpsc::sync_channel::<Vec<f32>>(INPUT_BRIDGE_QUEUE_CAPACITY_BLOCKS);
    let err_fn = move |error| {
        eprintln!("Input stream error: {error}");
    };

    // First-slice callback path: allocation is acceptable for this PoC, but it is
    // not the shape to keep if this backend becomes a real low-latency recorder.
    // The borrowed cpal buffer must be owned before try_send can reveal backpressure,
    // so a full queue still pays this allocation cost before the drop is counted.
    let stream = match sample_format {
        SampleFormat::F32 => {
            let stats = native_stats.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _| {
                    send_input_samples(&sample_tx, data.to_vec(), args.channels, &stats);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::I16 => {
            let stats = native_stats.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _| {
                    let samples = data
                        .iter()
                        .map(|sample| *sample as f32 / i16::MAX as f32)
                        .collect();
                    send_input_samples(&sample_tx, samples, args.channels, &stats);
                },
                err_fn,
                None,
            )?
        }
        SampleFormat::U16 => {
            let stats = native_stats.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[u16], _| {
                    let samples = data
                        .iter()
                        .map(|sample| (*sample as f32 - 32767.5) / 32767.5)
                        .collect();
                    send_input_samples(&sample_tx, samples, args.channels, &stats);
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
    channels: u16,
    native_stats: &NativeInputStats,
) {
    let frames = samples.len() as u64 / u64::from(channels);
    let at_frame = native_stats.advance_by_frames(frames);
    match sample_tx.try_send(samples) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) => {
            let dropped = native_stats.note_dropped_callback_buffer(frames);
            if dropped == 1 || dropped.is_power_of_two() {
                eprintln!(
                    "Input callback dropped {dropped} buffers ({at_frame} latest input frames) because the bridge queue is full"
                );
            }
        }
        Err(TrySendError::Disconnected(_)) => {
            let dropped = native_stats.note_dropped_callback_buffer(frames);
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

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{Stream as WsStream, StreamExt};
    use serde_json::Value;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{Error as WsError, Message as ClientMessage},
    };

    #[tokio::test]
    async fn sine_websocket_protocol_starts_with_stats_and_pcm_block() {
        let args = ServeArgs {
            source: Source::Sine,
            device: None,
            channels: 2,
            sample_rate: 48_000,
            frames_per_block: 64,
            // The test binds its own ephemeral listener directly.
            port: 0,
        };
        let (app, source_runtime) = build_app(args.clone()).expect("sine app should build");
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("ephemeral listener should bind");
        let addr = listener.local_addr().expect("listener should have address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("test server should run");
        });

        let (mut socket, _) = connect_async(format!("ws://{addr}/ws"))
            .await
            .expect("websocket should connect");

        let started = message_text_json(recv_ws_message(&mut socket).await);
        assert_eq!(
            started.get("type").and_then(Value::as_str),
            Some("stream-started")
        );
        assert_eq!(
            started.get("sampleRate").and_then(Value::as_u64),
            Some(u64::from(args.sample_rate))
        );
        assert_eq!(
            started.get("channels").and_then(Value::as_u64),
            Some(u64::from(args.channels))
        );
        assert_eq!(
            started.get("framesPerBlock").and_then(Value::as_u64),
            Some(u64::from(args.frames_per_block))
        );
        assert_eq!(
            started.get("sampleFormat").and_then(Value::as_str),
            Some("f32-interleaved")
        );

        let stats = message_text_json(recv_ws_message(&mut socket).await);
        assert_eq!(
            stats.get("type").and_then(Value::as_str),
            Some("native-input-stats")
        );
        assert_eq!(stats.get("source").and_then(Value::as_str), Some("sine"));
        assert_eq!(
            stats.get("nativeDroppedBlocks").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            stats.get("nativeDroppedFrames").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            stats.get("nativeDropEvents").and_then(Value::as_u64),
            Some(0)
        );
        assert_eq!(
            stats
                .get("bridgeQueueCapacityBlocks")
                .and_then(Value::as_u64),
            Some(0)
        );
        assert!(
            stats.get("atFrame").and_then(Value::as_u64).is_some(),
            "sine stats should include a non-negative atFrame"
        );

        let duplicate_stats_deadline = tokio::time::Instant::now() + Duration::from_millis(250);
        let mut saw_pcm_block = false;
        loop {
            match tokio::time::timeout_at(duplicate_stats_deadline, socket.next()).await {
                Ok(Some(Ok(ClientMessage::Binary(payload)))) => {
                    assert_pcm_block(&payload, args.frames_per_block, args.channels);
                    saw_pcm_block = true;
                }
                Ok(Some(Ok(ClientMessage::Text(text)))) => {
                    let event: Value =
                        serde_json::from_str(text.as_ref()).expect("text event should be JSON");
                    let event_type = event.get("type").and_then(Value::as_str);
                    assert_ne!(
                        event_type,
                        Some("native-input-stats"),
                        "native-input-stats should not repeat before the periodic interval"
                    );
                    assert_ne!(
                        event_type,
                        Some("stream-error"),
                        "test client should not lag the websocket stream"
                    );
                }
                Ok(Some(Ok(ClientMessage::Ping(_))) | Some(Ok(ClientMessage::Pong(_)))) => {}
                Ok(Some(Ok(other))) => panic!("unexpected websocket message: {other:?}"),
                Ok(Some(Err(error))) => panic!("websocket receive failed: {error}"),
                Ok(None) => panic!("websocket closed before protocol assertions completed"),
                Err(_) => break,
            }
        }
        assert!(saw_pcm_block, "expected at least one PCM binary block");

        let mut saw_periodic_stats = false;
        let periodic_stats_deadline = tokio::time::Instant::now() + Duration::from_millis(1_500);
        loop {
            match tokio::time::timeout_at(periodic_stats_deadline, socket.next()).await {
                Ok(Some(Ok(ClientMessage::Text(text)))) => {
                    let event: Value =
                        serde_json::from_str(text.as_ref()).expect("text event should be JSON");
                    if event.get("type").and_then(Value::as_str) == Some("native-input-stats") {
                        assert_eq!(event.get("source").and_then(Value::as_str), Some("sine"));
                        saw_periodic_stats = true;
                        break;
                    }
                }
                Ok(Some(Ok(ClientMessage::Binary(payload)))) => {
                    assert_pcm_block(&payload, args.frames_per_block, args.channels);
                }
                Ok(Some(Ok(ClientMessage::Ping(_))) | Some(Ok(ClientMessage::Pong(_)))) => {}
                Ok(Some(Ok(other))) => panic!("unexpected websocket message: {other:?}"),
                Ok(Some(Err(error))) => panic!("websocket receive failed: {error}"),
                Ok(None) => panic!("websocket closed before periodic stats assertion completed"),
                Err(_) => break,
            }
        }
        assert!(
            saw_periodic_stats,
            "expected a periodic native-input-stats event after startup"
        );

        server.abort();
        let _ = server.await;
        drop(source_runtime);
    }

    async fn recv_ws_message<S>(socket: &mut S) -> ClientMessage
    where
        S: WsStream<Item = std::result::Result<ClientMessage, WsError>> + Unpin,
    {
        tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .expect("timed out waiting for websocket message")
            .expect("websocket closed")
            .expect("websocket receive failed")
    }

    fn message_text_json(message: ClientMessage) -> Value {
        match message {
            ClientMessage::Text(text) => {
                serde_json::from_str(text.as_ref()).expect("text message should be JSON")
            }
            other => panic!("expected text websocket message, got {other:?}"),
        }
    }

    fn assert_pcm_block(payload: &[u8], frames_per_block: u32, channels: u16) {
        assert!(
            payload.len() >= 16,
            "PCM block should include the 16-byte header"
        );

        let frame_start = u64::from_le_bytes(payload[0..8].try_into().unwrap());
        let frame_count = u32::from_le_bytes(payload[8..12].try_into().unwrap());
        let channel_count = u16::from_le_bytes(payload[12..14].try_into().unwrap());
        let reserved = u16::from_le_bytes(payload[14..16].try_into().unwrap());

        assert_eq!(frame_count, frames_per_block);
        assert_eq!(channel_count, channels);
        assert_eq!(reserved, 0);
        assert_eq!(frame_start % u64::from(frames_per_block), 0);
        assert_eq!(
            payload.len(),
            16 + frame_count as usize * usize::from(channel_count) * size_of::<f32>()
        );

        for sample in payload[16..].chunks_exact(size_of::<f32>()) {
            let value = f32::from_le_bytes(sample.try_into().unwrap());
            assert!(value.is_finite(), "PCM sample should be a finite Float32");
        }
    }
}

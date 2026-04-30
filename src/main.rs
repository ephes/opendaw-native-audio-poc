fn main() {
    println!("openDAW native audio bridge PoC");
    println!();
    println!("Planned commands:");
    println!("  list");
    println!("    Enumerate CoreAudio/cpal input devices and supported configs.");
    println!("  serve --source sine|input");
    println!("    Stream interleaved Float32 PCM blocks to a browser AudioWorklet test page.");
    println!();
    println!("See README.md and docs/protocol.md for the implementation scope.");
}

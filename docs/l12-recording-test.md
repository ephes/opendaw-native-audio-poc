# L-12 Recording Reliability Test Notes

Use this file as a repeatable manual checklist for browser-side recording tests with the ZOOM LiveTrak L-12.

See the README Browser Recording Mode section for the full workflow and artifact format. If `127.0.0.1:4545` is already in use, start the server with another port, for example `--port 4546`, and open that URL instead. Prefer starting monitor playback before recording when monitor counters matter; starting monitor during recording intentionally resets and rebases underrun/overflow deltas.

## Setup

- Date:
- Browser and version:
- macOS version:
- Device name from `cargo run -- list`:
- Command:

  ```sh
  cargo run -- serve --source input --device "ZOOM" --channels 14 --sample-rate 48000
  ```

- Browser storage persistence granted: yes/no
- Monitor enabled: yes/no
- Monitor pair:

## Short Test

- Duration:
- Channels reported:
- Sample rate reported:
- Recorded frames:
- Recorded blocks / received blocks:
- Expected next frame:
- Chunks / bytes:
- Gaps:
- Overlaps:
- Discontinuities:
- Counter resets:
- Write-backlog events:
- Backlog high-water:
- Underruns during recording:
- Overflows during recording:
- WebSocket lag events:
- Storage or export errors:
- Exported manifest filename:
- Exported WAV channel(s):
- DAW/import result:

## Long Test

- Target duration:
- Actual duration:
- Recorded frames:
- Chunks / bytes:
- Gaps:
- Overlaps:
- Discontinuities:
- Counter resets:
- Write-backlog events:
- Backlog high-water:
- Underruns during recording:
- Overflows during recording:
- WebSocket lag events:
- Storage or export errors:
- DAW/import result:

## Recovery Test

- Failure simulated by: reload/tab close/browser quit
- Recording duration before failure:
- Chunks expected before failure:
- Reopened page listed abandoned session: yes/no
- Recovery state shown:
- Recovery warnings:
- Reconstructed channels / sample rate / frames-per-block:
- Reconstructed frames:
- Reconstructed chunks / bytes:
- Exported recovery manifest filename:
- Exported recovered WAV channel(s):
- WAV export result:
- Deleted recovered session: yes/no
- Scan after delete lists session: yes/no

## Channel Mapping Notes

- Channel 1 source:
- Channel 9 source:
- Channel 13 source:
- Observed alignment or drift:

## Follow-Up

- Issues found:
- Next action:

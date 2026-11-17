# Changelog

## Unreleased

- Bound native PCM broadcast retention by a checked 256 MiB fanout budget, including producer and eight-client raw/encoding/socket headroom; round queue capacity down and release raw PCM before bounded socket sends. Large blocks retain fewer than 256 queued blocks, with existing lag/deadline behavior.

- Fence page/Worker connection commands and replies by generation, retiring already-posted stream buffers/state on Disconnect without discarding recovery or recording messages.
- Settle WebSocket constructor refusal as a fixed retryable connection error before retiring the previous transport, preserving Worker recovery/recording ownership.
- Deliver the bridge's `device-lost` explanation on the terminal `socket-state` so the connection-generation fence does not hide it from the page.
- Bound handshake plus first valid stream configuration with one ten-second startup deadline; detach retired socket listeners and allow explicit retry after timeout.
- Preserve the selected recovery WAV channel across inventory refreshes for the same session/channel count; reset on changed geometry or session identity.

- Fence already-posted recovery results at page delivery and retain export/download errors after terminal pending-state updates.

- Report export failures as `export-error` so a retained export error yields to later recorder state changes and errors, and drop native stats that arrive before stream configuration without a false integrity error.

- Require unique session-owned inspector chunk identities and bound aggregate inspection work and retained diagnostics, reporting omitted counts without losing failed verdicts.

- Refuse unsupported inspector manifest versions and retain OPFS manifests with incompatible schema/session identity as fatal read-only recovery entries.

- Retain observed native loss on counter regression; advertise the acquisition source in stream-started and refuse mismatched source/regressing cursor stats before evidence mutation.

- Admit one pending export across controls/Worker and validate WAV scalar geometry and exact binary payload size before Blob construction.

- Fence recovery scans/deletions by ordered generations and clean up download URLs/anchors even when activation fails.

- Limit native WebSocket fanout to eight admitted/pending clients; reject excess trusted handshakes with HTTP 503 before subscribing to PCM, and release permits after failed upgrades or complete connection teardown, including cancellation.

- Admit current and recovered selected-channel WAV exports within a 256 MiB working-memory envelope before reading PCM; include mono retention, Blob-copy headroom and the largest multichannel source chunk, and preserve raw OPFS audio on refusal.

- Refuse duplicate persisted JSON object names, including escaped equivalents, before recovery decoding; keep ambiguous inventories incomplete and preserve original files without export/deletion authorization.

- Bound aggregate recovery metadata reads and retained block descriptions across all sessions; mark exhausted inventories incomplete while preserving files. Sessions read before exhaustion stay exportable, later sessions are listed from names only, and deletion (which needs only the name inventory) remains possible to free budget.

- Propagate CPAL callback faults through a bounded retained notification to terminal `device-lost` delivery and recorder interruption, preserving committed audio, retiring the page monitor and allowing explicit reconnect after bridge restart.

- Fence retired monitor messages and processor faults; close failed processors once and permit a fresh monitor retry, including faults during resume.

- Retire crashed/message-corrupt Workers and monitors once, release pending UI controls, ignore stale messages and offer a fresh OPFS recovery scan.
- Add opt-in `just smoke-opfs-recovery`: kill synthetic recording Workers at real PCM/sidecar/manifest publication barriers, verify trusted metadata prefix, preserved audio/writer release, and a corruption negative control. No new CI jobs.

- Commit timeline/gap evidence only after PCM writes succeed and retain a bounded storage-write diagnostic; reject nonfinite persisted samples in current and recovered selected-channel WAV exports without modifying audio.

- Abort failed chunk-sidecar and manifest writers; retain one pending closed chunk for checkpoint retries through Export Manifest (or a programmatic stop/interrupt) without duplicating PCM or claiming clean completion.

- Protect unreadable or malformed recording catalogs from Start/Reset/Delete mutations; keep artifact recovery available. Start refuses a read-only or full catalog before creating any session or artifact; an active recording keeps capturing and stops cleanly when the catalog becomes read-only, recording skipped index updates as manifest `indexWarnings`. Document the manual save-and-move-aside procedure.
- Report incomplete recovery inventories with their own `scan-incomplete` warning code instead of `index-warning`.
- Validate index write size, session count and nesting against recovery read budgets before opening a writable.

- Keep unknown index types/versions read-only and retain version-1 extension metadata.
- Bound recovery directory enumeration and the session union; surface incomplete scans and refuse deletion from them.
- Read only the selected session’s recovery metadata/audio during export while retaining bounded orphan-tail discovery and changed/missing-chunk checks.
- Drain all Delete/Reset removals before releasing lifecycle ownership; report retained filenames and allow idempotent retries.
- Add a real-browser synthetic OPFS record/reload/recover/export/delete smoke (synthetic source only; the L-12 smoke stays monitor-only).

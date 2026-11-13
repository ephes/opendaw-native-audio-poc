# Changelog

## Unreleased

- Protect unreadable or malformed recording catalogs from Start/Reset/Delete mutations; keep artifact recovery available.
- Validate index write size, session count and nesting against recovery read budgets before opening a writable.

- Keep unknown index types/versions read-only and retain version-1 extension metadata.
- Bound recovery directory enumeration and the session union; surface incomplete scans and refuse deletion from them.
- Read only the selected session’s recovery metadata/audio during export while retaining bounded orphan-tail discovery and changed/missing-chunk checks.
- Drain all Delete/Reset removals before releasing lifecycle ownership; report retained filenames and allow idempotent retries.
- Add a real-browser synthetic OPFS record/reload/recover/export/delete smoke.

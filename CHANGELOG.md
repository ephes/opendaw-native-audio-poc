# Changelog

## Unreleased

- Protect unreadable or malformed recording catalogs from Start/Reset/Delete mutations; keep artifact recovery available.
- Validate index write size, session count and nesting against recovery read budgets before opening a writable.

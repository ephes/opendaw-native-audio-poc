# Round 84 resume note

Parked 2026-11-08 on `fix/r84-b12-bounded-recording`, based on main
`40788117ef151fba87ed9429b4ae20908539e28a`.

## B12 implemented, awaiting review and browser validation

- `native-recorder-pending-pcm-hard-ceiling`: 64 MiB admission ceiling,
  immediate refusal on overflow, queued writes drained and closed, terminal
  error manifest without stoppedAt; committed chunks preserved.
- `native-recorder-bounded-integrity-event-samples`: first 16/recent 16
  diagnostic samples, exact event/omitted totals, compatible inspector and
  recovered integrity evidence.
- Both new regressions failed on unchanged main before the fixes: pending
  bytes exceeded the ceiling and diagnostic samples grew beyond 32.
- `just test` passed: Rust fmt/check/clippy, 10 Rust tests, 121 Node tests,
  all configured JavaScript syntax checks. Clippy reports existing warnings.
- `just smoke-browser` failed: timed out waiting for Chrome page target.
  Browser behavior remains unverified; do not substitute GitHub Actions.
- Opus review requested through the installed claude-review-loop harness with
  `--model claude-opus-5-5 --effort high`; no review verdict was produced:
  `Failed to authenticate: OAuth session expired and could not be refreshed`.
  Local artifacts: `/private/tmp/r84-b12-review1/result.json`,
  `/private/tmp/r84-b12-checks.log`, `/private/tmp/r84-b12-browser.log`.

Restore Claude authentication and resolve local Chrome availability. Run the
full B12 review with a fresh run directory, then follow the owner's fix/review
rules. Fetch immediately before any merge, rebase if main moved, rerun local
checks after rebasing and after the no-ff merge, and push only main once clean.
No merges, default-branch pushes, deployments, releases, tags, PRs, or Actions
commands were performed in this session. The feature branch is pushed solely
to park unfinished work under the explicit OAuth-failure exception.

## Remaining bundles, not implemented

Read the full descriptions and validation map in
`~/workspaces/ws-work-planning/reviews/scout-round84.md`; re-verify each against
current main and skip exact fixes already present. Maintain this order:

1. B13: `native-manifest-checkpoint-linear-history-work` then
   `native-recovery-json-before-materialization-budget`.
2. B14: `native-wav-channel-integer-admission` then
   `native-recording-counter-reset-total-preservation`.

Use synthetic fixtures and platform-independent tests, update README/protocol,
keep legacy recovery compatible, and run local `just test` plus synthetic
browser smoke for browser behavior changes. Do not use paid Actions or host
access, and never write under ~/projects.

**0.4.9 — complete-history recovery and private checkpoint workers**

Compaction preserves every message after the checkpoint boundary and at least
`recentTurns` whole recent rounds. These intervals may overlap. Only the
checkpoint's covered prefix must match; newer messages do not invalidate it and
stay verbatim through their original engine handles.

This release implements recovery for the [0.4.8 incident](session-audit-0.4.8-2026-10-18.md):

- Serialize initialization and history reconciliation, preserve read failures,
  retry empty/failed reads, and retry reads raced by appends before committing.
- Recover missing or changed history from the complete live compaction input.
  Invalidate an incomplete checkpoint and hold for one recovery preparation
  within the original shared deadline.
- Bind checkpoints to session/epoch/snapshot metadata, covered message count,
  covered-prefix SHA-256 and evidence digest. Check the complete covered prefix
  before returning a replacement.
- Run Claude builder/verifier roles in separate `--safe-mode --print` workers
  with existing authentication, Read/Grep tools and no session persistence.
  Nonce-tagged atomic result files carry answers; stdout carries status only.
  Parent-facing maintenance subagents are no longer used. Pi remains optional.
- Separate verification, live eligibility and confirmed installation in status
  and persisted diagnostics. Normalize structured and legacy completion results.
- Retain sanitized original evidence across ordinary Shadow installs, limit raw
  projections to the current context, and exclude historical-only rows from
  live coverage anchors. Save superseded archives when rebuilding history.

`claudePath` selects the worker's Claude executable. `piNodePath` now selects
Node for both worker types. Claude workers require `--safe-mode` support; managed
policy continues to apply. Native fallback remains available for real failures.

Validation on Claude Code 2.1.303: `npm run check` passed typechecking, plugin
validation, **94 hook/schema/integration tests** and **22 Node worker tests**.
`npm run build` regenerated both distributable workers.

A live smoke test through the shipped Claude worker confirmed authentication
and its atomic private result channel. A separate live synthetic-evidence
pipeline ran a Haiku/high builder and independent Haiku/high verifier, producing
a schema-validated checkpoint through `a3` in two model calls. Regression tests
exercise reload recovery, concurrent appends, opaque handle changes, changed
content under unchanged IDs, exact recent/uncovered tails, repeated installs,
the canonical read cap, shared deadlines and late-result rejection. A full
large-context automatic compaction was not exercised in a live interactive
session during this release preparation.

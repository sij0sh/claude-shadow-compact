# Shadow Compact 0.4.11

## Result

Claude-only automatic compaction with three user preferences: `checkpointModel`
(`haiku`), `checkpointEffort` (`high`), and `prepareThresholdTokens` (`160000`).
The release includes source, the rebuilt deployment worker modules, the plugin
manifest, portable tests, and development scripts.

## Cuts and consolidation

- Removed the Pi SDK backend, worker, tool loop, provider settings, dependency
  tree, mixed-backend routing, and Pi-specific tests.
- Removed adaptive verification and checkpoint-risk classification. Every draft
  requires deterministic checks and an independent verifier.
- Removed `/shadow-export` and `/shadow-compact`. Kept `/shadow-status`, normal
  `/compact`, and the `/compact-native` escape hatch.
- Unified builder/verifier model and effort controls. Internal policy now owns
  the ten-round minimum tail, 360-second preparation deadline, compaction hold,
  idle floor, native window tuning, and executable discovery through PATH.
- Replaced duplicated preparation and verification transport flows with one role
  executor. Transport failures retry that role with the same evidence and prompt;
  the builder is not repeated after a verifier transport failure. Correction
  loops remain bounded and quality rejection is terminal.
- Simplified lifecycle labels and removed redundant runtime diagnostic fields.
  Preserved generation IDs, history epochs, frozen evidence, full prefix proofs,
  attempted/confirmed installation, bounded recovery, and native fallback.
- Builds and portable tests now use Node's built-in TypeScript transform. Only
  TypeScript and Node typings remain as development dependencies. Deployment uses
  Node built-ins and needs no dependency installation.

## Scheduling and fidelity

Preparation defaults to 160,000 context tokens. Idle preparation starts after a
completed turn at or above 100,000 tokens, with a threshold refresh available
while the earlier verified checkpoint still serves. Native idle eligibility and
timing remain controlled by the host.

The native window policy initially requests 235,000 on larger models, using an
estimated 35,000 of native headroom to target approximately 200,000 live tokens.
It is capped at the model's actual window and the host's 1M command limit.
Higher checkpoint thresholds raise the target when possible. This estimate is
based on the supplied source's observations and needs measurement in the user's
Claude Code build. It is not a guarantee of a 200,000-token trigger.

The old 190,000 setting migrates only when the persisted Shadow ownership record,
current effective window, and per-model setting all match. Explicit user,
environment, global, managed, and changed values remain respected. The saved
checkpoint threshold, if any, stays in effect. New model/effort keys use their
new defaults; removed controls are ignored.

Between host measurements, scheduling counts complete appended messages and
outputs rather than their clipped evidence projection. Bounded evidence rows now
retain both beginning and end with an omission marker and original-length
metadata. Both role prompts explicitly request important source-cited command,
error, and verification excerpts. Every uncovered message and at least ten
recent rounds still survive as original engine messages.

Install confirmation requires the exact attempted checkpoint text and ID. A
refresh publishing during an installation cannot change which checkpoint that
installation confirms. Late confirmation of an obsolete attempt is ignored.

## Validation record

Executed successfully in this environment:

| Check | Result |
|---|---|
| `npm run build` | Deployment worker modules rebuilt |
| Portable hook/core/integration suite | 74 passed, 2 host-only fixture tests skipped |
| Shipped worker and process tests | 5 passed |
| Package validation | Version/default agreement, exactly three settings, hook paths, dependency-free worker imports, JavaScript syntax passed |
| `git diff --check` | Passed |

Total: **79 passing tests, 2 skipped host-only tests, no failing tests.**

The portable tests cover threshold and idle scheduling, custom model/effort,
ready swaps without new model work, old checkpoints serving during refresh,
manual compaction, long single turns, full uncovered tails, tool-pair integrity,
parallel tool calls, opaque handle changes, mutated prefixes, resumed and capped
history reads, read/append races, stale nonces, transport fallback, quality
rejection, shared deadlines, cancellation, unavailable host pauses, remaining
hook budget, native recovery, install races, and safe window migration.

No live model inference or real interactive Claude Code session was run.
The environment has no Claude executable or generated host types. Full
TypeScript checking could not run because the compiler was not installed and
the package registry rejected dependency downloads. The build and portable tests
therefore use the available Node TypeScript transform; transformation is not a
substitute for static type checking.

Before treating the native integration as live-validated, run the documented
`npm run check:host` with current host types, then exercise an actual 160k
preparation, live native compaction, and an eligible idle session. Verify observed
trigger tokens in diagnostic events and the confirmed install count.

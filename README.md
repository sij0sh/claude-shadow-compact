# Shadow Compact 0.4.11

A Claude Code mod that prepares a verified continuation checkpoint in the
background and installs it at Claude's normal compaction boundary. The result
is a structured checkpoint plus the exact recent conversation, with original
message handles and tool results preserved.

## Install

Extract the release archive, then load the extracted directory:

```sh
claude --plugin-dir /absolute/path/to/shadow-compact
```

The release contains the worker JavaScript. Installation needs no npm install
or build. Node.js 22.13+ and `claude` must be on PATH. Use a Claude Code build
that supports function-hook mods and `--safe-mode`; host rollout and organization
policy can affect availability. See [Claude's mod setup guide](https://code.claude.com/docs/en/plugins/mods/create).

## Configuration

There are three preferences in Claude Code's plugin configuration:

| Setting | Default | Effect |
|---|---|---|
| `checkpointModel` | `haiku` | Claude model or alias for the builder and independent verifier; `inherit` uses the session model |
| `checkpointEffort` | `high` | Thinking effort for both roles; subject to model support and host policy |
| `prepareThresholdTokens` | `160000` | Context size that starts background checkpoint preparation |

Both roles receive the same model and effort through the worker and inline
fallback transports. A verifier always independently audits the builder's draft.
Invalid token counts or effort values use the defaults.

## Automatic behavior

1. At 160,000 context tokens, start preparing a checkpoint. The live estimate
   also counts full appended messages and tool outputs between measurements.
2. After a completed turn at or above 100,000 tokens, prepare for native idle
   compaction. An earlier idle checkpoint can serve while a fresher checkpoint
   prepares at the main threshold.
3. At a live automatic, idle, or manual `/compact`, check the entire covered
   prefix. If proven safe, immediately return the checkpoint and exact tail,
   without generating another summary.
4. If preparation is still running, hold compaction within its shared 360-second
   preparation deadline and the host's remaining hook budget. Failures fall back
   to native compaction; cancellation stops the pending work.

The tail keeps at least ten whole assistant/tool rounds and **every message
after the checkpoint's coverage boundary**. Original handles preserve the
host's full blocks. An unsafe tool pairing or a candidate that saves no space
uses native compaction.

### Compaction timing

Shadow configures the native window automatically unless an explicit user,
environment, or managed choice owns it. The initial policy targets roughly
200,000 tokens of live context: a 235,000-token configured window on larger
models allows an estimated 35,000 tokens of native headroom. With a 200,000-token
model, the configured window is capped at 200,000. A higher preparation threshold
increases the target when the model permits it.

**This is an internal scheduling estimate, not a measured guarantee that native
compaction fires at 200,000.** Claude controls the actual trigger; the bounded
hold covers a checkpoint that finishes later. The
[host's window documentation](https://code.claude.com/docs/en/model-config#context-window-and-auto-compaction)
describes the native controls. Actual measured and estimated tokens at each
compaction are recorded in diagnostics.

Shadow lowers native idle compaction's floor to 100,000 unless the host has an
explicit environment floor or disables idle compaction. Native idle eligibility
and timing still belong to Claude Code; crossing 100,000 does not start an
immediate forced swap or a second timer.

### Upgrading from 0.4.10

The old 190,000 window migrates only when Shadow's stored record says it applied
that value, the current effective window still matches, and the current per-model
setting matches too. Global settings, environment overrides, explicit `auto`,
and changed or unowned settings are preserved.

The threshold key is unchanged, so a previously saved threshold is retained.
The new model and effort keys default to `haiku` and `high`; select different
values in the three-field configuration if needed. Old builder/verifier settings,
Pi controls, verification modes, deadlines, tail sizes, hold toggles, and host
tuning options are no longer read.

## Commands

| Command | Behavior |
|---|---|
| `/shadow-status` | Short health report: phase, checkpoint, selected model/effort, install count, last issue, and diagnostics path |
| `/compact` | Claude's normal manual compaction, using Shadow when safe |
| `/compact-native` | Emergency native compaction for this invocation |

Preparation is automatic. `/shadow-export` and `/shadow-compact` are removed.

## What is preserved

The evidence archive, serialized canonical reconciliation, frozen snapshots,
strict schema/coverage/reference checks, independent verification, generation and
history-epoch guards, complete prefix digests, exact tail, bounded recovery,
worker cancellation, and native fallback remain. A returned checkpoint is counted
as installed only when canonical history confirms the exact checkpoint text.
A refresh cannot change which checkpoint an in-flight installation confirms.

Builder and verifier are instructed to retain essential older commands, errors,
test results, and non-reproducible observations as source-cited `criticalContext`
and `verificationState` excerpts.
Evidence rows remain bounded at 4,000 characters: clipped projections retain both
the beginning and end, an omission marker, and truncation metadata. This does
not promise full retention of arbitrary older output outside the exact tail.

### Private workers and transport fallback

Builder and verifier each run in an isolated `claude --safe-mode --print`
process with Read/Grep access to a frozen evidence directory, existing Claude
authentication, no session persistence, and parent routing removed. Each answer
arrives through a nonce-tagged result file rather than the parent conversation.

One role executor handles deadlines, cancellation, worker results, and fallback.
A worker transport failure retries that role through `model.complete`, inlining
the **same** evidence only when it fits the 120,000-character limit. A valid
builder draft survives verifier transport failure. Quality rejection is terminal;
changing transport cannot reset a correction budget or bypass the verifier.

### Diagnostics

Diagnostic event files and per-attempt evidence, checkpoint, worker results,
and outcome records live under `.shadow-data/<session-id>/`. `/shadow-status`
shows the event directory. These records distinguish attempted and confirmed
installs, verification failures, holds, native fallbacks, and window decisions.
Routine checkpoint maintenance uses status/debug output.

## Development and verification

Node.js 22.13+ provides the TypeScript transform used for offline builds and
portable tests. Deployment files use only Node built-ins.

```sh
npm run check          # build, portable hooks, worker process tests, packaging checks
```

With development dependencies and the current host types installed:

```sh
npm ci
npm run typecheck:core
# Generate current Claude mod types with /plugin-types in a development host.
npm run check:host     # full typecheck, Claude validation, native engine fixture tests
```

[Claude's mod reference](https://code.claude.com/docs/en/plugins/mods/reference)
explains host types and validation. Portable tests use deterministic fake hosts
and fake CLI processes; they cannot prove live model quality, host eligibility,
or the real automatic compaction trigger. See
[release notes](docs/release-0.4.11.md) for this release's validation record.

## Origins

The checkpoint approach derives from
[pi-shadow-compact](https://github.com/sij0sh/pi-shadow-compact).
The optional Pi execution backend has been removed; this release uses Claude
for both checkpoint roles.

# Shadow Compact 0.4.12

A Claude Code mod that prepares an independently verified continuation checkpoint
in the background, then installs it with the exact recent conversation at the
host's compaction boundary. Original message handles and tool results are preserved.

## Install

Extract the archive and load its directory:

```sh
claude --plugin-dir /absolute/path/to/shadow-compact
```

The archive includes built JavaScript workers. Installation needs no npm install
or build. Node.js 22.13+ and `claude` must be on PATH. Use Claude Code with
function-hook mods, `--safe-mode`, replacement-message compaction, and the usage
breakdown APIs. Native idle compaction requires Claude Code 2.1.290 or later.
Host rollout and organization policy can affect availability.

## Configuration

| Preference | Default | Behavior |
| --- | --- | --- |
| `checkpointModel` | `haiku` | Model for the curator and independent verifier; `inherit` uses the session model |
| `checkpointEffort` | `high` | Same effort for both roles, subject to model support and host policy |
| `prepareThresholdTokens` | `160000` | Starts background preparation; capped to an internal safe estimate on smaller windows |

There are no backend, verifier-mode, timeout, or compaction-hold settings.

## Automatic behavior

1. Prepare at 160k tokens, including append growth between host measurements.
2. After a completed turn at or above 100k, prepare for eligible idle compaction.
   A verified idle checkpoint remains available during its main-threshold refresh.
3. At a live compaction, install an eligible checkpoint immediately. A ready swap
   makes no new model call.
4. If no eligible checkpoint exists, start or join preparation even below 160k.
   Hold the live compaction until that preparation succeeds or reaches a defined
   failure. A previous failed attempt does not close a permanent preparation gate.
5. Use native summarization after a terminal error or unsafe replacement.
   Interruption cancels the compaction attempt and its preparation.

The result keeps the checkpoint, at least ten whole recent rounds, and **all
uncovered messages**. Tool results cannot be separated from their retained calls.
Prefix proof, message identity, coverage, size, and savings checks run before
installation. Only canonical confirmation counts an installation as successful.

### Curation and independent verification

The normal path uses two isolated, tool-free Claude requests. The curator writes
current continuation state; the verifier returns a short pass/fail verdict.
Neither agent pages through files, runs project tools, or regenerates the task.
A rejected or malformed candidate is never published.

One executor handles both roles. Retry a transient transport failure once after
60 seconds, retaining a valid curator draft when only verification must retry.
There is no worker-to-inline fallback or 120,000-character transport cliff.

Each role has a fresh request allowance of up to 600 seconds, including process
overhead. The child aborts five seconds before the host process limit. There is
no combined 360-second pipeline deadline. History/setup I/O has a separate
30-second guard. A renewable 240-second wait lease does not fail or restart a
healthy preparation and does not authorize native summarization.

The source packets target estimated input limits of 24k tokens for curation and
12k for verification. Visible answers are limited to approximately 4k and 1k
respectively. Request generation limits of 8k and 4k leave room for reasoning.
These input/visible-answer sizes use a conservative sizing heuristic, not a
provider tokenizer or actual usage measurement.

Full user instructions and prior checkpoint obligations are protected. If they
cannot fit both requests, coverage moves earlier and the rest remains verbatim.
If no safe boundary exists, preparation fails explicitly. Optional repeated logs
are deduplicated; source excerpts retain decisive errors/results and exact
identifiers. The independent audit includes user requirements even if the
curator did not cite them. A source ID is not a guarantee of semantic accuracy.

### Native compaction window

While enabled, Shadow attempts a **session-scoped environment override** that
takes precedence over a saved per-model window such as:

```json
{"modelSettings":{"claude-opus-5-5":{"autoCompactWindow":190000}}}
```

The internal policy is `min(model capacity, max(240000, threshold + 80000))`,
capped at the host's supported 1M window. It preserves saved settings beneath the
override. For 200k models it cannot enlarge their actual context capacity.

A configured 240k window is an initial scheduling policy, **not a guarantee of a
200k actual trigger**. Claude controls headroom and token accounting. Shadow
confirms the override from the host's effective usage breakdown, reapplies it on
model changes, and reports an unconfirmed override when it cannot prove
application. The live gate still handles an early compaction event.

The idle floor is 100k unless the host explicitly sets another floor or disables
idle compaction. Eligibility and idle timing belong to Claude. Owned environment
values are restored on normal session end only when still unchanged.

### Commands

| Command | Behavior |
| --- | --- |
| `/shadow-status` | Phase, checkpoint, model/effort, effective preparation threshold, install count, last issue, and diagnostics path |
| `/compact` | Normal manual compaction through Shadow; explicit focus instructions reach both roles |
| `/compact-native` | Emergency native compaction for this invocation |

`/shadow-export` and `/shadow-compact` remain removed.

## Diagnostics and upgrading

Private source snapshots, bounded role requests, nonce-tagged results, checkpoints,
outcomes, and events live in `.shadow-data/<session-id>/`. Events distinguish
request deadlines, retry errors, wait leases, native recovery, and confirmed
installation. The release archive excludes session diagnostics.

Upgrading from 0.4.11 retains the three preference keys. The former saved 190k
window remains on disk; the active-session override takes precedence when the
host supports it. There is no ownership-record prerequisite or settings-preserving
early return. Existing per-session checkpoints are rebuilt after loading the mod.

## Development and validation

```sh
npm run check          # offline build, portable regressions, release packaging checks
npm run typecheck:core # pure checkpoint/core types, after installing dev dependencies
```

For host validation, first load the mod in an interactive Claude session to
produce `.claude-plugin/types/`, then run:

```sh
npm ci
npm run check:host
```

The release environment has no Claude executable and dependency downloads were
blocked. Live host waiting/window application, full TypeScript checks, and paid
model quality/latency evaluations remain unverified. The portable suite exercises
the reported failure paths using controlled host simulations and tests the built
workers as actual processes. See [release notes](docs/release-0.4.12.md) for scope
and the live verification checklist.

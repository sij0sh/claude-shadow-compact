# Claude Shadow Compact

A Claude Code **mod** (plugin of function hooks) that ports
[pi-shadow-compact](https://github.com/sij0sh/pi-shadow-compact) to
Claude Code. It is a real compactor, not a hooks-plus-context shim:
when compaction fires, Shadow answers with a **verified structured
checkpoint plus the exact recent tail** (original messages carried by
their engine handles, untouched), instead of Claude's native summary.

## Native vs Shadow

Native compaction writes a prose summary of what it saw. Shadow writes a
checked checkpoint: every claim points at saved session entries, tested work
is marked verified, untested work stays unverified, and the checkpoint names
exactly how far it covers. A second agent checks the first. If the check
fails, the session falls back to native compaction.

The example is synthetic and shows the same session on each side, so
compare shape, not size. Task and paths are generic on purpose.

<div align="center">

<img src="./docs/images/comparison-full-checkpoint.svg" width="100%" alt="Synthetic example: native prose versus Shadow checkpoint across all 12 checkpoint sections for adding CSV export to a notes app" />

</div>

| Area | Native | Shadow |
|---|---|---|
| Grounding | Prose, no links | Each claim cites entries (`E0004` ...) |
| Tested vs untested | Same voice | `[verified]` vs `[unverified]` ledger |
| Resume pointer | Buried in prose | Goal, approach, next step |
| Coverage proof | None | `coverageEndEntryId` in live transcript |
| Failure mode | Always installs prose | Falls back to native when unsafe |

<details>
<summary>Text version of the example</summary>

Synthetic session — add CSV export (`src/notes/export.ts`). Left column:
what native prose provides per area. Right column: the Shadow checkpoint.

```text
Native: "Add CSV export to notes app. Updated export logic and wired
the button. Tests were run and things look good. Remaining work
is handled. See prior files for details."

Shadow:
## Objective
- Add CSV export, UTF-8 + commas [E0004]
## Constraints
- Keep JSON export working; bundle size stays flat [E0006]
## Completed Work
- Serializer written; Export button wired [E0012]
## Current State
- Serializer done; Excel import untried [E0023]
## Decisions
- RFC-4180 quoting, not ad-hoc escaping [E0015]
## Open Issues
- Excel import of quoted commas not tried [E0031]
## Next Actions
- Open output in Excel, then merge [E0031]
## Critical Context
- Export path: export.ts via export-button.tsx [E0004]
## Modified Files
- src/notes/export.ts, src/notes/export-button.tsx [E0012]
## Referenced Files
- tests/notes-export.test.ts, 14 passed [E0023]
## Verification State
- [verified] export tests, 14 passed [E0023]
- [unverified] Excel import not tried [E0031]
## Continuation
- Goal: ship an export Excel opens cleanly
- Approach: verify in Excel, then merge
- Next: open notes.csv in Excel
Coverage through E0031. Builder + verifier; fails closed to native.
```
</details>

## How it works

```text
session.append ──► durable evidence archive (sanitized, stable evidence ids)
session.measure ≥160k tokens ──► private builder agent (Read/Grep on the archive)
                      ──► private verifier agent (independent re-read)
                      ──► validated checkpoint published + persisted ($.store)
next safe boundary ──► /compact dispatch ──► session.compact hook
                      ──► [checkpoint message] + [exact tail by handle]
no/invalid checkpoint ──► next(e): Claude native compaction (fail closed)
```

- **Evidence archive.** Every main-loop `session.append` row is mirrored
  in append order under its stable Claude uuid, sanitized (secret
  redaction fails closed on any key whose name merely contains a secret
  keyword), and served to the side agents as paged JSONL. Later
  checkpoints re-ground on original evidence, never recursively on the
  last summary. Sessions that predate installation bootstrap from
  `$.session.messages()`.
- **Builder → verifier.** Two private agent types
  (`shadow-compact:checkpoint-builder` / `checkpoint-verifier`) are
  registered Read/Grep-only, Claude-MD-free, and hidden from the acting
  model via `agent.offer`. They return strict JSON; the mod validates
  schema, evidence citations, coverage boundary, and continuation state,
  retrying with the validation error fed back. If agent spawning fails,
  preparation retries through `$.model.complete` with inlined evidence.
  An `unusable` verifier verdict fails closed.
- **Compaction.** The `session.compact` hook proves coverage: the
  checkpoint's coverage row must sit in the current transcript at a
  known index, the tail starts at a whole-turn boundary keeping at
  least `recentTurns` turns, no tool result is orphaned from its call,
  and the candidate must actually shrink the context. Any failure
  defers to native compaction unchanged.
- **Thresholds.** Background checkpoint preparation starts at 160,000
  context tokens, and a verified checkpoint installs at the next safe
  compaction boundary. At 250,000 tokens the extension requests compaction
  even if preparation has not finished; without a usable checkpoint it
  uses native compaction. Both limits are absolute token counts, independent
  of the model's context window and Claude's auto-compaction threshold.
  Claude's auto-compaction settings are left unchanged and may trigger
  earlier. Rolling refresh re-arms after a Shadow install followed by
  below-checkpoint context, or after native compaction.
- **Persistence.** The small checkpoint record lives in `$.store`
  keyed by session id; the large evidence archive is a paged file
  under the plugin's `.shadow-data/<session-id>/` directory.

## Install

/plugin install shadow-compact --marketplace <owner>/<repo>

Or, from a local checkout, load it for one session with
`claude --plugin-dir /path/to/claude-shadow-compact`.

## Commands

| Command | Behavior |
|---|---|
| `/shadow-compact` | Start background preparation, or install the ready checkpoint (honest when history is too short) |
| `/compact-native` | Bypass Shadow for the next compaction (native summary) |
| `/shadow-status` | Version, phase, archive size, checkpoint coverage, thresholds, last fallback, compact-hook |
| `/shadow-export` | Print the verified checkpoint for manual copy-paste |

## Configuration

Set via the plugin's `userConfig` (Claude Code `/config` or
`pluginConfigs`):

| Setting | Default | Behavior |
|---|---|---|
| `prepareThresholdTokens` | `160000` | Start background checkpoint preparation |
| `hardThresholdTokens` | `250000` | Request compaction at the next safe boundary |
| `recentTurns` | `10` | Minimum recent turns kept verbatim |
| `builderModel` / `verifierModel` | `inherit` | Checkpoint agent models |
| `builderBackend` / `verifierBackend` | `claude` | `claude` agent or `pi` CLI bridge |
| `builderProvider` / `builderId` | blank | Pi provider/model for the builder when its backend is `pi` |
| `verifierProvider` / `verifierId` | blank | Pi provider/model for the verifier; blank reuses the builder Pi model |
| `builderThinking` / `verifierThinking` | `default` | Pi thinking level (`off` to `max`); `default` uses the Pi default, verifier reuses builder |
| `piBinary` | `pi` | Pi CLI used by the `pi` backend |
| `piTimeoutMs` | `540000` | One Pi call may run this long before fallback; at most `600000` |
| `manualCompactMode` | `shadow` | `shadow` or `native` for manual `/compact` |

Token thresholds must be positive safe integers. Invalid values use the
corresponding default; a hard threshold at or below the checkpoint threshold
is raised to one token above it. The checkpoint threshold must leave room
for a higher hard threshold. The former `prepareThresholdPercent`,
`swapThresholdPercent`, and `nativeFallbackThresholdPercent` settings are
no longer used; replace any saved overrides with token values.

The hard threshold is a trigger, not a strict cap on a running turn: Claude
pins the transcript during a turn, so compaction retries when the turn ends.

Set a backend to `pi` to answer builder or verifier requests with a
non-Claude model through the Pi CLI (for example `builderProvider`
`openai` with `builderId` `gpt-5-mini`). The Pi CLI must be on PATH and
authenticated through Pi's own settings; the bridge calls it tool-less
and session-less with sanitized evidence only. A blank provider and id
uses the Pi default model, and a half-set pair falls back to blank. Any
bridge failure (missing binary, timeout, bad JSON) falls back to the
Claude agent and then `$.model.complete`, so Claude remains the default
and the safety net. Each fallback is logged at debug level without prompt
contents, and `/shadow-status` shows the resolved backend per role plus
the last fallback reason. The prompt travels on `stdin`, never `argv`,
so large sessions cannot overflow the command line.

## Managed installs and updates

On organization-managed Claude Code, `session.compact` hooks run only for
org-listed plugins. If yours is not listed, Shadow prepares but never
installs: `/shadow-status` shows `compact-hook=unseen`. Ask the org to
allowlist `shadow-compact`, or copy `/shadow-export` output by hand.

If the marketplace reports a stale version after a release, refresh it:

```bash
claude plugin marketplace update claude-shadow-compact
claude plugin update shadow-compact@claude-shadow-compact
```

`/shadow-status` shows the running version (`v0.2.1`).

## Deferred from the Pi version

- **Request-local mid-turn swaps.** Pi rewrites an individual model
  request without touching canonical history; Claude pins the
  transcript in `turn.step`, so Shadow installs canonically through
  `session.compact` at the next safe boundary. A very long single turn
  cannot be swapped halfway through.
- **Native-summarizer token-cap recovery.** Claude's compact result
  exposes no stable truncation signal, so the v1 policy is simply:
  Shadow ready → Shadow compaction; otherwise native.

## Develop

```bash
npm install
npm run check   # tsc --noEmit && claude plugin validate . && claude plugin test .
```

`.claude/types/claude-code.d.ts` is the generated mod API declaration
(written by Claude Code 2.1.277); regenerate it with `/plugin-types`
after a Claude Code update rather than editing it.

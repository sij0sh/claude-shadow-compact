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
                      ──► validated checkpoint published (in memory)
Claude's /compact or auto-compaction ──► session.compact hook
                      ──► [checkpoint message] + [exact tail by handle]
no/unproven checkpoint ──► next(e): Claude native compaction (fail closed)
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
- **Compaction.** Shadow never starts a compaction itself: Claude Code
  runs a plugin's own `$.session.compact()` through every hook except
  the caller's, so a self-started compaction would skip Shadow's
  replacement. Claude Code's `/compact` and auto-compaction are the
  install points. The `session.compact` hook proves coverage by
  identity: the checkpoint's coverage row uuid must sit in the live
  transcript index, never a saved position. The tail starts at the turn
  holding the first uncovered message, keeping at least `recentTurns`
  turns, no tool result is orphaned from its call, and the candidate
  must actually shrink the context. Any failure defers to native
  compaction unchanged; `precompute` compactions are skipped.
- **Install confirmation.** Returning the checkpoint is an attempt, not
  an install. It counts once canonical history (`$.session.messages()`)
  opens with that checkpoint's coverage line; `/shadow-status` shows
  `phase=installing` until then and `lastCompact` records every decision.
- **Thresholds.** Background checkpoint preparation starts at 160,000
  context tokens (absolute, independent of the context window). Set
  Claude Code's `autoCompactWindow` (or `CLAUDE_CODE_AUTO_COMPACT_WINDOW`)
  so auto-compaction fires comfortably above that, for example around
  250,000 tokens, leaving preparation time to finish. Check the effective
  point in your Claude Code version. A failed preparation is not retried
  until the next compaction or a manual `/shadow-compact`. Rolling refresh
  re-arms after a Shadow install followed by below-checkpoint context, or
  after native compaction.
- **State.** The checkpoint and transcript index live in memory for the
  session. After a restart or resume, Shadow re-prepares rather than
  trusting a checkpoint it cannot prove against the live transcript. The
  evidence snapshot for the side agents is a file under the plugin's
  `.shadow-data/<session-id>/` directory.

## Install

/plugin install shadow-compact --marketplace sij0sh/claude-shadow-compact

Or, from a local checkout, load it for one session with
`claude --plugin-dir /path/to/claude-shadow-compact`.

## Commands

| Command | Behavior |
|---|---|
| `/shadow-compact` | Start background preparation now (honest when history is too short); run `/compact` to install a ready checkpoint |
| `/compact-native` | Run Claude Code native compaction once, bypassing Shadow |
| `/shadow-status` | Version, phase, archive size, checkpoint coverage, installs, threshold, last fallback, last compaction decision |
| `/shadow-export` | Print the verified checkpoint for manual copy-paste |

## Configuration

Set via the plugin's `userConfig` (Claude Code `/config` or
`pluginConfigs`):

| Setting | Default | Behavior |
|---|---|---|
| `prepareThresholdTokens` | `160000` | Start background checkpoint preparation |
| `recentTurns` | `10` | Minimum recent turns kept verbatim |
| `builderModel` / `verifierModel` | `haiku` | Checkpoint agent models; `inherit` uses the session model |
| `manualCompactMode` | `shadow` | `shadow` or `native` for manual `/compact` |

The token threshold must be a positive safe integer; invalid values use the
default. The former `hardThresholdTokens` setting is gone (use Claude Code's
`autoCompactWindow`), as are the older percentage settings.

Builder and verifier run as private Claude agents with file access to the paged evidence archive. When agents are unavailable the pipeline retries with `model.complete` on inline evidence, then fails closed to native compaction. Agent spawn failures are logged at debug level without prompt contents, and `/shadow-status` shows the resolved model per role plus the last fallback reason.

## Managed installs and updates

On organization-managed Claude Code, `session.compact` hooks run only for
org-listed plugins. If yours is not listed, Shadow prepares but never
installs: `/shadow-status` shows `lastCompact=unseen` after a compaction. Ask the org to
allowlist `shadow-compact`, or copy `/shadow-export` output by hand.

If the marketplace reports a stale version after a release, refresh it:

```bash
claude plugin marketplace update claude-shadow-compact
claude plugin update shadow-compact@claude-shadow-compact
```

`/shadow-status` shows the running version (`v0.4.0`).

## Deferred from the Pi version

- **Request-local mid-turn swaps.** Pi rewrites an individual model
  request without touching canonical history; Claude pins the
  transcript in `turn.step`, so Shadow installs canonically through
  `session.compact` when Claude Code compacts. A very long single turn
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

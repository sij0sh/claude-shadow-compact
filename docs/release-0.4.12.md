# Shadow Compact 0.4.12

## Changes

- Remove the preparation permission latch. A failed idle attempt cannot suppress
  a later live compaction request below the 160k main threshold.
- Use one shared start-or-join operation for preparation. Keep bounded recovery
  after new completed coverage; retry transient transport failure automatically
  once per affected role without repeating an accepted curator draft.
- Replace the combined 360-second deadline with fresh per-request allowances.
  Each worker has 595 seconds to finish inside its 600-second host process limit.
  Bound history/setup I/O separately at 30 seconds.
- Hold live compaction through a small process waiter with renewable 240-second
  leases. Lease expiry means pending work, not failure or native authorization.
  User interruption skips compaction and stops preparation. A real terminal
  request, verification, history, wait, or installation error permits native recovery.
- Simplify the normal model workflow to one tool-free curator and one independent
  pass/fail audit, sharing one isolated Claude executor. Remove model transport
  fallback, full-checkpoint verifier repairs, validation regeneration loops, and
  paged-evidence navigation/index machinery.
- Use bounded source packets: approximately 24k estimated input tokens for the
  curator and 12k for the audit. Protect full user instructions and prior
  obligations, retain decisive output excerpts, deduplicate optional logs, and
  include user constraints independently of curator citations. Move coverage
  earlier when necessary; never silently truncate protected instructions.
- Limit visible answers to roughly 4k/1k estimated tokens. Request generation
  allowances of 8k/4k provide reasoning headroom. Parent effort/thinking overrides
  no longer displace the checkpoint's configured effort.
- Attempt a session environment window override over saved per-model settings,
  including the reported 190k Opus window. Target 240k by default on capable
  models, cap it at actual capacity, and confirm effective host application.
  Saved settings remain intact. Status reports unconfirmed application honestly.
- Preserve explicit manual compaction focus in both requests. Preserve an older
  verified checkpoint during refresh, and cancel the refresh when installation
  makes its original prefix stale.
- Retain prefix proofs, exact original-message tails, tool pairing, size/savings
  checks, session epochs, generation isolation, installation confirmation, and
  the native escape hatch. Terminating a worker also stops its isolated CLI child.

## Validation completed

`npm run check` passed: build, portable hook regressions, actual built-worker
process tests, and metadata/deployment checks. The exact totals are recorded in
`validation-0.4.12.json` alongside this file.

The regression set covers the reported below-threshold failure, 262 seconds of
curation followed by 191 seconds of verification using a simulated host clock,
renewable waits, role-only retry, rejected verification, late answers, resumed
history, changed prefixes, parallel tool calls, manual focus, stale refreshes,
large/multibyte source packets, and the saved per-model 190k window.

The worker process tests exercise nonce-tagged atomic results, cancellation
before launch and during execution, role deadlines, child shutdown on parent
termination, and the deployed wait helper.

## Verification still required on a Claude host

This environment has no `claude` executable. Dependency downloads were blocked,
so full TypeScript checking also remains unverified. Build and portable tests
use Node's TypeScript transform; they do not provide a full type check.

The plan's host-native `model.complete` transport was conditional on a successful
live capability probe. That probe could not run here, so this release retains
one isolated worker transport with the narrower workflow. No backend matrix is
shipped.

Before treating behavior as seamless, verify on the installed Claude build:

1. Run the host validator and tests after generating that build's declarations.
2. Confirm a saved per-model 190k window is superseded in the effective usage
   breakdown, not merely in an environment read-back.
3. Confirm a real multi-minute hold crosses normal hook-budget limits without a
   skipped hook or a native summarizer request.
4. Confirm a ready checkpoint swaps without a model call and that native
   summarization starts only after a defined error or explicit escape hatch.
5. Confirm the 100k idle preparation/native idle path on an eligible session.
6. Measure continuation quality and model latency on representative transcripts.
   The 60-second median/120-second p95 targets are goals, not measured results or
   fallback timers.

A 240k configured window is an internal starting policy. It does not guarantee
that Claude's actual compaction event fires at 200k. Unsupported or blocked
runtime overrides are surfaced as unconfirmed; the live compaction gate still
attempts safe preparation at the actual event.

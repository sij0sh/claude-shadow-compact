**Claude Shadow Compact production-readiness audit — 2026-10-18**

**Verdict: hold the production release.** Threshold detection and schema rejection work, and independent review can find real errors. The sampled sessions do not demonstrate a successful Shadow installation. The current checkout also permits two reproducible forms of context loss if installation succeeds: an uncovered interval at a turn boundary, and replacement of newer history using an old checkpoint's numeric position.

This was a read-only review of implementation and session state. No extension source, configuration, installed plugin, or live session was changed. These findings are saved in `docs/session-audit-2026-10-18.md`. Supporting session copies, analysis data, and compiled replay code remain in the temporary directory `/tmp/claude-shadow-compact-audit-2026-10-18/`; their links depend on those temporary files remaining available.

**Scope and confidence.** I froze the available session data at **2026-10-18 06:59:51 America/Los_Angeles (13:59:51 UTC)**. The newest session was still running. Conclusions about it stop at that capture; absence of a later success is not a claim about its eventual outcome. I examined the 13 sessions indexed by the plugin store, the three persisted checkpoints, available builder/verifier transcripts, and both on-disk evidence files. I inspected the implementation and ran the repository checks plus isolated behavioral replays.

The checkout is commit `34b942c`; the installed cache is `shadow-compact/0.3.0`. Both identify themselves as 0.3.0, but the installed copy lacks the checkout's frozen-evidence-snapshot and person-origin correction fixes. `prepare.ts`, `checkpoint.ts`, and the compaction-tail implementation retain the relevant behavior described below. The distinction matters: the snapshot race is already fixed locally, but that fix was not in the code producing the newest session.

**Observed session outcomes.**

| Session | Observations | Recorded compaction outcome |
|---|---|---|
| Briefcase `75403b08…`, Oct 18 | First context measurement above 160k was 162,021 tokens; builder began about 65 ms later. Four completed builder submissions failed schema validation. A fifth builder was still in progress. No verifier or persisted checkpoint at capture. | No compaction yet. Largest observed response input was 219,479 tokens, below the configured 250k hard trigger. |
| Briefcase `340c5970…`, Oct 17 | Largest observed response input was 151,345 tokens. No checkpoint agents. | No compaction; consistent with remaining below 160k. |
| Plugin dogfood `1e6fb518…`, Oct 16–17 | Manual preparation produced a builder and verifier repair, then a saved checkpoint. Both hand-backs entered the main conversation. | Two native summaries: 55,765→4,204 and 67,471→4,659 tokens. |
| Briefcase `3f0a2848…`, Oct 16 | Three builder/verifier pairs on Opus. Only the final pair produced the saved checkpoint. Five hand-backs entered the main conversation. | Native summary: 231,757→5,865 tokens. |
| WrapArtist `d01a9f60…`, Oct 16 | Two ready-checkpoint notices. The final persisted checkpoint has `coverageMessageIndex: -1`. This predates the current Haiku release. | Two native summaries: 191,222→13,950 and 220,614→17,323 tokens. |

Across the indexed sample: **five recorded main-session compactions, all with native summary text; zero recorded Shadow install notices**. The surrounding native summaries explicitly discuss Shadow and its drafts, rather than being the renderer's `# Continuation Checkpoint`. A ready notice or a populated store is not evidence of an installed checkpoint.

The logs do not persist compact-hook decision traces. I cannot prove which branch caused each native fallback, whether an organization policy suppressed a hook, or whether the engine classified a hook as caught, expired, rejected, or skipped. No such classification should be inferred from native output alone. This lack of diagnostic evidence is itself a release issue.

**Release blockers in the current checkout.**

1. **P0 — the tail planner can drop uncovered messages.** [`hooks/working-context.ts:54`](/home/joshsimon/Projects/pi-extensions/claude-shadow-compact/hooks/working-context.ts:54) chooses the first turn start after the covered message. If coverage stops inside a turn, the intervening messages belong to neither the checkpoint nor the retained suffix. The tool-result orphan check does not detect an omitted ordinary assistant message. My replay used the default `recentTurns=10`, coverage through index 1, an uncovered message at index 2, and the next turn at index 3. The candidate was accepted with `tailStart=3`, deleting index 2. Tail planning must retain the whole turn containing the first uncovered message, then enforce the recent-turn minimum. This is a demonstrated implementation defect, not observed production data loss.

2. **P0 — stale checkpoints can be trusted by position against different history.** [`hooks/register.ts:125`](/home/joshsimon/Projects/pi-extensions/claude-shadow-compact/hooks/register.ts:125) and [`hooks/register.ts:457`](/home/joshsimon/Projects/pi-extensions/claude-shadow-compact/hooks/register.ts:457) accept an in-range saved index when the coverage UUID is absent. Matching transcript/index lengths does not establish that the indexed content is the content summarized. Native compaction, resume, or rewritten history can invalidate that assumption. The replay restored an old checkpoint against newer messages, including new authorization and constraints. No old coverage UUID existed. The hook nevertheless installed the old checkpoint and removed those newer messages, calling native zero times. Coverage must be proved by identity or a durable, content-bound mapping. Failed proof must invalidate the checkpoint.

3. **P1 — the canonical swap and its index maintenance lack successful lifecycle coverage.** The handler creates `[checkpoint, ...tail]`, but [`hooks/register.ts:390`](/home/joshsimon/Projects/pi-extensions/claude-shadow-compact/hooks/register.ts:390) resets the entire index to `[summaryUuid]` on a compaction append. Replaying a newly constructed summary append after a three-message Shadow candidate leaves a one-entry index; the next compact then falls back on the length check. Retained messages reused by handle may not generate new append events. This needs an actual-host lifecycle test before assuming engine ordering. Separately, duplicate append UUIDs are deduplicated by the archive but still pushed into the index; this divergence reproduces without any engine-order assumption.

4. **P1 — a failed installation remains eligible for repeated forced native compaction.** [`hooks/register.ts:231`](/home/joshsimon/Projects/pi-extensions/claude-shadow-compact/hooks/register.ts:231) schedules whenever a published checkpoint has not been marked installed. Native fallback re-arms preparation but leaves that checkpoint uninstalled and published. A ready checkpoint that cannot drop history can therefore trigger `/compact` again at later turn completions, even below 160k. A replay with four messages and the default ten-turn retention produced native fallback and another scheduled compact on `turn.complete`; status remained `phase=ready`, `installs=0`, `lastFallback=none`. The dogfood session actually performed native compaction twice at relatively small contexts; the precise decision path was not recorded. Record installation attempts and invalidate, suppress, or refresh unusable candidates instead of treating readiness as sufficient indefinitely.

**Where the extension gets involved unintentionally.**

The builder and verifier are hidden from the acting model's agent menu, but their completions are not private. `agent.offer` controls discoverability; it does not prevent background hand-back delivery. The transcripts contain peer-origin reports from `shadow-compact:checkpoint-builder` and `checkpoint-verifier`, and the actor responds to them.

In `3f0a2848…`, a verifier finding about C1–C7 caused the actor to reopen a C7 preference discussion with the user. Later the actor acknowledged stale checkpoint reports after completing the underlying work, and made document accuracy updates after the last verifier hand-back. In the dogfood session, the actor explained the builder, investigated the verifier's evidence mismatch, and offered a code fix. The user later explicitly authorized that fix. In the newest session, the rejected third builder's approximately **20,932-character** report was delivered into the main conversation; the actor called it stale and responded to it anyway.

This creates extra actor turns and context growth while the compactor is trying to reduce context. Internal reports then become archive evidence and apparent turns for later preparations. The local person-origin fix stops them being labeled user corrections, but `segmentTurns()` still treats every non-tool-result user-role row as a turn. Reminders and hand-backs therefore still inflate manifests. The newest preparation began with 390 archived rows and 127 apparent turns, despite one substantive user task in that session. The promised minimum of recent turns needs a clearly defined relationship to actual person prompts and injected messages.

Owned checkpoint reports should be consumed through the control path without waking the actor or entering its task history. Test both successful and rejected attempts; an invalid draft should never become a visible peer report to the actor.

**Schema behavior and checkpoint quality.**

The schema validator correctly rejected all four completed submissions from the newest session. I replayed their actual JSON through the current validator:

| Builder | Rejection |
|---|---|
| `a21b54511dee93cb4` | Verification item 16 used `blocked`, outside `verified|unverified`. |
| `a8f265d6919ba7b01` | Constraint items were strings instead of `{text,evidenceRefs}` objects; most other sections had the same defect. |
| `a8fa738c099ac2bac` | Verification items used `failed` and `blocked`. |
| `a31f38797cfb8ff87` | Verification items used `failed`, `blocked`, and `pending`. |

This is fail-closed behavior worth preserving. However, restarting an agent and rereading the entire archive to repair one enum is disproportionately expensive. The prompt shows an object example only for the objective and verification sections; every other section is an empty array. Give every populated section a complete example, make failure/pending representations explicit, and use constrained serialization or a bounded JSON-repair path where available. Verification grounding and task outcome are distinct concepts; the current two-value status is being confused with pass/fail/blocked outcomes.

The substantive first draft is useful: it preserves the user's integration/evaluation goal, the requirement to produce a conclusions document, exact commit and file names, scratch database handling, pending evaluator jobs, the distinction between a baseline failure and new fixes, and actual five-pass Rust / 52-pass Python results. I checked representative claims against the archived tool results, including the failing baseline, its reproduction, and the later passing regression suites. Those facts are largely grounded. It does not falsely report that the requested final conclusions document was written.

The drafts are also repetitive: the larger completed drafts contain **86–104 items and about 20–27k JSON characters**. Completed work, current state, decisions, critical context, and verification often repeat the same fixes and results. Some proposed next actions chase evidence rows that do not exist in the supplied file because of the snapshot race. Later drafts become stale while several minutes of reading and generation elapse. No completed newest-session draft reached the verifier, so it would be misleading to call its checkpoint quality verified.

**The rendered checkpoint does not preserve the advertised evidence schema.** [`hooks/checkpoint.ts:279`](/home/joshsimon/Projects/pi-extensions/claude-shadow-compact/hooks/checkpoint.ts:279) writes only item text; it omits `evidenceRefs`. It also receives no coverage object, and emits neither coverage metadata nor schema/prompt versions. The typed `ShadowCheckpoint.schemaVersion` is not part of the actual `PublishedCheckpoint` persisted record. The main model would receive readable sections and verification labels, but not the cited, coverage-bearing checkpoint illustrated in the README. Occasional evidence IDs inside prose are incidental, not serialized citations. Coverage and citations need to survive rendering; persisted records need explicit versioning and validation on restore.

**Evidence and persistence have additional correctness gaps.**

- The installed copy freezes the evidence file but passes the growing live archive to manifests and validation. In dogfood, the verifier saw a manifest of eight rows but could read only five. In the newest session, retries advertised 433 rows while the file still ended at row 390. This caused invented open loops and repeated reads. The checkout's `snapshot()` change addresses this race, but is absent from the installed cache and has not been tested in these production sessions.
- `EvidenceArchive` is in memory. [`evidenceAccess()`](/home/joshsimon/Projects/pi-extensions/claude-shadow-compact/hooks/register.ts:157) writes a file when preparation begins; each append does not durably update it. Startup never reloads that file. After resume, bootstrap uses the current summary and retained messages, so original historical evidence can be lost and evidence IDs reassigned. The README's durable-original-evidence promise is not met across restart.
- File-write failure is swallowed. An agent can then be told to read a missing or older evidence file. Prefer an explicit failed preparation or a correctly bounded alternate source.
- The fallback inlines only the **first 120,000 characters**, without reconciling the manifest with the rows actually included. The newest file was about 302k bytes at capture. Recent work is outside that fallback prefix. The current snapshot fix does not fix this truncation policy.
- The archive permits a notice as the coverage endpoint although notices are absent from `SessionMessage` order. The fourth newest-session builder selected E0456, an empty `notice`, as its boundary. That submission failed schema validation first, but even a format repair would not give it a valid transcript coverage anchor. The old WrapArtist checkpoint already persisted `coverageMessageIndex=-1`.
- Sanitization globally replaces backslashes with slashes whenever cwd is nonempty. In actual evidence, tool-call JSON containing escaped quotes and newlines became ` /" ` and `/n` sequences; regex escapes are similarly affected. This undermines exact command/code preservation. Normalize path values or matched cwd substrings without rewriting arbitrary escaped content.
- Read/Grep limits restrict tool types rather than paths. Older side agents read the raw live transcript, repository files, and task output outside the sanitized archive. Their repairs sometimes rely on those reads while citing archive evidence IDs. A strictly evidence-grounded audit needs explicit, enforced read scope and provenance.

**Is independent review worth the tokens?**

It has demonstrated quality value, but the current end-to-end implementation has not earned its cost.

The earlier Opus verifier caught substantive problems: the user's chosen C1–C7 scope was misstated, code line ranges were wrong, a claim that failures were inherited upstream was unsupported, an unexecuted historical test suite was being confused with an observed baseline, and relevant consumers were omitted. These are meaningful continuation corrections. The small Haiku verifier also identified the file/manifest mismatch. The four recorded verifier runs all returned `repair`; none was simply an accept.

Some review effort was spent repairing extension-generated inconsistencies and stale state. The first two Opus verifier results advanced beyond their preparations' original coverage snapshots and did not become the final saved checkpoint. Even the final saved checkpoint was followed by native compaction. No sampled run shows those review tokens improving an installed Shadow continuation.

The counts below deduplicate streamed assistant blocks by API message ID. Cache reads are shown separately; they are not fresh input tokens. Some `SubagentHandback` terminal rows contain only partial output usage, so **reported output is a lower bound**, not a complete billing total. No dollar estimate is inferred.

| Work | Model | API requests | Cache creation input | Cache-read input | Reported output ≥ |
|---|---|---:|---:|---:|---:|
| Newest four completed failed builders | Haiku | 56 | 607,718 | 5,153,178 | 21,000 |
| Newest fifth builder, partial at capture | Haiku | 15 | 166,674 | 1,383,540 | 3,353 |
| Earlier three builders, `3f0a2848…` | Opus | 61 | 417,654 | 6,984,414 | 20,370 |
| Earlier three verifiers, `3f0a2848…` | Opus | 62 | 376,825 | 5,960,066 | 24,854 |

The newest failures alone consumed over **5.15 million cached input tokens and 607k cache-creation tokens across completed attempts**, before any reviewer ran. The prior verifier added roughly another builder's worth of requests and input. Actor responses to leaked reports and eventual native compaction are additional overhead, not included in those rows. More economical models help, but do not resolve repeated full-history work, stale generation, failed schemas, or unused checkpoints.

Keep the independent-review concept while making its value measurable. Compare native compaction, builder-only checkpoints, and builder-plus-verifier on identical frozen histories. Score objective/constraint retention, factual support, exact identifiers, unresolved failures, and continuation success; include side-agent usage, actor wakes, installation success, and later native compaction in the total. Once deterministic coverage checks work, consider bounded review of high-risk claims or changed sections, validated against a full-review baseline. These logs support useful error detection, not a demonstrated quality-per-token win.

**Checks completed and evidence artifacts.**

`npm run check` passed: TypeScript, Claude plugin validation, and **27/27 tests**. Existing engine integration tests cover status and no-checkpoint fallback. They do not install a prepared checkpoint, inspect canonical post-compaction history, or exercise a second Shadow cycle or resume. The tail test is named as preserving handles but its fixture does not provide real handles. Passing it is insufficient evidence of actual handle preservation.

I compiled the existing code into this temporary directory and ran isolated replays without model calls or live state changes. They reproduce: uncovered-message loss with the default ten-turn setting; unsafe positional restore; dropped citations/coverage; index loss under the modeled summary-append lifecycle; duplicate-append divergence; peer reports still becoming turns; and repeated compaction scheduling after native fallback. The lifecycle replay is conditional on the modeled append order and needs host-level confirmation; the coverage and positional-anchor failures do not depend on that ordering.

Artifacts: [session and agent analysis](/tmp/claude-shadow-compact-audit-2026-10-18/analysis.json), [schema validation results](/tmp/claude-shadow-compact-audit-2026-10-18/schema-results.json), [behavioral replay source](/tmp/claude-shadow-compact-audit-2026-10-18/replay.mjs), and [behavioral replay results](/tmp/claude-shadow-compact-audit-2026-10-18/replay-results.json). Frozen raw transcripts, available evidence files, and store snapshot are alongside them.

Representative original evidence: [newest leaked draft and response](/home/joshsimon/.claude/projects/-home-joshsimon-Projects-briefcase/75403b08-035d-4413-8700-03dba24f1f30.jsonl:1031), [earlier native compaction](/home/joshsimon/.claude/projects/-home-joshsimon-Projects-briefcase/3f0a2848-7728-4883-a6c3-e93371f1ccb6.jsonl:541), [dogfood native compaction](/home/joshsimon/.claude/projects/-home-joshsimon-Projects-pi-extensions-claude-shadow-compact/1e6fb518-62c3-4bc8-bf70-8610c012a0ec.jsonl:130). Use frozen copies for reproducibility if the originals are later rewritten.

**Required release evidence, in order.**

1. Fix both P0 coverage defects. Add adversarial coverage tests for partial turns, multiple tool pairs, native compaction, resume/rewind, missing UUIDs, and same-length histories containing different content. Every removed row must be proven covered.
2. Demonstrate two consecutive Shadow installations through the actual host, followed by resume. Inspect canonical history and the next model request, verify checkpoint identity, preserve exact tail handles/content including media and tool pairs, and verify index alignment after every append. Test precompute and `/compact-native` semantics as well.
3. Keep owned side-agent hand-backs out of the acting conversation. Demonstrate zero actor wakes for successful, rejected, timed-out, and cancelled preparations. Enforce bounded retries and resource limits; avoid restarting an entire history read for a one-field JSON repair.
4. Deploy the frozen-snapshot fix as a distinguishable release. Make evidence durable and reloadable, bind file/manifest/coverage to one immutable generation, reject unreadable/truncated evidence, preserve code escapes, and validate versioned persisted records.
5. Add structured audit events: session/generation, loaded-code version/hash, trigger, builder/verifier models and usage, validation failure, verifier verdict/repair reason, coverage UUID and indices, tail start, shrink estimate, every skip/fallback reason, and confirmed installation. Capture engine rejection/expiry traces where supported. `/shadow-status` should distinguish prepared, attempted, deferred, failed, and installed states.
6. Run the fixed pipeline against frozen real histories and the native/builder/reviewer comparison. Release only after it demonstrates successful safe installs, improved continuation quality, and a bounded token cost. A checkpoint-ready notice and passing unit tests are not sufficient acceptance criteria.

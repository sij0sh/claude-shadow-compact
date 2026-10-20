# Investigation of Shadow Compact 0.4.12

Investigated on October 19, 2026. Times below are PDT. This is an investigation
and recommendation report; runtime code and installed plugin settings were not
changed.

Follow-up: [0.4.13](release-0.4.13.md) implements the subsequent request to remove
extension-imposed scope/size limits and use medium effort, superseding the
increased-limit recommendations below. The findings here describe 0.4.12.

The available 0.4.12 records contain **two preparation attempts, one live
compaction trigger, zero verified checkpoints, and zero Shadow installations**.
Both preparations failed in the builder before verification. Native recovery
completed successfully after the live attempt failed.

The immediate failure is reproducible: the builder's 8,192-token generation
allowance is exhausted by thinking before it can answer. The worker then hides
the CLI's structured error and classifies it as a retryable transport failure,
repeating the same unsuccessful request.

The historical worker files preserve only exit codes. Token exhaustion is a
high-confidence diagnosis from replaying the exact saved request with the same
model, effort, and token allowance, rather than a recovered historical API
error. The original session used Claude Code 2.1.303; the installed executable
used for replay was 2.1.304.

All available plugin diagnostic directories and recent persisted main-session
transcripts were checked. Only two sessions have 0.4.12 event records:

| Session | Recorded behavior | Outcome |
| --- | --- | --- |
| `aaf0cbb1-58b4-477a-96b8-b9636c38fe3d` (Briefcase) | Background preparation, then one automatic compaction | Both preparations failed; native compaction completed |
| `e045278b-24b9-4f0d-8a40-6e611c1584c4` (extension repository) | Initialization, window configuration, status command | No recorded preparation or live compaction; does not establish success |

No other 0.4.12 preparation, manual/idle compaction, verification success, or
installation confirmation was found. Older sessions still running 0.4.11 were
excluded from these counts. Absence of records cannot establish behavior in
sessions whose diagnostics were deleted or never written.

| Time | Event | Result |
| --- | --- | --- |
| 14:09:44.995 | Background preparation, generation 1, 169 source rows | Builder started with `haiku`, `high`, 8,192 tokens |
| 14:12:17.157 | First CLI failed after 152.098 seconds | Classified `worker_failed`; 60-second retry wait |
| 14:13:17.162 | Builder retry | Same model, effort, and allowance |
| 14:15:50.763 | Second CLI failed after 153.561 seconds | Preparation failed after 365.810 seconds; no verifier call |
| 14:21:30.484 | Automatic compaction, 241 messages | No checkpoint; host measurement 194,711 tokens; preparation restarted |
| 14:21:30.535 | Generation 2 builder started | Same model, effort, and allowance |
| 14:23:59.991 | First CLI failed after 149.422 seconds | Another 60-second retry wait |
| 14:24:59.995 | Builder retry | Same request policy |
| 14:27:27.421 | Second CLI failed after 147.390 seconds | Preparation failed after 356.937 seconds; no verifier call |
| 14:27:27.594 | Shadow released the live compaction to native recovery | `waited=357s:failed` |
| 14:28:19.997 | Native compaction completed | Persisted compact boundary confirms completion |

The original compaction boundary reports 210,280 tokens before compaction and
9,959 afterward, with 409.275 seconds total duration. That total includes the
Shadow wait plus approximately 52.4 seconds of native compaction. The host's
boundary token count and the plugin's earlier measurement are different
observations; they should not be treated as interchangeable.

The intended background checkpoint and verified replacement did not work. The
failure recovery did: no unverified checkpoint was installed, and the session
continued using native summarization. Shadow's exact recent-tail guarantees
were not exercised by that native result.

Several suspected causes are ruled out for this incident. The 240,000-token
window override was confirmed effective with source `env`, superseding the
saved 190,000 setting. The wait crossed its 240-second lease and ended after
preparation failed. Individual CLI failures happened well before their
595-second child deadlines. History setup took approximately 2 ms. Neither
verification nor installation eligibility was reached.

The relevant installed source and built worker match the repository's 0.4.12
files byte for byte. The failure can be traced through three small areas:

1. [Preparation requests](../hooks/prepare.ts) give the builder 8,192 generation
   tokens and the verifier 4,096. [The worker](../worker/claude-checkpoint-worker.ts)
   passes those values to `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. Thinking and the visible
   response share that allowance. A 4,096-token visible-answer limit does not
   imply that 8,192 total tokens will accommodate high-effort reasoning.
2. The worker rejects nonzero CLI exits before decoding stdout, drains stderr,
   and returns only `Claude CLI exited 1`. The useful error in this reproduction
   is already in JSON on stdout; recovering it does not require logging prompts
   or adding a debug logging subsystem.
3. Every generic `worker_failed` result is marked retryable. The existing
   [role executor](../hooks/register.ts) waits 60 seconds and repeats it. Token
   exhaustion is therefore treated as a transient transport error. A later live
   preparation repeats the same policy again.

A minimal Haiku request using the worker's command flags succeeded in 1.33
seconds. The saved generation 2 builder request then failed in 147.28 seconds,
closely matching the four original failures at 147–154 seconds. Its CLI result
contained:

```json
{
  "is_error": true,
  "api_error": "max_output_tokens",
  "terminal_reason": "api_error",
  "num_turns": 4,
  "usage": {
    "output_tokens": 32768,
    "output_tokens_details": { "thinking_tokens": 32768 }
  }
}
```

The CLI made four API requests despite `--max-turns 1` and
`CLAUDE_CODE_MAX_RETRIES=0`: its internal output-limit recovery exhausted four
8,192-token allocations, entirely on thinking. There was no checkpoint text.
The process exited 1; stderr was empty. The human-readable result explicitly
reported the 8,192 output-token maximum. Its `subtype` was `success` and its
`stop_reason` was `stop_sequence`, so neither field alone would correctly
classify this error; `is_error` and `api_error` matter.

Anthropic documents that thinking consumes the same `max_tokens` allowance as
answer text, and recommends increasing that allowance or lowering effort when
it is exhausted. See [thinking cost control](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost#cost-control)
and [the Claude Code environment reference](https://code.claude.com/docs/en/env-vars).

Two controlled variations exposed additional problems beyond the original
token-limit failure. These are replay observations, not failures reached by the
historical session:

| Builder settings | CLI result | Existing checkpoint acceptance |
| --- | --- | --- |
| High effort, 8,192 tokens, original prompt | Exit 1 after 147.28 s; all 32,768 output tokens across four requests were thinking | No candidate |
| High effort, 32,768 tokens, original prompt | Exit 0 after 130.82 s; one request, 25,578 thinking tokens and 6,083 other output tokens | Rejected: 4,558 estimated visible tokens exceed the 4,096 limit; malformed submission also present |
| Medium effort, 8,192 tokens, original prompt | Exit 0 after 92.07 s; three requests, 13,537 thinking tokens and 6,800 other output tokens in total | Rejected: malformed submission |

Both completed answers put `coverageEndEntryId` inside `checkpoint`, whereas
the validator requires it alongside `checkpoint` at the top level. The high
effort answer also cited `E0194`, which was absent from its selected source
packet. The medium answer passed deterministic validation after moving only
the coverage field in a diagnostic copy; that copy was not installed or
accepted by the extension. Source reconstruction reproduced the saved builder
prompt exactly, including the same 78 selected and 163 omitted rows.

Consequently, changing only the generation cap or only the effort default is
insufficient to demonstrate that this extension works end to end. The current
validators correctly reject these answers. Relaxing them or accepting a partial
answer would conceal the problems.

A further controlled replay kept high effort, allowed 32,768 generation tokens,
and changed only two prompt sentences: require `coverageEndEntryId` to be a
top-level sibling of `checkpoint`, and request the whole JSON in fewer than
10,000 characters. It completed in 110.30 seconds with one API request, 21,609
thinking tokens, and a 9,137-character answer (3,046 estimated visible tokens).
That answer passed the existing deterministic checks, including selected-source
citations. It cited 38 source rows.

The next existing step failed before calling the verifier:
`evidence_budget_exceeded: protected or cited audit evidence cannot fit`.
The verifier's 12,000-token total input allowance must include the candidate,
required source rows, and prompt. Its remaining source allowance was only
7,979 estimated tokens. A curator allowed approximately 22,000 source tokens
can legitimately cite more evidence than that. This is another deterministic
budget mismatch, independent of model transport or wait timing.

With only the verifier input allowance increased to 32,768, the existing packet
builder could retain all mandatory citations and user requirements. The complete
verifier request was 32,012 estimated input tokens. This replay retained the
existing independent-verification prompt and validators.

With 32,768 generation tokens, that verifier finished in 79.82 seconds using one
API request and 18,703 thinking tokens. Its verdict fit the existing visible
limit, but rejected the candidate with seven issues. Thus **no successful
verified checkpoint was demonstrated by the replay experiments either**.

Reviewing the cited evidence confirmed examples of real problems: the candidate
copied an assistant's numerical interpretation despite contradictory raw output,
and presented a test-failure explanation without preserving a conflicting
reported assertion failure. These are grounding failures, not transport errors;
rejecting such a candidate is appropriate.

One verifier complaint was unsupported: it demanded obligations from `E0000`,
although the manifest explicitly has `previousCoverageEndEntryId: null`, no
previous checkpoint was supplied, and the candidate did not cite `E0000`.
The verifier prompt asks it to check "active obligations from E0000" without
conditioning that instruction on the presence of a prior checkpoint. This is a
small prompt-contract defect demonstrated by the replay. The other genuine
issues mean removing this complaint alone would not make the candidate pass.

Recommended changes, in order of dependency:

1. **Fix the existing budget constants.** Allow 32,768 generation tokens for
   each role while retaining the existing 4,096/1,024 estimated visible-answer
   limits. Use one shared generation constant instead of duplicating the
   builder/verifier values in the request builder and worker defaults. The
   tested valid builder needed 25,790 total output tokens; the verifier needed
   19,524. Those measurements explain why 8,192/4,096 are inadequate. They do not
   prove 32,768 is sufficient for every session or effort level.
2. **Make the verifier input budget cover what the builder may produce.** Set
   its existing input allowance to approximately 32k, including the candidate
   and prompt. Derive protected-source capacity as the minimum of each role's
   available source capacity. Specifically, raising `VERIFIER_INPUT_TOKENS`
   also raises the current `PROTECTED_BUDGET`; cap that calculation by
   `CURATOR_INPUT_TOKENS - PROMPT_RESERVE` so protected user instructions cannot
   outgrow the curator request. Keep the existing evidence selection and
   validation functions. This removes the demonstrated citation-budget cliff
   with a small constants/calculation change.
3. **Clarify the existing prompts.** State the two top-level submission keys
   explicitly and ask for a concrete compact character target, as in the tested
   prompt. Tell the curator to prefer actual tool results for factual findings
   and preserve conflicting reports as unresolved. Tell the verifier to check
   prior obligations only when `E0000` is present. Continue requiring exact
   source references and strict validation. These are short prompt edits;
   they are not a guarantee of model accuracy.
4. **Preserve and classify the CLI result before deciding to retry.** Decode
   bounded stdout even on exit 1; carry a safe error code such as
   `max_output_tokens`, `is_error`, and API status through the existing private
   result file. Use the existing one-retry mechanism only for identifiable
   transient transport/capacity failures. Token exhaustion, invalid submissions,
   authentication/configuration errors, and rejected verification should settle
   explicitly. The demonstrated case should not pay another 60-second wait and
   identical failed invocation. No additional logging service, retry layer,
   adaptive controller, or user setting is needed.

Before release, add focused regressions for JSON errors on nonzero CLI exit,
terminal-versus-transient retry behavior, and a legal builder candidate whose
mandatory citations exceed the former verifier source allowance. Then replay
both saved preparation snapshots through the real builder and verifier and
confirm a successful installation in a disposable host session. Keep the
existing strict checks in that acceptance test. The present experiments show
why the mechanical changes are necessary, while leaving factual checkpoint
quality and a real successful installation unproven.

The live evidence supports the existing window override, renewable wait, and
native recovery. Changes should concentrate on request budgets, prompt
contracts, and error classification. Larger deadlines or more retry/repair
machinery would not address the failures found here.

Validation completed during this investigation: `npm test` passed 101 of 103
tests, with two host-fixture tests skipped; `npm run typecheck:core` passed;
`claude plugin validate .` passed with metadata warnings. Full `npm run typecheck`
could not resolve the missing generated `.claude-plugin/types/tsconfig.json`
and host modules. The existing worker tests use fake successful CLIs and do not
exercise a real JSON error on a nonzero exit.

Original evidence remains under:

```text
~/.claude/plugins/cache/claude-shadow-compact/shadow-compact/0.4.12/.shadow-data/
  aaf0cbb1-58b4-477a-96b8-b9636c38fe3d/
    events/cf9197e9-5c75-4487-9a03-9028beb0a130-000001.json ... 000021.json
    prepare-cf9197e9-5c75-4487-9a03-9028beb0a130-{1,2}/
      builder-request.json
      claude-builder-*-result.json
      outcome.json
~/.claude/projects/-home-joshsimon-Projects-briefcase/
  aaf0cbb1-58b4-477a-96b8-b9636c38fe3d.jsonl
```

Replay diagnostics are private temporary files under
`/tmp/shadow-0412-probe-5bjxbq3y/` and
`/tmp/shadow-0412-replay-zerphzt7/`, with controlled variations under
`/tmp/shadow-0412-comparison-eiy0ogey/` and
`/tmp/shadow-0412-prompt-check-2ajvw35l/`. Source prompts and checkpoint contents
are not copied into this report.

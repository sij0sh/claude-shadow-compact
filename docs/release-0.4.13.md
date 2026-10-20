# Shadow Compact 0.4.13

The 0.4.12 builder could spend its entire generation allowance on thinking, then
lose the CLI's token-limit error and repeat the failed request. Larger answers
also hit independent character, item, and verifier input limits.

Scope is now expressed in the curator and verifier prompts. Both roles receive
complete sanitized evidence for the covered snapshot. The extension no longer
clips evidence, budgets source packets, caps model generation or visible answer
size, limits item/reference counts, or rejects a large CLI response. It clears
inherited output/thinking caps and leaves model limits to Claude Code and the
provider. Default checkpoint effort is medium.

The curator prompt explicitly places coverage beside the checkpoint, prefers
observed results to assistant interpretations, and preserves unresolved
conflicts. The verifier checks prior checkpoint obligations only when one is
present and assesses material factual and continuation problems. Additional
grounded detail alone is not a reason to reject.

Nonzero CLI exits are decoded before classification. Safe machine error codes
and HTTP status survive in existing private results. Identified transient API
errors remain eligible for the existing one retry; token exhaustion and
authentication errors settle without repeating an unchanged request.

Schema, grounding, coverage and prefix identity, independent verification,
exact recent-tail preservation, host capacity, and compaction savings checks
remain required. Cancellation and host process deadlines still apply. No
regeneration pipeline or new settings were added.

An already verified checkpoint that cannot fit the host's replacement capacity
or save context falls back to native compaction directly. It is not regenerated
solely to make it smaller.

Validation includes portable hook and actual worker-process regressions for
large evidence/candidates/verdicts, a response beyond the former 4 MiB transport
cap, structured CLI errors, terminal retry behavior, and avoiding size-only
regeneration. Core and worker TypeScript checks pass. Full repository type
checking remains blocked by the pre-existing missing generated host declarations
under `.claude-plugin/types/`.

`npm run check` passed: 105 tests passed and two host-fixture tests were skipped.
`claude plugin test .` passed all 95 hook tests, including those host fixtures.
`claude plugin validate .` passed with metadata/documentation warnings.

A real Claude Code 2.1.304 replay of the saved generation 2 source snapshot used
medium effort, all 241 archived source rows, and no extension generation cap.
The builder completed in 105.7 seconds with a 14,924-character answer (4,978
estimated tokens, exceeding the former 4,096 limit). It passed deterministic
validation and reached the verifier without a retry. The verifier completed in
58.4 seconds. Estimated request inputs were 85,382 and 89,743 tokens; no source
rows were omitted by packet selection.

The verifier rejected four material factual/attribution issues. This replay
therefore demonstrates removal of the old size/budget failures and successful
execution of both roles, not a verified installation. Rejection for unsupported
claims remains intentional. The archived source rows already contain the old
0.4.12 clipping; this replay cannot restore text that version discarded. Private
replay artifacts are in `/tmp/shadow-0413-live-lyDdcn/`.

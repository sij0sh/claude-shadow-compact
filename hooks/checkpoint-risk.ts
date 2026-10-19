/** Conservative routing hints, not semantic verification or evidence entailment. */
import { SECTIONS } from "./checkpoint.js";
import { isPersonPrompt, PREVIOUS_CHECKPOINT_EVIDENCE_ID, type EvidenceArchive } from "./evidence.js";
import type { ValidatedSubmission } from "./checkpoint-validation.js";

export interface RiskReason { code: string; evidenceRefs: string[] }
export interface CheckpointRisk { level: "low" | "high"; reasons: RiskReason[] }

const SUCCESS = /\b(pass(?:ed|ing)?|succeed(?:ed)?|successful(?:ly)?|fixed|resolved|deployed|completed|accepted|approved|confirmed|all tests|fully)\b/i;
const UNRESOLVED = /\b(fail(?:ed|ure)?|error|blocked|unresolved|conflict)\b/i;

export function classifyCheckpointRisk(draft: ValidatedSubmission, archive: EvidenceArchive): CheckpointRisk {
  const end = archive.indexOf(draft.coverageEndEntryId);
  const checkpoint = draft.checkpoint;
  const reasons = new Map<string, Set<string>>();
  const add = (code: string, refs: readonly string[] = []) => {
    const set = reasons.get(code) ?? new Set<string>();
    refs.forEach(ref => set.add(ref));
    reasons.set(code, set);
  };
  const items = [...SECTIONS.flatMap(section => checkpoint[section]), ...checkpoint.verificationState];
  const cited = new Set(items.flatMap(item => item.evidenceRefs));
  const previous = archive.previousCoverageEndEntryId;
  const previousIndex = previous === null ? -1 : archive.indexOf(previous);
  for (const entry of archive.evidenceIndex().slice(0, end + 1)) {
    for (const signal of entry.signals) add(`source-${signal}`, [entry.evidenceId]);
    const row = archive.rows[entry.position]!;
    if (entry.position > previousIndex && isPersonPrompt(row) && row.isTranscript !== false && !cited.has(entry.evidenceId)) {
      add("uncited-user-context", [entry.evidenceId]);
    }
  }
  for (const item of items) {
    if (/\b\d+(?:\.\d+)*\b/.test(item.text)) add("quantitative-claim", item.evidenceRefs);
    if (SUCCESS.test(item.text)) add("success-or-status-claim", item.evidenceRefs);
    if (item.evidenceRefs.every(ref => ref === PREVIOUS_CHECKPOINT_EVIDENCE_ID)) add("previous-checkpoint-only", item.evidenceRefs);
  }
  // Negation elsewhere in a paragraph cannot make a positive subclaim safe.
  const continuation = Object.values(checkpoint.continuationState).join("\n");
  if (SUCCESS.test(continuation) || /\b\d+(?:\.\d+)*\b/.test(continuation)) add("continuation-claim");
  if (checkpoint.completedWork.length) add("completed-work", checkpoint.completedWork.flatMap(item => item.evidenceRefs));
  if (checkpoint.verificationState.some(item => item.status === "verified")) add("verified-claim");
  if (checkpoint.decisions.length > 1 || checkpoint.openIssues.length || checkpoint.verificationState.some(item => UNRESOLVED.test(item.text))) add("unresolved-or-conflicting-state");
  return { level: reasons.size ? "high" : "low", reasons: [...reasons].map(([code, refs]) => ({ code, evidenceRefs: [...refs] })) };
}

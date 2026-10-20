/** Deterministic integrity checks. Passing these does not establish semantic accuracy. */
import { requireContinuation, SECTIONS, validateCheckpointObject, type Checkpoint } from "./checkpoint.js";
import { isCoverageRow, PREVIOUS_CHECKPOINT_EVIDENCE_ID, type EvidenceArchive } from "./evidence.js";

export interface ValidatedSubmission {
  checkpoint: Checkpoint;
  coverageEndEntryId: string;
}

export class CheckpointValidationError extends Error {
  constructor(message: string, readonly repairable = true) { super(message); }
}

export function validateSubmission(
  value: unknown,
  archive: EvidenceArchive,
  refs: Set<string> = archive.knownRefs(),
): ValidatedSubmission {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Submission must be a JSON object");
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (key !== "checkpoint" && key !== "coverageEndEntryId") throw new Error(`Unexpected submission key: ${key}`);
    }
    const checkpoint = validateCheckpointObject(source.checkpoint, refs);
    requireContinuation(checkpoint);
    if (!checkpoint.objective.length) throw new Error("Checkpoint objective needs at least one grounded item");
    const coverage = source.coverageEndEntryId;
    if (typeof coverage !== "string" || !coverage) throw new Error("coverageEndEntryId must name the last covered session row");
    const end = archive.indexOf(coverage);
    const row = archive.rows[end];
    if (!row) throw new Error(`coverageEndEntryId is not a session row: ${coverage}`);
    if (!isCoverageRow(row)) {
      throw new Error(`coverageEndEntryId must name a user or assistant row, not ${row.door}`);
    }
    const previous = archive.previousCoverageEndEntryId;
    const previousIndex = previous === null ? -1 : archive.indexOf(previous);
    if (previous !== null && previousIndex < 0) throw new CheckpointValidationError("Previous checkpoint coverage is absent from the evidence snapshot", false);
    if (end < previousIndex) throw new Error("coverageEndEntryId regresses the previous checkpoint coverage");
    const byRef = new Map(archive.rows.map((entry, index) => [entry.evidenceId, index]));
    for (const item of [...SECTIONS.flatMap(section => checkpoint[section]), ...checkpoint.verificationState]) {
      for (const ref of item.evidenceRefs) {
        if (ref !== PREVIOUS_CHECKPOINT_EVIDENCE_ID && (byRef.get(ref) ?? Infinity) > end) {
          throw new Error(`Evidence reference ${ref} is beyond coverageEndEntryId ${coverage}`);
        }
      }
    }
    return { checkpoint, coverageEndEntryId: coverage };
  } catch (error) {
    if (error instanceof CheckpointValidationError) throw error;
    throw new CheckpointValidationError(error instanceof Error ? error.message : String(error));
  }
}

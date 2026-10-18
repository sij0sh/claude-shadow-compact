/**
 * Durable evidence archive (spec §4.2). `session.append` hands every
 * transcript row to the mod before storage under a stable uuid; this
 * archive mirrors main-loop rows in append order, sanitizes their text,
 * and serves the builder/verifier through a manifest + paged file.
 * Evidence ids (`E0001`, ...) are stable per archive position; `E0000`
 * names the previous checkpoint, exactly as in the Pi version.
 */
import { estimateTokens, redactSecretValue, sanitizeForContext } from "./normalize.js";

export const PREVIOUS_CHECKPOINT_EVIDENCE_ID = "E0000";

export function evidenceIdForIndex(index: number): string {
  return `E${String(index + 1).padStart(4, "0")}`;
}

export interface EvidenceRow {
  /** Claude transcript row uuid (synthetic `bootstrap-N` for pre-install rows). */
  id: string;
  evidenceId: string;
  /** Request role, when the row carries one. */
  role?: "user" | "assistant";
  door: string;
  text: string;
  /** Tool names called by an assistant row. */
  toolNames: string[];
  /** True when the row carries a tool result. */
  hasToolResult: boolean;
  isError: boolean;
  /** `session.append` origin kind; absent for bootstrap rows. */
  originKind?: string;
}

/** Origins that are the person speaking, the only source of user corrections. */
const PERSON_ORIGINS = new Set(["composer", "bridge", "sdk"]);

/** True for a user row the person wrote (bootstrap rows carry no origin). */
export function isPersonPrompt(row: EvidenceRow): boolean {
  if (row.role !== "user" || row.hasToolResult) return false;
  return row.originKind === undefined || PERSON_ORIGINS.has(row.originKind);
}

export interface EvidenceTurn {
  turnId: string;
  index: number;
  startRowId: string;
  endRowId: string;
  rowIds: string[];
}

const CORRECTION_SIGNALS =
  /\b(no\b|wrong|incorrect|instead|actually|not that|fix\b|should\b|must\b|never\b|always\b|don't\b|do not\b|require[sd]?|prefer|prohibit)/i;
const MAX_ROW_TEXT_CHARS = 4_000;

interface BlockLike {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
  content?: unknown;
  is_error?: unknown;
}

/** Normalizes one `session.append` message into an archive row. */
export function rowFromAppend(
  uuid: string,
  door: string,
  message: { type: string; role?: string; content: unknown },
  cwd: string,
  index: number,
  originKind?: string,
): EvidenceRow {
  const blocks: BlockLike[] = Array.isArray(message.content)
    ? (message.content as BlockLike[])
    : [];
  const parts: string[] = [];
  const toolNames: string[] = [];
  let hasToolResult = false;
  let isError = false;
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "tool_use") {
      if (typeof block.name === "string") toolNames.push(block.name);
      parts.push(
        `[tool_use ${String(block.name ?? "?")} ${JSON.stringify(redactSecretValue(block.input ?? {}))}]`,
      );
    } else if (block.type === "tool_result") {
      hasToolResult = true;
      if (block.is_error === true) isError = true;
      const inner = Array.isArray(block.content)
        ? (block.content as BlockLike[])
            .filter((part) => part.type === "text" && typeof part.text === "string")
            .map((part) => part.text as string)
            .join("\n")
        : typeof block.content === "string"
          ? block.content
          : "";
      parts.push(`[tool_result${block.is_error === true ? " error" : ""} ${inner}]`);
    }
  }
  const role =
    message.role === "user" || message.role === "assistant" ? message.role : undefined;
  return {
    id: uuid,
    evidenceId: evidenceIdForIndex(index),
    ...(role ? { role } : {}),
    door,
    text: sanitizeForContext(parts.join("\n"), cwd).slice(0, MAX_ROW_TEXT_CHARS),
    toolNames,
    hasToolResult,
    isError,
    ...(originKind ? { originKind } : {}),
  };
}

/** Segments rows into user-anchored turns; leading rows join turn 1. */
export function segmentTurns(rows: readonly EvidenceRow[]): EvidenceTurn[] {
  if (rows.length === 0) return [];
  const starts: number[] = [];
  rows.forEach((row, index) => {
    if (row.role === "user" && !row.hasToolResult) starts.push(index);
  });
  const effective = starts.length > 0 ? starts : [0];
  return effective.map((start, t) => {
    const end = (t + 1 < effective.length ? effective[t + 1]! : rows.length) - 1;
    return {
      turnId: `turn-${t + 1}`,
      index: t,
      startRowId: rows[t === 0 ? 0 : start]!.id,
      endRowId: rows[end]!.id,
      rowIds: rows.slice(t === 0 ? 0 : start, end + 1).map((row) => row.id),
    };
  });
}

export interface SessionManifest {
  rowCount: number;
  turnCount: number;
  firstRowId: string | null;
  lastRowId: string | null;
  previousCoverageEndEntryId: string | null;
  hasPreviousCheckpoint: boolean;
  requiredTurnIds: string[];
  turns: Array<{
    turnId: string;
    startEvidenceId: string;
    endEvidenceId: string;
    userPreview: string;
    hasUserCorrection: boolean;
    hasError: boolean;
    tokenEstimate: number;
  }>;
}

export class EvidenceArchive {
  readonly rows: EvidenceRow[] = [];
  readonly #indexById = new Map<string, number>();
  #previousCheckpointSummary: string | undefined;
  #previousCoverageEndEntryId: string | null = null;

  constructor(private readonly cwd: string) {}

  get size(): number {
    return this.rows.length;
  }

  /** Appends a row; returns false for a duplicate uuid (append replays). */
  add(row: EvidenceRow): boolean {
    if (this.#indexById.has(row.id)) return false;
    const stored: EvidenceRow = { ...row, evidenceId: evidenceIdForIndex(this.rows.length) };
    this.#indexById.set(stored.id, this.rows.length);
    this.rows.push(stored);
    return true;
  }

  addAppend(
    uuid: string,
    door: string,
    message: { type: string; role?: string; content: unknown },
    originKind?: string,
  ): boolean {
    return this.add(rowFromAppend(uuid, door, message, this.cwd, this.rows.length, originKind));
  }

  /**
   * A frozen copy of rows `0..lastIndex` with the same previous checkpoint.
   * Preparation reads only this, so the evidence file, manifest, and ref
   * validation agree even while the live archive keeps growing.
   */
  snapshot(lastIndex: number): EvidenceArchive {
    const copy = new EvidenceArchive(this.cwd);
    for (const row of this.rows.slice(0, lastIndex + 1)) copy.add(row);
    copy.setPreviousCheckpoint(this.#previousCheckpointSummary, this.#previousCoverageEndEntryId);
    return copy;
  }

  /** Seeds rows that predate installation (from `$.session.messages()`). */
  bootstrap(messages: readonly { role: "user" | "assistant"; text: string }[]): void {
    messages.forEach((message, index) => {
      this.add({
        id: `bootstrap-${index}`,
        evidenceId: evidenceIdForIndex(this.rows.length),
        role: message.role,
        door: "bootstrap",
        text: sanitizeForContext(message.text, this.cwd).slice(0, MAX_ROW_TEXT_CHARS),
        toolNames: [],
        hasToolResult: false,
        isError: false,
      });
    });
  }

  setPreviousCheckpoint(summary: string | undefined, coverageEndEntryId: string | null): void {
    this.#previousCheckpointSummary = summary;
    this.#previousCoverageEndEntryId = coverageEndEntryId;
  }

  get previousCoverageEndEntryId(): string | null {
    return this.#previousCoverageEndEntryId;
  }

  previousCheckpoint(): { evidenceId: string; summary: string } | null {
    if (this.#previousCheckpointSummary === undefined) return null;
    return {
      evidenceId: PREVIOUS_CHECKPOINT_EVIDENCE_ID,
      summary: this.#previousCheckpointSummary,
    };
  }

  indexOf(id: string): number {
    return this.#indexById.get(id) ?? -1;
  }

  /** Every evidence id a checkpoint may cite. */
  knownRefs(): Set<string> {
    const refs = new Set(this.rows.map((row) => row.evidenceId));
    if (this.#previousCheckpointSummary !== undefined) {
      refs.add(PREVIOUS_CHECKPOINT_EVIDENCE_ID);
    }
    return refs;
  }

  turns(): EvidenceTurn[] {
    return segmentTurns(this.rows);
  }

  manifest(): SessionManifest {
    const turns = this.turns();
    const previousIndex =
      this.#previousCoverageEndEntryId === null
        ? -1
        : this.indexOf(this.#previousCoverageEndEntryId);
    const required = new Set<string>();
    if (turns.length > 0) required.add(turns[0]!.turnId);
    for (const turn of turns) {
      // Turns starting after the previous coverage boundary, and every
      // turn carrying an error, must be inspected before submission.
      if (this.indexOf(turn.startRowId) > previousIndex) required.add(turn.turnId);
      const turnRows = turn.rowIds
        .map((id) => this.rows[this.indexOf(id)])
        .filter((row): row is EvidenceRow => row !== undefined);
      if (turnRows.some((row) => row.isError)) required.add(turn.turnId);
    }
    return {
      rowCount: this.rows.length,
      turnCount: turns.length,
      firstRowId: this.rows[0]?.id ?? null,
      lastRowId: this.rows[this.rows.length - 1]?.id ?? null,
      previousCoverageEndEntryId: this.#previousCoverageEndEntryId,
      hasPreviousCheckpoint: this.#previousCheckpointSummary !== undefined,
      requiredTurnIds: [...required],
      turns: turns.map((turn) => {
        const turnRows = turn.rowIds
          .map((id) => this.rows[this.indexOf(id)])
          .filter((row): row is EvidenceRow => row !== undefined);
        const firstUser = turnRows.find((row) => row.role === "user");
        return {
          turnId: turn.turnId,
          startEvidenceId: turnRows[0]?.evidenceId ?? "",
          endEvidenceId: turnRows[turnRows.length - 1]?.evidenceId ?? "",
          userPreview: (firstUser?.text ?? "").slice(0, 120),
          hasUserCorrection: turnRows.some(
            (row) => isPersonPrompt(row) && CORRECTION_SIGNALS.test(row.text),
          ),
          hasError: turnRows.some((row) => row.isError),
          tokenEstimate: turnRows.reduce((sum, row) => sum + estimateTokens(row.text), 0),
        };
      }),
    };
  }

  /** Full sanitized evidence as paged text files' content (for agent Read). */
  fullText(): string {
    return this.rows
      .map((row) =>
        JSON.stringify({
          evidenceId: row.evidenceId,
          entryId: row.id,
          role: row.role ?? row.door,
          text: row.text,
        }),
      )
      .join("\n");
  }
}

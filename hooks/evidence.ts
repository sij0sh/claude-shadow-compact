/**
 * Durable evidence archive (spec §4.2). `session.append` hands every
 * transcript row to the mod before storage under a stable uuid; this
 * archive mirrors main-loop rows in append order, sanitizes their text,
 * and serves the builder/verifier through a manifest + paged file.
 * Evidence ids (`E0001`, ...) are stable per archive position; `E0000`
 * names the previous checkpoint.
 */
import { estimateTokens, redactSecretValue, sanitizeForContext } from "./normalize.js";

interface EvidenceMessage {
  role: "user" | "assistant";
  text: string;
  toolUses?: readonly { tool: string; input?: unknown }[];
  toolResults?: readonly { text: string; isError?: boolean }[];
}

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
  /** False for attachments/notices/meta, or archived rows outside this snapshot's live coverage. */
  isTranscript?: boolean;
  /** Provenance of the sanitized projection; never silently treat a clipped row as complete. */
  textTruncated?: boolean;
  originalTextChars?: number;
}

/** Origins that are the person speaking, the only source of user corrections. */
const PERSON_ORIGINS = new Set(["composer", "bridge", "sdk"]);

/** True for a user row the person wrote (bootstrap rows carry no origin). */
export function isPersonPrompt(row: EvidenceRow): boolean {
  if (row.role !== "user" || row.hasToolResult) return false;
  return row.originKind === undefined || PERSON_ORIGINS.has(row.originKind);
}

export function isCoverageRow(row: EvidenceRow): boolean {
  return !!row.role && row.isTranscript !== false && !["attachment", "hook-context", "notice"].includes(row.door);
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

/** Keep output headers and final errors/results, with explicit clipping provenance. */
function projectRowText(text: string): string {
  if (text.length <= MAX_ROW_TEXT_CHARS) return text;
  // The omitted count includes only source characters, not the marker itself.
  let omitted = text.length - MAX_ROW_TEXT_CHARS;
  let marker = "";
  for (let pass = 0; pass < 3; pass += 1) {
    marker = `\n[... ${omitted} characters omitted ...]\n`;
    omitted = text.length - MAX_ROW_TEXT_CHARS + marker.length;
  }
  marker = `\n[... ${omitted} characters omitted ...]\n`;
  const kept = MAX_ROW_TEXT_CHARS - marker.length;
  const head = Math.ceil(kept / 2);
  return text.slice(0, head) + marker + text.slice(-(kept - head));
}


export type EvidenceSignal = "correction" | "error" | "quantity" | "rejected-approach" | "acceptance" | "verification" | "truncated";

export interface EvidenceIndexEntry {
  evidenceId: string;
  entryId: string;
  turnId: string;
  /** Zero-based row position, and one-based JSONL line for Read offset/limit. */
  position: number;
  line: number;
  role: string;
  toolNames: string[];
  hasToolResult: boolean;
  eligibleForCoverage: boolean;
  signals: EvidenceSignal[];
}

/** Deterministic navigation/risk hints, never an assertion that a claim is true. */
export function evidenceSignals(row: EvidenceRow): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];
  if (isPersonPrompt(row) && CORRECTION_SIGNALS.test(row.text)) signals.push("correction");
  if (row.isError || /\b(error|failed|failure|exception|unresolved|blocked)\b/i.test(row.text)) signals.push("error");
  if (/\b\d+(?:\.\d+)*\b/.test(row.text)) signals.push("quantity");
  if (/\b(reject(?:ed)?|discard(?:ed)?|abandon(?:ed)?|revert(?:ed)?|did not work|didn't work)\b/i.test(row.text)) signals.push("rejected-approach");
  if (/\b(accept(?:ed)?|approv(?:ed|al)|agreed|confirmed)\b/i.test(row.text)) signals.push("acceptance");
  if (/\b(looks good|sounds good|go ahead|ship it)\b/i.test(row.text) && !signals.includes("acceptance")) signals.push("acceptance");
  if (/\b(built|implemented|finished|completed|deployed|fixed|resolved|tests? pass(?:ed)?|build succeed(?:ed)?)\b/i.test(row.text)) signals.push("verification");
  if (row.textTruncated || row.text.length >= MAX_ROW_TEXT_CHARS) signals.push("truncated");
  return signals;
}

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
  message: { type: string; role?: string; content: unknown; isMeta?: boolean },
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
  const role = message.type === "assistant" ? "assistant"
    : message.role === "user" || message.role === "assistant" ? message.role : undefined;
  const sanitized = sanitizeForContext(parts.join("\n"), cwd);
  return {
    id: uuid,
    evidenceId: evidenceIdForIndex(index),
    ...(role ? { role } : {}),
    door,
    text: projectRowText(sanitized),
    textTruncated: sanitized.length > MAX_ROW_TEXT_CHARS,
    originalTextChars: sanitized.length,
    toolNames,
    hasToolResult,
    isError,
    ...(originKind ? { originKind } : {}),
    isTranscript: message.type === "assistant" || (message.type === "user" && message.role === "user" && !message.isMeta),
  };
}

/** Segments rows into user-anchored turns; leading rows join turn 1. */
export function segmentTurns(rows: readonly EvidenceRow[]): EvidenceTurn[] {
  if (rows.length === 0) return [];
  const starts: number[] = [];
  rows.forEach((row, index) => {
    if (row.role === "user" && !row.hasToolResult && row.isTranscript !== false) starts.push(index);
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
  lastTranscriptRowId: string | null;
  previousCoverageEndEntryId: string | null;
  hasPreviousCheckpoint: boolean;
  requiredTurnIds: string[];
  /** Whole required turns, including a turn spanning the previous boundary. */
  inspectionRanges: Array<{ start: number; count: number }>;
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
  #turns: EvidenceTurn[] | undefined;
  #manifest: SessionManifest | undefined;
  #evidenceIndex: EvidenceIndexEntry[] | undefined;
  #fullText: string | undefined;

  constructor(private readonly cwd: string) {}

  get size(): number {
    return this.rows.length;
  }

  /** Appends a row; returns false for a duplicate uuid (append replays). */
  add(row: EvidenceRow): boolean {
    if (this.#indexById.has(row.id)) return false;
    const stored: EvidenceRow = { ...row, toolNames: [...row.toolNames], evidenceId: evidenceIdForIndex(this.rows.length) };
    this.#indexById.set(stored.id, this.rows.length);
    this.rows.push(stored);
    this.#turns = undefined;
    this.#manifest = undefined;
    this.#evidenceIndex = undefined;
    this.#fullText = undefined;
    return true;
  }

  addAppend(
    uuid: string,
    door: string,
    message: { type: string; role?: string; content: unknown; isMeta?: boolean },
    originKind?: string,
  ): boolean {
    return this.add(rowFromAppend(uuid, door, message, this.cwd, this.rows.length, originKind));
  }

  /**
   * A frozen copy of rows `0..lastIndex` with the same previous checkpoint.
   * Preparation reads only this, so the evidence file, manifest, and ref
   * validation agree even while the live archive keeps growing.
   */
  snapshot(lastIndex: number, coverageIds?: ReadonlySet<string>): EvidenceArchive {
    const copy = new EvidenceArchive(this.cwd);
    for (const row of this.rows.slice(0, lastIndex + 1)) {
      copy.add(coverageIds && !coverageIds.has(row.id) ? { ...row, isTranscript: false } : row);
    }
    copy.setPreviousCheckpoint(this.#previousCheckpointSummary, this.#previousCoverageEndEntryId);
    return copy;
  }

  /** Seeds rows that predate installation (from `$.session.messages()`). */
  bootstrap(messages: readonly EvidenceMessage[]): void {
    messages.forEach((message, index) => {
      this.addSessionMessage(`bootstrap-${index}`, message, "bootstrap");
    });
  }

  addSessionMessage(id: string, message: EvidenceMessage, door = "compaction"): void {
    this.addAppend(id, door, {
      type: message.role, role: message.role,
      content: [
        { type: "text", text: message.text },
        ...(message.toolUses ?? []).map(call => ({ type: "tool_use", name: call.tool, input: call.input })),
        ...(message.toolResults ?? []).map(result => ({ type: "tool_result", content: result.text, is_error: result.isError })),
      ],
    });
  }

  setPreviousCheckpoint(summary: string | undefined, coverageEndEntryId: string | null): void {
    this.#previousCheckpointSummary = summary;
    this.#previousCoverageEndEntryId = coverageEndEntryId;
    this.#manifest = undefined;
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
    return this.#turns ??= segmentTurns(this.rows);
  }

  /** Compact locations/flags for retrieval. Does not serve or certify row text. */
  evidenceIndex(): EvidenceIndexEntry[] {
    if (this.#evidenceIndex) return this.#evidenceIndex;
    const turnByRow = new Map<string, string>();
    for (const turn of this.turns()) for (const id of turn.rowIds) turnByRow.set(id, turn.turnId);
    return this.#evidenceIndex = this.rows.map((row, position) => ({
      evidenceId: row.evidenceId, entryId: row.id, turnId: turnByRow.get(row.id) ?? "",
      position, line: position + 1, role: row.role ?? row.door,
      toolNames: [...row.toolNames], hasToolResult: row.hasToolResult,
      eligibleForCoverage: isCoverageRow(row),
      signals: evidenceSignals(row),
    }));
  }

  manifest(): SessionManifest {
    if (this.#manifest) return this.#manifest;
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
      if (this.indexOf(turn.endRowId) > previousIndex) required.add(turn.turnId);
      const turnRows = turn.rowIds
        .map((id) => this.rows[this.indexOf(id)])
        .filter((row): row is EvidenceRow => row !== undefined);
      if (turnRows.some((row) => row.isError)) required.add(turn.turnId);
    }
    return this.#manifest = {
      rowCount: this.rows.length,
      turnCount: turns.length,
      firstRowId: this.rows[0]?.id ?? null,
      lastRowId: this.rows[this.rows.length - 1]?.id ?? null,
      lastTranscriptRowId: this.evidenceIndex().findLast(row => row.eligibleForCoverage)?.entryId ?? null,
      previousCoverageEndEntryId: this.#previousCoverageEndEntryId,
      hasPreviousCheckpoint: this.#previousCheckpointSummary !== undefined,
      requiredTurnIds: [...required],
      inspectionRanges: turns.filter(turn => required.has(turn.turnId)).map(turn => ({
        start: this.indexOf(turn.startRowId), count: turn.rowIds.length,
      })),
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
    return this.#fullText ??= this.rows
      .map((row) =>
        JSON.stringify({
          evidenceId: row.evidenceId,
          entryId: row.id,
          role: row.role ?? row.door,
          eligibleForCoverage: isCoverageRow(row),
          ...(row.textTruncated ? { textTruncated: true, originalTextChars: row.originalTextChars } : {}),
          ...(row.isError ? { isError: true } : {}),
          text: row.text,
        }),
      )
      .join("\n");
  }
}

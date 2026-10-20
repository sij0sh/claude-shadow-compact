/**
 * Durable evidence archive (spec §4.2). `session.append` hands every
 * transcript row to the mod before storage under a stable uuid; this
 * archive mirrors main-loop rows in append order, sanitizes their text,
 * and supplies frozen, complete source packets for curation and audit.
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

const CORRECTION_SIGNALS =
  /\b(no\b|wrong|incorrect|instead|actually|not that|fix\b|should\b|must\b|never\b|always\b|don't\b|do not\b|require[sd]?|prefer|prohibit)/i;


export type EvidenceSignal = "correction" | "error" | "verification";

/** Deterministic source priority hints, never evidence that a claim is true. */
export function evidenceSignals(row: EvidenceRow): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];
  if (isPersonPrompt(row) && CORRECTION_SIGNALS.test(row.text)) signals.push("correction");
  if (row.isError || /\b(error|failed|failure|exception|unresolved|blocked)\b/i.test(row.text)) signals.push("error");
  if (/\b(built|implemented|finished|completed|deployed|fixed|resolved|tests? pass(?:ed)?|build succeed(?:ed)?)\b/i.test(row.text)) signals.push("verification");
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
    text: sanitized,
    textTruncated: false,
    originalTextChars: sanitized.length,
    toolNames,
    hasToolResult,
    isError,
    ...(originKind ? { originKind } : {}),
    isTranscript: message.type === "assistant" || (message.type === "user" && message.role === "user" && !message.isMeta),
  };
}

export class EvidenceArchive {
  readonly rows: EvidenceRow[] = [];
  readonly #indexById = new Map<string, number>();
  #previousCheckpointSummary: string | undefined;
  #previousCoverageEndEntryId: string | null = null;
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

  /** Durable sanitized source projection for diagnostics and coverage snapshots. */
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

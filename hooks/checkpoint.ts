/**
 * Structured checkpoint schema, fail-closed validation, and rendering.
 * Ported from pi-shadow-compact `summary.ts` / `checkpoint.ts` with the
 * Pi model-resolution parts removed (Claude models are plugin options).
 * Every item must cite evidence ids the archive actually served; unknown
 * refs, unexpected keys, oversize items, and empty checkpoints throw.
 */

export const CHECKPOINT_SCHEMA_VERSION = 3;
const MAX_ITEM_CHARS = 8_000;
/** Shorter text cannot carry continuation state; it reads as a stub. */
const MIN_ITEM_CHARS = 6;
/** Stub answers a model submits to probe the schema, never real state. */
const PLACEHOLDER_TEXTS = new Set([
  "test", "testing", "todo", "tbd", "tba", "placeholder", "example", "sample",
  "none", "null", "undefined", "n/a", "na", "foo", "bar", "baz", "lorem ipsum", "...",
]);

/** Rejects stub text such as `x`, `test` or `TODO` that passes the shape checks. */
function requireSubstance(text: string, where: string): void {
  const normalized = text.toLowerCase().replace(/[.!?:;,]+$/, "").trim();
  if (text.length < MIN_ITEM_CHARS || PLACEHOLDER_TEXTS.has(normalized)) {
    throw new Error(`${where} is placeholder text (${JSON.stringify(text)}); describe the real session state`);
  }
}
const MAX_ITEMS_PER_SECTION = 100;
const MAX_REFS_PER_ITEM = 32;
const MAX_RENDERED_CHARS = 64_000;

export const SECTIONS = [
  "objective",
  "constraints",
  "completedWork",
  "currentState",
  "decisions",
  "openIssues",
  "nextActions",
  "criticalContext",
  "modifiedFiles",
  "referencedFiles",
] as const;

export type SectionName = (typeof SECTIONS)[number];

export interface CheckpointItem {
  text: string;
  evidenceRefs: string[];
}

export type VerificationStatus = "verified" | "unverified";

export interface VerificationItem {
  text: string;
  status: VerificationStatus;
  evidenceRefs: string[];
}

export interface ContinuationState {
  currentGoal: string;
  currentApproach: string;
  immediateNextStep: string;
}

export const VERIFICATION_SECTION = "verificationState" as const;
export const CONTINUATION_KEY = "continuationState" as const;

export type Checkpoint = Record<SectionName, CheckpointItem[]> & {
  verificationState: VerificationItem[];
  continuationState: ContinuationState;
};

export function emptyContinuationState(): ContinuationState {
  return { currentGoal: "", currentApproach: "", immediateNextStep: "" };
}

export function validateCheckpointObject(value: unknown, knownRefs: Set<string>): Checkpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Checkpoint must be a JSON object");
  }
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (
      !SECTIONS.includes(key as SectionName) &&
      key !== VERIFICATION_SECTION &&
      key !== CONTINUATION_KEY
    ) {
      throw new Error(`Unexpected checkpoint key: ${key}`);
    }
  }
  const checkpoint = {} as Checkpoint;
  let total = 0;
  for (const section of SECTIONS) {
    checkpoint[section] = parseSection(source, section, knownRefs);
    total += checkpoint[section].length;
  }
  checkpoint.verificationState = parseVerificationSection(source, knownRefs);
  total += checkpoint.verificationState.length;
  checkpoint.continuationState = parseContinuationState(source);
  if (total === 0) throw new Error("Checkpoint cannot be entirely empty");
  return checkpoint;
}

function parseVerificationSection(
  source: Record<string, unknown>,
  knownRefs: Set<string>,
): VerificationItem[] {
  const value = source[VERIFICATION_SECTION];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Checkpoint section ${VERIFICATION_SECTION} must be an array`);
  }
  if (value.length > MAX_ITEMS_PER_SECTION) {
    throw new Error(
      `Checkpoint section ${VERIFICATION_SECTION} exceeds ${MAX_ITEMS_PER_SECTION} items`,
    );
  }
  return value.map((item, index) => parseVerificationItem(item, index, knownRefs));
}

function parseVerificationItem(
  value: unknown,
  index: number,
  knownRefs: Set<string>,
): VerificationItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Item ${index} in ${VERIFICATION_SECTION} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "text" && key !== "status" && key !== "evidenceRefs") {
      throw new Error(`Item ${index} in ${VERIFICATION_SECTION} has unexpected key: ${key}`);
    }
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new Error(`Item ${index} in ${VERIFICATION_SECTION} has empty text`);
  if (text.length > MAX_ITEM_CHARS) {
    throw new Error(`Item ${index} in ${VERIFICATION_SECTION} exceeds text limit`);
  }
  requireSubstance(text, `Item ${index} in ${VERIFICATION_SECTION}`);
  if (record.status !== "verified" && record.status !== "unverified") {
    throw new Error(
      `Item ${index} in ${VERIFICATION_SECTION} needs status verified or unverified`,
    );
  }
  return {
    text,
    status: record.status,
    evidenceRefs: parseRefs(record.evidenceRefs, index, VERIFICATION_SECTION, knownRefs),
  };
}

const CONTINUATION_FIELDS = ["currentGoal", "currentApproach", "immediateNextStep"] as const;

function parseContinuationState(source: Record<string, unknown>): ContinuationState {
  const value = source[CONTINUATION_KEY];
  if (value === undefined) return emptyContinuationState();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Checkpoint section ${CONTINUATION_KEY} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(CONTINUATION_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`Checkpoint section ${CONTINUATION_KEY} has unexpected key: ${key}`);
    }
  }
  const state = emptyContinuationState();
  for (const field of CONTINUATION_FIELDS) {
    const text = typeof record[field] === "string" ? (record[field] as string).trim() : "";
    if (!text) {
      throw new Error(`Checkpoint section ${CONTINUATION_KEY}.${field} must be a non-empty string`);
    }
    if (text.length > MAX_ITEM_CHARS) {
      throw new Error(`Checkpoint section ${CONTINUATION_KEY}.${field} exceeds text limit`);
    }
    requireSubstance(text, `Checkpoint section ${CONTINUATION_KEY}.${field}`);
    state[field] = text;
  }
  return state;
}

/** The submit path requires an explicit, complete continuation handoff. */
export function requireContinuation(checkpoint: Checkpoint): void {
  const continuation = checkpoint.continuationState;
  if (
    !continuation.currentGoal ||
    !continuation.currentApproach ||
    !continuation.immediateNextStep
  ) {
    throw new Error(
      "continuationState must carry the current goal, approach, and immediate next step",
    );
  }
}

function parseSection(
  source: Record<string, unknown>,
  section: SectionName,
  knownRefs: Set<string>,
): CheckpointItem[] {
  const value = source[section];
  if (value === undefined && section === "objective") {
    throw new Error(`Missing checkpoint section: ${section}`);
  }
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Checkpoint section ${section} must be an array`);
  if (value.length > MAX_ITEMS_PER_SECTION) {
    throw new Error(`Checkpoint section ${section} exceeds ${MAX_ITEMS_PER_SECTION} items`);
  }
  return value.map((item, index) => parseItem(item, section, index, knownRefs));
}

function parseItem(
  value: unknown,
  section: SectionName,
  index: number,
  knownRefs: Set<string>,
): CheckpointItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Item ${index} in ${section} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "text" && key !== "evidenceRefs") {
      throw new Error(`Item ${index} in ${section} has unexpected key: ${key}`);
    }
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new Error(`Item ${index} in ${section} has empty text`);
  if (text.length > MAX_ITEM_CHARS) {
    throw new Error(`Item ${index} in ${section} exceeds text limit`);
  }
  requireSubstance(text, `Item ${index} in ${section}`);
  return { text, evidenceRefs: parseRefs(record.evidenceRefs, index, section, knownRefs) };
}

function parseRefs(
  refs: unknown,
  index: number,
  section: string,
  knownRefs: Set<string>,
): string[] {
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error(`Item ${index} in ${section} needs at least one evidenceRef`);
  }
  if (refs.length > MAX_REFS_PER_ITEM) {
    throw new Error(`Item ${index} in ${section} exceeds ${MAX_REFS_PER_ITEM} evidenceRefs`);
  }
  for (const ref of refs) {
    if (typeof ref !== "string" || !knownRefs.has(ref)) {
      throw new Error(`Unknown evidence reference: ${String(ref)}`);
    }
  }
  return refs as string[];
}

function safeText(value: string): string {
  return value.replace(/\s*\r?\n+\s*/g, " ").trim();
}

function cited(text: string, refs: readonly string[]): string {
  return `${safeText(text)} [${refs.join(", ")}]`;
}

/** The header line of every rendered checkpoint; install confirmation matches it. */
export const CHECKPOINT_HEADING = "# Continuation Checkpoint";

/** Coverage metadata line, also how canonical history proves which checkpoint installed. */
export function coverageLine(coverageEndEntryId: string): string {
  return `Covers the session through entry ${coverageEndEntryId} (schema v${CHECKPOINT_SCHEMA_VERSION}).`;
}

export function renderCheckpoint(checkpoint: Checkpoint, coverageEndEntryId: string): string {
  const sections = SECTIONS.map((section) => {
    const title = section
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/^./, (char) => char.toUpperCase());
    const lines = checkpoint[section].map((item) => `- ${cited(item.text, item.evidenceRefs)}`);
    return `## ${title}\n${lines.length ? lines.join("\n") : "(none)"}`;
  });
  const verification = checkpoint.verificationState ?? [];
  if (verification.length > 0) {
    const lines = verification.map((item) => `- [${item.status}] ${cited(item.text, item.evidenceRefs)}`);
    sections.push(`## Verification State\n${lines.join("\n")}`);
  }
  const continuation = checkpoint.continuationState;
  if (
    continuation &&
    (continuation.currentGoal || continuation.currentApproach || continuation.immediateNextStep)
  ) {
    sections.push(
      `## Continuation\n- Goal: ${safeText(continuation.currentGoal) || "(none)"}\n- Approach: ${safeText(continuation.currentApproach) || "(none)"}\n- Next: ${safeText(continuation.immediateNextStep) || "(none)"}`,
    );
  }
  const rendered = `${CHECKPOINT_HEADING}\n\n${coverageLine(coverageEndEntryId)}\n\n${sections.join("\n\n")}\n`;
  if (rendered.length > MAX_RENDERED_CHARS) {
    throw new Error("Rendered checkpoint exceeds size limit");
  }
  return rendered;
}

/** Extracts the first balanced JSON object from a model reply, or throws. */
export function extractJsonObject(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Reply contains no JSON object");
  try {
    return JSON.parse(reply.slice(start, end + 1)) as unknown;
  } catch {
    throw new Error("Reply JSON does not parse");
  }
}

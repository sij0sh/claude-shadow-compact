/** Bounded source packets. Coverage identity and semantic selection are distinct. */
import { EvidenceArchive, isCoverageRow, isPersonPrompt, evidenceSignals, type EvidenceRow } from "./evidence.js";
import { PreparationError } from "./failure.js";

export const CURATOR_INPUT_TOKENS = 24_000;
export const VERIFIER_INPUT_TOKENS = 12_000;
export const CURATOR_OUTPUT_TOKENS = 4_096;
export const VERIFIER_OUTPUT_TOKENS = 1_024;
const PROMPT_RESERVE = 2_000;
const PROTECTED_BUDGET = VERIFIER_INPUT_TOKENS - CURATOR_OUTPUT_TOKENS - PROMPT_RESERVE;

/** Conservative sizing heuristic, not a tokenizer or a statement of API usage. */
export function packetTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + other * 2;
}

export interface EvidencePacket {
  text: string;
  refs: Set<string>;
  estimatedTokens: number;
  selectedRows: number;
  omittedRows: number;
}

function previousIndex(archive: EvidenceArchive): number {
  return archive.previousCoverageEndEntryId === null ? -1 : archive.indexOf(archive.previousCoverageEndEntryId);
}

function protectedRows(archive: EvidenceArchive): EvidenceRow[] {
  const previous = previousIndex(archive);
  const summary = archive.previousCheckpoint()?.summary;
  return archive.rows.filter((row, index) => index > previous && isCoverageRow(row) && isPersonPrompt(row) && row.text !== summary);
}

function serialize(row: EvidenceRow, text = row.text): string {
  return JSON.stringify({ evidenceId: row.evidenceId, entryId: row.id, role: row.role ?? row.door,
    ...(row.isError ? { isError: true } : {}),
    ...((row.textTruncated || text !== row.text) ? { textTruncated: true, originalTextChars: row.originalTextChars ?? row.text.length } : {}), text });
}

function excerpt(text: string): string {
  if (text.length <= 1_200) return text;
  // Include decisive middle lines as well as the header and terminal result.
  const signals = text.split("\n").filter(line => /error|fail|exception|passed|exit code|blocked/i.test(line)).slice(-5).join("\n").slice(0, 400);
  return `${text.slice(0, 300)}\n[excerpt; omitted source text]\n${signals}\n${text.slice(-400)}`;
}

/** Move coverage earlier when protected instructions cannot fit both roles. */
export function preparationSnapshot(archive: EvidenceArchive): EvidenceArchive {
  const previous = previousIndex(archive);
  const base = archive.previousCheckpoint();
  let protectedTokens = base ? packetTokens(JSON.stringify(base)) : 0;
  let end = -1;
  const summary = base?.summary;
  for (let index = 0; index < archive.size; index += 1) {
    const row = archive.rows[index]!;
    if (index > previous && isCoverageRow(row) && isPersonPrompt(row) && row.text !== summary) {
      const tokens = packetTokens(serialize(row));
      if (protectedTokens + tokens > PROTECTED_BUDGET) break;
      protectedTokens += tokens;
    }
    if (isCoverageRow(row) && index >= previous) end = index;
  }
  if (end < 0 || end < previous || (end === previous && end !== archive.size - 1)) {
    throw new PreparationError("evidence_budget_exceeded", "protected instructions cannot fit both checkpoint roles");
  }
  return archive.snapshot(end);
}

/** The audit requires raw user instructions and cited source rows independently. */
export function evidencePacket(archive: EvidenceArchive, budget: number, requiredRefs: ReadonlySet<string> = new Set()): EvidencePacket {
  const selected = new Map<string, string>();
  const previous = archive.previousCheckpoint();
  const prefix = previous ? JSON.stringify(previous) + "\n" : "";
  let usedTokens = packetTokens(prefix);
  const fits = (extra: string) => usedTokens + packetTokens(extra) + 1 <= budget;
  const select = (ref: string, line: string) => { selected.set(ref, line); usedTokens += packetTokens(line) + 1; };
  const addRequired = (row: EvidenceRow, protect = false) => {
    if (selected.has(row.evidenceId)) return;
    const line = serialize(row, protect || isPersonPrompt(row) ? row.text : excerpt(row.text));
    if (!fits(line)) throw new PreparationError("evidence_budget_exceeded", "protected or cited audit evidence cannot fit");
    select(row.evidenceId, line);
  };
  if (packetTokens(prefix) > budget) throw new PreparationError("evidence_budget_exceeded", "previous checkpoint exceeds evidence budget");
  for (const row of protectedRows(archive)) addRequired(row, true);
  for (const ref of requiredRefs) {
    if (ref === "E0000" && previous) continue;
    const row = archive.rows.find(row => row.evidenceId === ref);
    if (!row) throw new PreparationError("evidence_unavailable", `missing cited source ${ref}`);
    addRequired(row);
  }
  const boundary = previousIndex(archive);
  const candidates = archive.rows.map((row, index) => ({ row, index,
    priority: evidenceSignals(row).some(signal => ["error", "correction", "verification"].includes(signal)) ? 1 : 0,
  })).filter(({ row, index }) => index > boundary && isCoverageRow(row));
  // Recent high-signal state first; duplicate optional logs carry no new state.
  candidates.sort((a, b) => b.priority - a.priority || b.index - a.index);
  const seen = new Set<string>();
  for (const { row } of candidates) {
    if (selected.has(row.evidenceId) || seen.has(row.text)) continue;
    seen.add(row.text);
    const line = serialize(row, excerpt(row.text));
    if (fits(line)) select(row.evidenceId, line);
  }
  const refs = new Set(selected.keys());
  if (previous) refs.add(previous.evidenceId);
  const omittedRows = candidates.filter(({ row }) => !selected.has(row.evidenceId)).length;
  const text = `${prefix}${[...selected.values()].join("\n")}`;
  return { text, refs, estimatedTokens: packetTokens(text), selectedRows: selected.size, omittedRows };
}

export function curatorPacket(archive: EvidenceArchive): EvidencePacket {
  return evidencePacket(archive, CURATOR_INPUT_TOKENS - PROMPT_RESERVE);
}

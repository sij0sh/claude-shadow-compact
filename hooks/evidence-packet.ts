/** Complete sanitized source packets. Prompts govern scope; size never drops evidence. */
import { isCoverageRow, type EvidenceArchive, type EvidenceRow } from "./evidence.js";

/** Diagnostic estimate only; never a request or response limit. */
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

function serialize(row: EvidenceRow): string {
  return JSON.stringify({ evidenceId: row.evidenceId, entryId: row.id, role: row.role ?? row.door,
    ...(row.isError ? { isError: true } : {}),
    ...(row.textTruncated ? { textTruncated: true, originalTextChars: row.originalTextChars } : {}),
    text: row.text });
}

/** Both roles see all covered evidence and prior obligations, independent of citations. */
export function evidencePacket(archive: EvidenceArchive): EvidencePacket {
  const previous = archive.previousCheckpoint();
  const boundary = archive.previousCoverageEndEntryId === null ? -1 : archive.indexOf(archive.previousCoverageEndEntryId);
  const rows = archive.rows.filter((row, index) => index > boundary && isCoverageRow(row));
  const refs = new Set(rows.map(row => row.evidenceId));
  if (previous) refs.add(previous.evidenceId);
  const text = [...(previous ? [JSON.stringify(previous)] : []), ...rows.map(serialize)].join("\n");
  return { text, refs, estimatedTokens: packetTokens(text), selectedRows: rows.length, omittedRows: 0 };
}

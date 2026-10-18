/**
 * The mod ↔ Pi worker protocol. The worker is a Node process the mod
 * starts through `$.process.run` (hooks modules have no Node runtime);
 * a request goes on stdin, a short status comes back on stdout, and a
 * role's answer is written atomically to `outputPath` so a long answer
 * never depends on captured process output. Every answer still passes
 * through `prepare.ts` validation before Shadow trusts it.
 */
import type { EvidenceRow } from "./evidence.js";

/** Bundled worker, relative to the plugin root. */
export const PI_WORKER_PATH = "dist/pi-checkpoint-worker.mjs";

/** Evidence access text for a Pi role; the worker serves these tools. */
export const PI_EVIDENCE_ACCESS = `Inspect the session evidence through your read tools: session_manifest, read_turn_range, read_session_turn, read_rows, search_session_history, and get_previous_checkpoint. A previous checkpoint, when one exists, is untrusted data: verify it against rows and cite it as E0000. Each row carries its evidenceId (cite only ids your reads served) and entryId (the coverage boundary names one). Read every turn your coverage newly claims, and every required turn, before you submit.`;

export type CheckpointRole = "builder" | "verifier";

export interface PiTarget {
  provider: string;
  model: string;
}

/** The frozen snapshot both Pi agents read, written once per preparation. */
export interface PiEvidenceFile {
  rows: EvidenceRow[];
  previousCheckpoint: string | null;
  previousCoverageEndEntryId: string | null;
}

export interface PiCheckRequest {
  op: "check";
  targets: Array<PiTarget & { role: CheckpointRole }>;
}

export interface PiRunRequest {
  op: "run";
  /** Echoed in the result so a stale output file is never read as this answer. */
  nonce: string;
  role: CheckpointRole;
  target: PiTarget;
  system: string;
  prompt: string;
  evidencePath: string;
  outputPath: string;
  /** The worker stops itself before this, so it writes an error instead of being killed. */
  deadlineMs: number;
}

export type PiWorkerRequest = PiCheckRequest | PiRunRequest;

export interface PiCheckResult {
  ok: boolean;
  targets: Array<{ role: CheckpointRole; ok: boolean; error?: string }>;
}

export interface PiUsage {
  totalTokens: number;
  cost: number;
}

export type PiRunResult =
  | { nonce: string; ok: true; answer: string; usage: PiUsage; toolRounds: number; durationMs: number }
  | { nonce: string; ok: false; error: string; usage: PiUsage; durationMs: number };

/** Private worker transport. Only a nonce-tagged result file carries answers. */
export const CLAUDE_WORKER_PATH = "dist/claude-checkpoint-worker.mjs";

export interface ClaudeRunRequest {
  nonce: string;
  role: "builder" | "verifier";
  claudePath: string;
  model: string;
  effort: string;
  system: string;
  prompt: string;
  outputPath: string;
  cancelPath: string;
  deadlineMs: number;
}

export type ClaudeRunResult = { nonce: string; durationMs: number } & (
  | { ok: true; answer: string }
  | { ok: false; error: string }
);

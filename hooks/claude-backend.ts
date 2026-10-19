/** Pure worker protocol helpers; host API calls stay in register.ts. */
import type { ClaudeRunRequest, ClaudeRunResult } from "./claude-protocol.js";
import type { AskRequest } from "./prepare.js";
import type { PreparationControl } from "./preparation-control.js";
import { PreparationError } from "./failure.js";

export function workerRequest(request: AskRequest, model: string, effort: string, control: PreparationControl, timeoutMs: number): ClaudeRunRequest {
  const nonce = crypto.randomUUID();
  return { nonce, role: request.role, claudePath: "claude", model, effort, system: request.system,
    prompt: request.prompt, maxTokens: request.maxTokens,
    outputPath: `${control.directory}/claude-${request.role}-${nonce}-result.json`,
    cancelPath: `${control.directory}/cancel`, deadlineMs: Math.max(1, timeoutMs - 5_000) };
}
export function workerAnswer(raw: string, request: ClaudeRunRequest, exitCode: number): string {
  let result: ClaudeRunResult;
  try { result = JSON.parse(raw) as ClaudeRunResult; }
  catch { throw new PreparationError("worker_result_invalid", `${request.role} exited ${exitCode} without a valid result`, true); }
  if (!result || result.nonce !== request.nonce) throw new PreparationError("worker_result_invalid", "worker result nonce mismatch", true);
  if (!result.ok) {
    const code = result.code ?? "worker_failed";
    throw new PreparationError(code, `${request.role}: ${result.error}`, result.retryable === true);
  }
  if (typeof result.answer !== "string" || !result.answer.trim()) throw new PreparationError("worker_result_invalid", "worker returned no answer", true);
  return result.answer;
}

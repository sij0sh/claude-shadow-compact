import type { EngineInterface } from "claude-code";
import type { ShadowConfig } from "./config.js";
import type { PreparationControl } from "./preparation-control.js";
import type { AskFn } from "./prepare.js";
import { CLAUDE_WORKER_PATH, type ClaudeRunRequest, type ClaudeRunResult } from "./claude-protocol.js";

export function askViaClaudeWorker($: EngineInterface, config: ShadowConfig, control: PreparationControl): AskFn {
  return async request => {
    const nonce = crypto.randomUUID();
    const outputPath = `${control.directory}/claude-${request.role}-${nonce}-result.json`;
    const timeoutMs = Math.min(600_000, control.remaining(await $.clock.now()));
    const run: ClaudeRunRequest = {
      nonce, role: request.role, claudePath: config.claudePath,
      model: request.model === "inherit" ? await $.session.model() : request.model,
      effort: request.role === "builder" ? config.builderEffort : config.verifierEffort,
      system: request.system, prompt: request.prompt, outputPath,
      cancelPath: `${control.directory}/cancel`,
      deadlineMs: Math.max(1, timeoutMs - Math.min(5_000, Math.floor(timeoutMs / 10))),
    };
    const exited = await $.process.run([config.piNodePath, `${$.plugin.root}/${CLAUDE_WORKER_PATH}`], {
      stdin: JSON.stringify(run), timeoutMs,
    });
    const raw = await $.fs.read(outputPath).catch(() => "");
    let result: ClaudeRunResult | undefined;
    try { result = JSON.parse(raw) as ClaudeRunResult; } catch { /* missing/partial output is a failed worker */ }
    if (!result || result.nonce !== nonce) throw new Error(`Claude ${request.role} worker exited ${exited.exitCode} without its result`);
    if (!result.ok) throw new Error(`Claude ${request.role} worker: ${result.error}`);
    if (typeof result.answer !== "string" || !result.answer.trim()) throw new Error("Claude worker returned no answer");
    return result.answer;
  };
}

/** Current hosts return a structured result; older supported hosts used text. */
export function completionText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "isAnswered" in result && result.isAnswered === true &&
    "text" in result && typeof result.text === "string") return result.text;
  const reason = result && typeof result === "object" && "reason" in result ? String(result.reason) : "invalid result";
  throw new Error(`Claude completion unanswered: ${reason}`);
}

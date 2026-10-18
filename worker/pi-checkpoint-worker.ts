/**
 * Pi checkpoint worker: the Node process Shadow starts for a Pi role.
 *
 * stdin carries one request (`hooks/pi-protocol.ts`):
 * - `check` loads Pi's model catalog and credentials and confirms each
 *   target exists with configured auth. No inference.
 * - `run` answers one role over the frozen evidence snapshot and writes
 *   the result atomically to `outputPath` (temp file + rename).
 *
 * stdout carries only a one-line status; answers never travel through it.
 * The worker has no write, edit, or shell tools, and reads no file but the
 * snapshot it is handed.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, type Api, type Model } from "@earendil-works/pi-ai";
import type {
  PiCheckRequest,
  PiCheckResult,
  PiEvidenceFile,
  PiRunRequest,
  PiRunResult,
  PiWorkerRequest,
} from "../hooks/pi-protocol.js";
import { AgentError, archiveFromFile, runCheckpointAgent } from "./agent-loop.js";

/** Generation cap per response; a checkpoint fits well within it. */
const MAX_RESPONSE_TOKENS = 32_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function check(request: PiCheckRequest): Promise<PiCheckResult> {
  const runtime = await ModelRuntime.create();
  const targets = request.targets.map((target) => {
    if (!runtime.getModel(target.provider, target.model)) {
      return { role: target.role, ok: false, error: `unknown model ${target.provider}/${target.model}` };
    }
    if (!runtime.hasConfiguredAuth(target.provider)) {
      return { role: target.role, ok: false, error: `no Pi credentials for ${target.provider} (run pi and /login)` };
    }
    return { role: target.role, ok: true };
  });
  return { ok: targets.every((target) => target.ok), targets };
}

async function writeAtomically(path: string, result: PiRunResult): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(result));
  await rename(temp, path);
}

async function run(request: PiRunRequest): Promise<PiRunResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const signal = AbortSignal.timeout(request.deadlineMs);
  try {
    const runtime = await ModelRuntime.create();
    const model: Model<Api> | undefined = runtime.getModel(request.target.provider, request.target.model);
    if (!model) throw new Error(`unknown model ${request.target.provider}/${request.target.model}`);
    if (!runtime.hasConfiguredAuth(model.provider)) throw new Error(`no Pi credentials for ${model.provider}`);
    const file = JSON.parse(await readFile(request.evidencePath, "utf8")) as PiEvidenceFile;
    const reasoning = model.reasoning && request.target.thinking !== "off" ? clampThinkingLevel(model, request.target.thinking) : "off";
    const options = {
      maxTokens: Math.min(model.maxTokens > 0 ? model.maxTokens : MAX_RESPONSE_TOKENS, MAX_RESPONSE_TOKENS),
      toolChoice: "auto" as const,
      cacheRetention: "none" as const,
      sessionId: request.nonce,
      ...(reasoning !== "off" ? { reasoning } : {}),
    };
    const result = await runCheckpointAgent({
      role: request.role,
      model,
      system: request.system,
      prompt: request.prompt,
      archive: archiveFromFile(file),
      signal,
      complete: (context, call) => runtime.completeSimple(model, context, { ...options, signal: call.signal }),
    });
    return { nonce: request.nonce, ok: true, answer: result.answer, usage: result.usage, toolRounds: result.toolRounds, durationMs: elapsed() };
  } catch (error) {
    const usage = error instanceof AgentError ? error.usage : { totalTokens: 0, cost: 0 };
    const reason = signal.aborted && !(error instanceof AgentError) ? `deadline reached: ${message(error)}` : message(error);
    return { nonce: request.nonce, ok: false, error: reason.slice(0, 1_000), usage, durationMs: elapsed() };
  }
}

async function main(): Promise<void> {
  const request = JSON.parse(await readStdin()) as PiWorkerRequest;
  if (request.op === "check") {
    const result = await check(request);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (request.op === "run") {
    const result = await run(request);
    await writeAtomically(request.outputPath, result);
    process.stdout.write(`${JSON.stringify({ ok: result.ok, role: request.role, durationMs: result.durationMs })}\n`);
    return;
  }
  throw new Error(`unknown op ${(request as { op?: unknown }).op}`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`pi-checkpoint-worker: ${message(error)}\n`);
    process.exit(1);
  },
);

import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ClaudeRunRequest, ClaudeRunResult } from "../hooks/claude-protocol.js";
import { workerCancellation } from "./cancellation.js";

/** Keep authentication/provider settings, remove parent routing and plugin loading. */
export function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || /^CLAUDE_(?:CODE_)?(?:SESSION|PARENT|AGENT|TEAM|REMOTE|SSE|PLUGIN)/.test(key)) delete env[key];
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

export function workerArguments(request: ClaudeRunRequest): string[] {
  return [
    "--safe-mode", "--print", "--output-format", "json", "--no-session-persistence",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands",
    "--tools", "Read,Grep", "--allowedTools", "Read,Grep", "--permission-mode", "dontAsk",
    "--model", request.model, "--effort", request.effort, "--system-prompt", request.system,
  ];
}

export async function runClaudeWorker(request: ClaudeRunRequest): Promise<ClaudeRunResult> {
  const started = performance.now();
  const cancellation = workerCancellation(request.deadlineMs, request.cancelPath);
  try {
    await cancellation.check();
    cancellation.signal.throwIfAborted();
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(request.claudePath, workerArguments(request), {
        cwd: dirname(request.outputPath), env: workerEnvironment(process.env),
        detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let bytes = 0;
      let failure: Error | undefined;
      let escalation: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* process already exited */ }
      };
      const stop = () => {
        failure ??= new Error("Claude checkpoint cancelled or deadline reached");
        kill("SIGTERM");
        escalation ??= setTimeout(() => kill("SIGKILL"), 500);
      };
      cancellation.signal.addEventListener("abort", stop, { once: true });
      if (cancellation.signal.aborted) stop();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) { failure = new Error("Claude worker output exceeded 4 MiB"); stop(); }
        else output += chunk;
      });
      // Errors can contain prompts or credentials: only report an exit code.
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      child.once("error", error => { failure = error; });
      child.once("close", code => {
        cancellation.signal.removeEventListener("abort", stop);
        if (escalation) clearTimeout(escalation);
        if (failure) { kill("SIGKILL"); reject(failure); }
        else if (code !== 0) reject(new Error(`Claude CLI exited ${code}`));
        else resolve(output);
      });
      child.stdin.end(request.prompt);
    });
    const reply = JSON.parse(raw) as { type?: string; is_error?: boolean; result?: string };
    if (reply.is_error || typeof reply.result !== "string" || !reply.result.trim()) throw new Error("Claude CLI returned no successful result");
    return { nonce: request.nonce, ok: true, answer: reply.result, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { nonce: request.nonce, ok: false, error: error instanceof Error ? error.message : String(error), durationMs: Math.round(performance.now() - started) };
  } finally { cancellation.close(); }
}

export async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ClaudeRunRequest;
  const result = await runClaudeWorker(request);
  const temporary = `${request.outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(result), { mode: 0o600 });
  await rename(temporary, request.outputPath);
  process.stdout.write(`${JSON.stringify({ ok: result.ok, role: request.role, durationMs: result.durationMs })}\n`);
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runClaudeWorker, workerArguments, workerEnvironment } from "../claude-checkpoint-worker.js";
import type { ClaudeRunRequest } from "../../hooks/claude-protocol.js";

function request(directory: string, claudePath: string): ClaudeRunRequest {
  return {
    nonce: "private-test", role: "builder", claudePath, model: "haiku", effort: "medium",
    system: "Read evidence only.", prompt: "private prompt", outputPath: join(directory, "result.json"),
    cancelPath: join(directory, "cancel"), deadlineMs: 5_000,
  };
}

test("Claude worker disables customizations and parent routing while preserving authentication", () => {
  const env = workerEnvironment({ CLAUDECODE: "1", CLAUDE_CODE_PLUGIN_DIRS: "/parent", CLAUDE_CODE_SESSION_ID: "parent", ANTHROPIC_API_KEY: "test-key", CLAUDE_CODE_OAUTH_TOKEN: "test-oauth", PATH: "/bin", CLAUDE_CODE_EFFORT_LEVEL: "low", MAX_THINKING_TOKENS: "32000", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192" });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(env.MAX_THINKING_TOKENS, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "test-key");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "test-oauth");
  const args = workerArguments(request("/tmp", "claude"));
  for (const flag of ["--safe-mode", "--no-session-persistence"]) assert.ok(args.includes(flag));
  assert.ok(!args.includes("--bare"));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!args.includes("--resume"));
  assert.ok(!args.includes("--max-turns"));
});

test("the shipped Claude worker writes only a nonce-tagged atomic result and short status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-claude-"));
  try {
    const cli = join(directory, "claude-test.mjs");
    await writeFile(cli, `#!/usr/bin/env node
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (prompt !== 'private prompt') process.exit(3);
if (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) process.exit(4);
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'checkpoint ✓ 中文' }));
`, { mode: 0o700 });
    const run = request(directory, cli);
    const child = spawnSync(process.execPath, [resolve("dist/claude-checkpoint-worker.mjs")], { input: JSON.stringify(run), encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(await readFile(run.outputPath, "utf8"));
    assert.equal(result.nonce, run.nonce);
    assert.equal(result.answer, "checkpoint ✓ 中文");
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(JSON.parse(child.stdout)).sort(), ["durationMs", "ok", "role"]);
    assert.ok(!child.stdout.includes("checkpoint"));
    assert.ok(!child.stdout.includes("private prompt"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("large CLI answers survive the former output transport cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-claude-large-"));
  try {
    const cli = join(directory, "large.mjs");
    await writeFile(cli, `#!/usr/bin/env node
for await (const chunk of process.stdin) {}
process.stdout.write(JSON.stringify({ is_error: false, result: 'detail '.repeat(800000) + 'end of checkpoint' }));
`, { mode: 0o700 });
    const run = request(directory, cli);
    const child = spawnSync(process.execPath, [resolve("dist/claude-checkpoint-worker.mjs")], { input: JSON.stringify(run), encoding: "utf8", timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(await readFile(run.outputPath, "utf8"));
    assert.equal(result.ok, true);
    assert.equal(result.answer.length, 7 * 800000 + 'end of checkpoint'.length);
    assert.ok(result.answer.endsWith('end of checkpoint'));
    assert.ok(child.stdout.length < 200);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("nonzero JSON errors preserve their cause and retry only transient API statuses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-claude-errors-"));
  try {
    const cli = join(directory, "error.mjs");
    for (const [code, status, retryable] of [
      ["max_output_tokens", null, false], ["authentication_error", 401, false],
      ["rate_limit_error", 429, true], ["overloaded_error", 529, true],
    ] as const) {
      await writeFile(cli, `#!/usr/bin/env node
for await (const chunk of process.stdin) {}
process.stderr.write('private prompt and credential');
process.stdout.write(JSON.stringify(${JSON.stringify({ subtype: "success", is_error: true, api_error: code, api_error_status: status, result: "private prompt and credential" })}), () => process.exit(1));
`, { mode: 0o700 });
      const result = await runClaudeWorker(request(directory, cli));
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.code, code);
        assert.equal(result.retryable, retryable);
        assert.ok(!result.error.includes('private prompt'));
        assert.ok(!result.error.includes('credential'));
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancellation is checked before launching the CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-claude-cancel-"));
  try {
    const run = request(directory, "/intentionally/missing/claude");
    await writeFile(run.cancelPath, "cancelled");
    const result = await runClaudeWorker(run);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /abort/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a running worker stops its child on its role request deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-claude-deadline-"));
  try {
    const cli = join(directory, "stalled.mjs");
    await writeFile(cli, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
    const run = request(directory, cli);
    run.deadlineMs = 100;
    const started = performance.now();
    const result = await runClaudeWorker(run);
    assert.equal(result.ok, false);
    assert.ok(performance.now() - started < 5_000);
    if (!result.ok) assert.match(result.error, /role_deadline_exceeded/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a cancellation file stops an already-running CLI request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-claude-running-"));
  try {
    const cli = join(directory, "running.mjs");
    await writeFile(cli, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
    const run = request(directory, cli);
    const operation = runClaudeWorker(run);
    await new Promise(resolve => setTimeout(resolve, 80));
    await writeFile(run.cancelPath, "user interrupted");
    const result = await operation;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "preparation_cancelled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("terminating the shipped worker also stops its isolated CLI child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-claude-parent-"));
  let cliPid: number | undefined;
  try {
    const cli = join(directory, "child.mjs");
    const ready = join(directory, "ready");
    const stopped = join(directory, "stopped");
    await writeFile(cli, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); });
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const run = request(directory, cli);
    const worker = spawn(process.execPath, [resolve("dist/claude-checkpoint-worker.mjs")], { stdio: ["pipe", "ignore", "ignore"] });
    const exited = new Promise<number | null>(resolveExit => worker.once("exit", resolveExit));
    worker.stdin.end(JSON.stringify(run));
    for (let i = 0; i < 200 && cliPid === undefined; i++) {
      cliPid = await readFile(ready, "utf8").then(Number, () => undefined);
      if (cliPid === undefined) await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    assert.ok(cliPid, "CLI child started");
    worker.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.equal(await readFile(stopped, "utf8"), "stopped");
    const result = JSON.parse(await readFile(run.outputPath, "utf8"));
    assert.equal(result.code, "preparation_cancelled");
  } finally {
    if (cliPid) { try { process.kill(cliPid, "SIGKILL"); } catch { /* already reaped */ } }
    await rm(directory, { recursive: true, force: true });
  }
});

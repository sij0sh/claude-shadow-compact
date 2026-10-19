import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runClaudeWorker, workerArguments, workerEnvironment } from "../claude-checkpoint-worker.js";
import type { ClaudeRunRequest } from "../../hooks/claude-protocol.js";

function request(directory: string, claudePath: string): ClaudeRunRequest {
  return {
    nonce: "private-test", role: "builder", claudePath, model: "haiku", effort: "high",
    system: "Read evidence only.", prompt: "private prompt", outputPath: join(directory, "result.json"),
    cancelPath: join(directory, "cancel"), deadlineMs: 5_000,
  };
}

test("Claude worker disables customizations and parent routing while preserving authentication", () => {
  const env = workerEnvironment({ CLAUDECODE: "1", CLAUDE_CODE_PLUGIN_DIRS: "/parent", CLAUDE_CODE_SESSION_ID: "parent", ANTHROPIC_API_KEY: "test-key", CLAUDE_CODE_OAUTH_TOKEN: "test-oauth", PATH: "/bin" });
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_PLUGIN_DIRS, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "test-key");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "test-oauth");
  const args = workerArguments(request("/tmp", "claude"));
  for (const flag of ["--safe-mode", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(args.includes(flag));
  assert.ok(!args.includes("--bare"));
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.ok(!args.includes("--resume"));
});

test("the shipped Claude worker writes only a nonce-tagged atomic result and short status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-claude-"));
  try {
    const cli = join(directory, "claude-test.mjs");
    await writeFile(cli, `#!/usr/bin/env node
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
if (prompt !== 'private prompt') process.exit(3);
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

test("a running worker stops its child on the shared deadline", async () => {
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
    if (!result.ok) assert.match(result.error, /cancelled|deadline/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

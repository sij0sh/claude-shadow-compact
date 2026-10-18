import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the shipped worker honors cancellation and writes a nonce-tagged atomic result without inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-bundle-"));
  try {
    const cancelPath = join(directory, "cancel");
    const outputPath = join(directory, "result.json");
    await writeFile(cancelPath, "obsolete coverage");
    const child = spawnSync(process.execPath, [resolve("dist/pi-checkpoint-worker.mjs")], {
      input: JSON.stringify({
        op: "run", nonce: "bundle-test", role: "builder",
        target: { provider: "unused", model: "unused", thinking: "off" },
        system: "", prompt: "", evidencePath: join(directory, "intentionally-missing.json"),
        outputPath, cancelPath, deadlineMs: 5_000,
      }),
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.nonce, "bundle-test");
    assert.equal(result.ok, false);
    assert.match(result.error, /aborted/);
    assert.equal(result.usage.totalTokens, 0);
    assert.equal(JSON.parse(child.stdout).ok, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

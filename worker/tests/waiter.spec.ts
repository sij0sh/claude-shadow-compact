import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { waitForOutcome } from "../checkpoint-waiter.js";

test("a wait lease expiring is pending, not a preparation failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-wait-"));
  try {
    const result = await waitForOutcome({ directory, generation: 7, leaseMs: 10 });
    assert.deepEqual(result, { generation: 7, status: "pending" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("partial and other-generation outcomes cannot settle a lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-wait-"));
  try {
    await writeFile(join(directory, "outcome.json"), '{"generation":');
    assert.equal((await waitForOutcome({ directory, generation: 7, leaseMs: 10 })).status, "pending");
    await writeFile(join(directory, "outcome.json"), '{"generation":6}');
    assert.equal((await waitForOutcome({ directory, generation: 7, leaseMs: 10 })).status, "pending");
    await writeFile(join(directory, "outcome.tmp"), '{"generation":7,"readiness":"verified"}');
    await rename(join(directory, "outcome.tmp"), join(directory, "outcome.json"));
    assert.equal((await waitForOutcome({ directory, generation: 7, leaseMs: 10 })).status, "settled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("the shipped wait helper reports only the matching generation and exits on cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shadow-wait-"));
  try {
    await writeFile(join(directory, "cancel"), "interrupted");
    const child = spawnSync(process.execPath, [resolve("dist/checkpoint-waiter.mjs")], {
      input: JSON.stringify({ directory, generation: 9, leaseMs: 240_000 }), encoding: "utf8", timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { generation: 9, status: "settled" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

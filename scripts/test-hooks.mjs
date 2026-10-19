// Run the existing hook/schema/integration suite when Claude Code is unavailable.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const outfile = "node_modules/.cache/shadow-hook-tests.mjs";
await build({
  entryPoints: ["tests/shadow-compact.test.ts"], outfile, bundle: true,
  platform: "node", format: "esm", target: "node22", logLevel: "warning",
  alias: { "claude-code/testing": resolve("tests/support/testing.mjs") },
});
const run = spawnSync(process.execPath, [outfile], { stdio: "inherit" });
process.exit(run.status ?? 1);

// Worker tests need Node (the plugin test runner has none): bundle each
// test so hooks' `.js` imports resolve to their `.ts` sources, then run.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const outdir = "node_modules/.cache/shadow-worker-tests";
// `.spec.ts`, not `.test.ts`: `claude plugin test` loads every `*.test.ts` in the restricted hooks runtime.
const tests = readdirSync("worker/tests").filter((name) => name.endsWith(".spec.ts"));
await build({
  entryPoints: tests.map((name) => `worker/tests/${name}`),
  outdir,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  logLevel: "warning",
});
// `node --test` skips paths under node_modules, so run each file itself.
let failed = false;
for (const name of tests) {
  const run = spawnSync(process.execPath, [`${outdir}/${name.replace(/\.ts$/, ".mjs")}`], { stdio: "inherit" });
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);

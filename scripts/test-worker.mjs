// Compile the source tests with Node, then exercise the shipped JS worker.
import { readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { compileFile } from "./compile.mjs";

const outdir = "node_modules/.cache/shadow-tests/worker";
const temporaryDirectory = resolve(outdir, "tmp");
await mkdir(temporaryDirectory, { recursive: true });
for (const name of await readdir("worker")) {
  if (name.endsWith(".ts")) await compileFile(`worker/${name}`, `${outdir}/${name.replace(/\.ts$/, ".mjs")}`);
}
const tests = (await readdir("worker/tests")).filter(name => name.endsWith(".spec.ts"));
let failed = false;
for (const name of tests) {
  const path = `${outdir}/tests/${name.replace(/\.ts$/, ".mjs")}`;
  await compileFile(`worker/tests/${name}`, path);
  const run = spawnSync(process.execPath, [path], { stdio: "inherit", env: { ...process.env, TMPDIR: temporaryDirectory } });
  if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);

// Run the hook/schema/integration suite without invoking paid models.
import { readdir, copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { compileFile } from "./compile.mjs";

const outdir = "node_modules/.cache/shadow-tests";
await mkdir(`${outdir}/tests/support`, { recursive: true });
await copyFile("tests/support/testing.mjs", `${outdir}/tests/support/testing.mjs`);
for (const directory of ["hooks", "tests"]) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
    await compileFile(`${directory}/${name}`, `${outdir}/${directory}/${name.replace(/\.ts$/, ".mjs")}`, {
      "claude-code/testing": "./support/testing.mjs",
    });
  }
}
const run = spawnSync(process.execPath, [`${outdir}/tests/shadow-compact.test.mjs`], { stdio: "inherit" });
process.exit(run.status ?? 1);

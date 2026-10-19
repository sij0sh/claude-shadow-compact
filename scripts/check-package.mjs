// Portable release checks. Claude's own validator remains `npm run validate`.
import assert from "node:assert/strict";
import { readFile, access, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { compileFile } from "./compile.mjs";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const manifest = JSON.parse(await readFile(".claude-plugin/plugin.json", "utf8"));
const hooks = JSON.parse(await readFile("hooks/hooks.json", "utf8"));
assert.equal(manifest.version, pkg.version);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages[""].version, pkg.version);
assert.match(await readFile("hooks/register.ts", "utf8"), new RegExp(`const PLUGIN_VERSION = "${pkg.version.replaceAll(".", "\\.")}"`));
assert.deepEqual(Object.keys(manifest.userConfig).sort(), ["checkpointEffort", "checkpointModel", "prepareThresholdTokens"]);
await compileFile("hooks/config.ts", "node_modules/.cache/shadow-package-config.mjs");
const { resolveConfig, AGENT_EFFORTS } = await import(pathToFileURL(resolve("node_modules/.cache/shadow-package-config.mjs")));
for (const [key, value] of Object.entries(resolveConfig({}))) assert.equal(manifest.userConfig[key].default, value, `default for ${key}`);
assert.deepEqual(manifest.userConfig.checkpointEffort.options, [...AGENT_EFFORTS]);
for (const module of hooks.modules) {
  const path = resolve("hooks", module);
  assert.ok(!relative(resolve("hooks"), path).startsWith(".."), "hook module must stay inside hooks");
  await access(path);
}
const files = await readdir("dist");
assert.deepEqual(files.sort(), ["cancellation.mjs", "claude-checkpoint-worker.mjs", "claude-worker.mjs"]);
for (const file of files) {
  const check = spawnSync(process.execPath, ["--check", `dist/${file}`], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const code = await readFile(`dist/${file}`, "utf8");
  const imports = [...code.matchAll(/^import .*? from ["']([^"']+)["']/gm)].map(match => match[1]);
  for (const specifier of imports) {
    assert.ok(specifier.startsWith("node:") || specifier.startsWith("./"), `external deployment dependency: ${specifier}`);
    if (specifier.startsWith("./")) await access(resolve("dist", specifier));
  }
}
console.log(`Release ${pkg.version}: metadata, three defaults, hook paths, and deployable worker modules checked.`);

// Node's built-in TypeScript transform keeps builds and portable tests usable
// offline. Deployment files are ordinary JavaScript and need no npm install.
import { stripTypeScriptTypes } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function compileFile(source, target, aliases = {}) {
  let code = stripTypeScriptTypes(await readFile(source, "utf8"), { mode: "transform" });
  code = code.replace(/^(import\s+.*?\s+from\s+)(["'])([^"']+)\2/gm, (line, prefix, quote, specifier) => {
    const mapped = aliases[specifier] ?? (specifier.startsWith(".") ? specifier.replace(/\.js$/, ".mjs") : specifier);
    return `${prefix}${quote}${mapped}${quote}`;
  });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, code);
}

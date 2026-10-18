// Bundles the Pi checkpoint worker into one self-contained ESM file the
// mod runs with `node`. The bundle is committed: installing the plugin
// needs no npm install.
import { build } from "esbuild";

await build({
  entryPoints: ["worker/pi-checkpoint-worker.ts"],
  outfile: "dist/pi-checkpoint-worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  // Bundled CommonJS dependencies call require(); ESM has none.
  banner: {
    js: "import{createRequire as __shadowCreateRequire}from'node:module';const require=__shadowCreateRequire(import.meta.url);",
  },
  logLevel: "warning",
});

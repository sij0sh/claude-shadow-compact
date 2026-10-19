// Only Node built-ins are imported by the deployed worker.
import { compileFile } from "./compile.mjs";

await compileFile("worker/cancellation.ts", "dist/cancellation.mjs");
await compileFile("worker/claude-checkpoint-worker.ts", "dist/claude-worker.mjs");
await compileFile("worker/claude-worker-main.ts", "dist/claude-checkpoint-worker.mjs", {
  "./claude-checkpoint-worker.js": "./claude-worker.mjs",
});
await compileFile("worker/checkpoint-waiter.ts", "dist/outcome-waiter.mjs");
await compileFile("worker/checkpoint-waiter-main.ts", "dist/checkpoint-waiter.mjs", {
  "./checkpoint-waiter.js": "./outcome-waiter.mjs",
});

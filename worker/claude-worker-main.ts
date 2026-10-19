import { main } from "./claude-checkpoint-worker.js";
main().then(() => process.exit(0), () => { process.stderr.write("claude-checkpoint-worker failed\n"); process.exit(1); });

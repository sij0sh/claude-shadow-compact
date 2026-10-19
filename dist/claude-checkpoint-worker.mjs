import { main } from "./claude-worker.mjs";
main().then(()=>process.exit(0), ()=>{
    process.stderr.write("claude-checkpoint-worker failed\n");
    process.exit(1);
});

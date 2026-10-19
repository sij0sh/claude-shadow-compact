import { readFile, access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
export async function waitForOutcome(request) {
    const end = Date.now() + Math.max(1, Math.min(request.leaseMs, 240_000));
    do {
        if (await access(`${request.directory}/cancel`).then(()=>true, ()=>false)) return {
            generation: request.generation,
            status: "settled"
        };
        try {
            const outcome = JSON.parse(await readFile(`${request.directory}/outcome.json`, "utf8"));
            if (outcome.generation === request.generation) return {
                generation: request.generation,
                status: "settled"
            };
        } catch  {}
        await delay(Math.min(200, Math.max(1, end - Date.now())));
    }while (Date.now() < end)
    return {
        generation: request.generation,
        status: "pending"
    };
}
export async function main() {
    const chunks = [];
    for await (const chunk of process.stdin)chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof request.directory !== "string" || !Number.isSafeInteger(request.generation) || !Number.isFinite(request.leaseMs)) throw new Error("Invalid wait request");
    process.stdout.write(JSON.stringify(await waitForOutcome(request)) + "\n");
}

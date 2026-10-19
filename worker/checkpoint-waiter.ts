/** A host-budget-exempt wait lease. This process never invokes a model. */
import { readFile, access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export interface WaitRequest { directory: string; generation: number; leaseMs: number }
export async function waitForOutcome(request: WaitRequest): Promise<{ generation: number; status: "settled" | "pending" }> {
  const end = Date.now() + Math.max(1, Math.min(request.leaseMs, 240_000));
  do {
    if (await access(`${request.directory}/cancel`).then(() => true, () => false)) return { generation: request.generation, status: "settled" };
    try {
      const outcome = JSON.parse(await readFile(`${request.directory}/outcome.json`, "utf8")) as { generation?: number };
      if (outcome.generation === request.generation) return { generation: request.generation, status: "settled" };
    } catch { /* missing or partially written outcome is still pending */ }
    await delay(Math.min(200, Math.max(1, end - Date.now())));
  } while (Date.now() < end);
  return { generation: request.generation, status: "pending" };
}
export async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WaitRequest;
  if (typeof request.directory !== "string" || !Number.isSafeInteger(request.generation) || !Number.isFinite(request.leaseMs)) throw new Error("Invalid wait request");
  process.stdout.write(JSON.stringify(await waitForOutcome(request)) + "\n");
}

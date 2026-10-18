/**
 * Optional Pi SDK backend for the checkpoint roles. Hooks modules have
 * no Node runtime, so each role answer runs the bundled worker as its
 * own Node process through `$.process.run`: one bounded process per
 * answer, never one covering both roles. The worker reads only the
 * frozen evidence snapshot written here, never the repository, and
 * nothing it does enters the acting conversation. Its answer is a reply
 * like any agent's: `prepare.ts` validates it before Shadow trusts it.
 *
 * Helpers take `$` explicitly, as in register.ts, so the engine's
 * validator can follow them.
 */
import type { EngineInterface } from "claude-code";
import { piTargetFor, roleBackend, type ShadowConfig } from "./config.js";
import type { EvidenceArchive } from "./evidence.js";
import type { AskFn } from "./prepare.js";
import {
  PI_WORKER_PATH,
  type CheckpointRole,
  type PiCheckRequest,
  type PiCheckResult,
  type PiEvidenceFile,
  type PiRunRequest,
  type PiRunResult,
} from "./pi-protocol.js";

/** `$.process.run` refuses anything longer. */
const PI_RUN_TIMEOUT_MS = 600_000;
/** The worker stops this much earlier, so it reports instead of being killed. */
const PI_DEADLINE_MARGIN_MS = 30_000;
const PI_CHECK_TIMEOUT_MS = 60_000;

/** Per-session Pi usage and outcomes for `/shadow-status`. */
export interface PiStats {
  calls: number;
  failures: number;
  totalTokens: number;
  cost: number;
}

export function emptyPiStats(): PiStats {
  return { calls: 0, failures: 0, totalTokens: 0, cost: 0 };
}

export function describePiStats(stats: PiStats): string {
  return `calls=${stats.calls} failures=${stats.failures} tokens=${stats.totalTokens} cost=$${stats.cost.toFixed(4)}`;
}

function workerArgv($: EngineInterface, config: ShadowConfig): string[] {
  return [config.piNodePath, `${$.plugin.root}/${PI_WORKER_PATH}`];
}

function tail(text: string): string {
  return text.trim().slice(-300);
}

/** The last stdout line the worker printed, parsed; it prints exactly one. */
function lastJsonLine(stdout: string): unknown {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Checks the configured Pi roles without inference: the worker loads
 * Pi's model catalog and credentials and confirms each model exists and
 * its provider has auth. Resolves `ok` or `failed:<reason>`.
 */
export async function checkPi($: EngineInterface, config: ShadowConfig): Promise<string> {
  const roles: CheckpointRole[] = ["builder", "verifier"];
  const targets: PiCheckRequest["targets"] = [];
  for (const role of roles) {
    if (roleBackend(config, role) !== "pi") continue;
    const target = piTargetFor(config, role);
    if (!target) {
      return `failed:${role} needs pi${role === "builder" ? "Builder" : "Verifier"}Provider and pi${role === "builder" ? "Builder" : "Verifier"}Model`;
    }
    targets.push({ role, ...target });
  }
  const request: PiCheckRequest = { op: "check", targets };
  const run = await $.process.run(workerArgv($, config), {
    stdin: JSON.stringify(request),
    timeoutMs: PI_CHECK_TIMEOUT_MS,
  });
  const result = lastJsonLine(run.stdout) as PiCheckResult | undefined;
  if (!result || !Array.isArray(result.targets)) {
    return `failed:worker exited ${run.exitCode}: ${tail(run.stderr) || "no status"}`;
  }
  const failed = result.targets.find((target) => !target.ok);
  if (failed) return `failed:${failed.role}: ${failed.error ?? "unavailable"}`;
  return "ok";
}

export interface PiPaths {
  /** Frozen snapshot the worker reads (PiEvidenceFile JSON). */
  evidencePath: string;
  /** Directory for per-role result files. */
  dataDir: string;
}

/** Writes the snapshot both Pi agents read; one per preparation. */
export async function writePiEvidence(
  $: EngineInterface,
  path: string,
  snapshot: EvidenceArchive,
): Promise<void> {
  const file: PiEvidenceFile = {
    rows: snapshot.rows,
    previousCheckpoint: snapshot.previousCheckpoint()?.summary ?? null,
    previousCoverageEndEntryId: snapshot.previousCoverageEndEntryId,
  };
  await $.fs.write(path, JSON.stringify(file));
}

/** Reads this request's result file; a stale or missing file is undefined. */
async function readResult(
  $: EngineInterface,
  path: string,
  nonce: string,
): Promise<PiRunResult | undefined> {
  const text = await $.fs.read(path).catch(() => undefined);
  if (typeof text !== "string") return undefined;
  try {
    const result = JSON.parse(text) as PiRunResult;
    return result.nonce === nonce ? result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The worker could not run or produce a result at all (missing Node,
 * missing bundle, crash, kill). Shadow stops launching it for the
 * session instead of paying the timeout again on every preparation.
 */
export class PiWorkerUnavailable extends Error {
  override name = "PiWorkerUnavailable";
}

/** One AskFn answering any role through the Pi worker. */
export function askViaPi(
  $: EngineInterface,
  config: ShadowConfig,
  paths: PiPaths,
  stats: PiStats,
): AskFn {
  return async (request) => {
    const target = piTargetFor(config, request.role);
    if (!target) throw new Error(`pi ${request.role} has no provider/model configured`);
    const nonce = crypto.randomUUID();
    const outputPath = `${paths.dataDir}/pi-${request.role}-result.json`;
    const run: PiRunRequest = {
      op: "run",
      nonce,
      role: request.role,
      target,
      system: request.system,
      prompt: request.prompt,
      evidencePath: paths.evidencePath,
      outputPath,
      deadlineMs: PI_RUN_TIMEOUT_MS - PI_DEADLINE_MARGIN_MS,
    };
    stats.calls += 1;
    try {
      const exited = await $.process
        .run(workerArgv($, config), { stdin: JSON.stringify(run), timeoutMs: PI_RUN_TIMEOUT_MS })
        .catch((error: unknown) => {
          throw new PiWorkerUnavailable(
            `pi ${request.role} worker did not run: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      const result = await readResult($, outputPath, nonce);
      if (!result) {
        throw new PiWorkerUnavailable(
          `pi ${request.role} worker exited ${exited.exitCode}: ${tail(exited.stderr) || "no result"}`,
        );
      }
      stats.totalTokens += result.usage.totalTokens;
      stats.cost += result.usage.cost;
      if (!result.ok) throw new Error(`pi ${request.role} (${target.provider}/${target.model}): ${result.error}`);
      return result.answer;
    } catch (error) {
      stats.failures += 1;
      throw error;
    }
  };
}

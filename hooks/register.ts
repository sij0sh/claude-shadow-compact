/** Live compaction adapter. Background work builds verified checkpoints;
 * Claude owns the compaction boundaries. Original message handles, prefix
 * proofs, bounded holds, reconciliation, and native recovery stay intact.
 * Host API helpers remain top-level for Claude's static hook validator.
 */
import type {
  EngineInterface,
  Register,
  SessionCompactResult,
  SessionMessage,
} from "claude-code";
import { CHECKPOINT_HEADING } from "./checkpoint.js";
import {
  decideAutoCompactWindow,
  decideIdleCompaction,
  isAtOrAbove,
  resolveConfig,
  IDLE_COMPACT_MIN_TOKENS,
  ROLE_TIMEOUT_MS,
  RETRY_COOLDOWN_MS,
  COMPACT_WAIT_LEASE_MS,
  RECENT_ROUNDS,
  type ShadowConfig,
} from "./config.js";
import { EvidenceArchive } from "./evidence.js";
import {
  prepareCheckpoint,
  emptyPreparationMetrics,
  type AskFn,
  type PreparationOptions,
} from "./prepare.js";
import { ShadowState, type PublishedCheckpoint } from "./state.js";
import { buildCandidate, isSkipped, estimateMessagesTokens } from "./working-context.js";
import { LiveTranscript, isTranscriptRow } from "./transcript.js";
import { contentDigest, prefixDigest, messageFromAppend, messageIdentity } from "./transcript.js";
import { workerRequest, workerAnswer } from "./claude-backend.js";
import { CLAUDE_WORKER_PATH, CHECKPOINT_WAITER_PATH } from "./claude-protocol.js";
import { PreparationError } from "./failure.js";
import { PreparationCancelled, PreparationControl } from "./preparation-control.js";

/** How often a held compaction checks on its preparation. */
const COMPACT_POLL_SECONDS = 1;
/** A held compaction stops waiting while this much hook budget is left. */
const COMPACT_BUDGET_RESERVE_MS = 2_000;
/** Running plugin version shown in status; bump with the manifest. */
const PLUGIN_VERSION = "0.4.12";

interface Attempt {
  key: string;
  completedTurns: number;
  error: PreparationError | undefined;
}

interface Runtime {
  config: ShadowConfig;
  state: ShadowState;
  sessionId: string;
  cwd: string;
  archive: EvidenceArchive | undefined;
  /** Transcript message order as archive row ids; `unknown-N` marks a
   * message no append named, so coverage on it can never be proven. */
  messageRowIds: string[];
  transcript: LiveTranscript;
  preparation: PreparationControl | undefined;
  runtimeId: string;
  traceSequence: number;
  initializing: Promise<void> | undefined;
  reconciliation: Promise<void> | undefined;
  historyStatus: string;
  historyEpoch: number;
  revision: number;
  pendingAppends: number;
  lifecycle: number;
  historyReadGeneration: number;
  /** A compaction this mod saw is waiting for its summary row's append. */
  awaitingCompactionRow: boolean;
  /** Last preparation fallback/failure for status; never prompt text. */
  lastFallback: string | null;
  nativeFallbacks: number;
  /** This session's auto-compact window outcome for status. */
  autoCompactWindow: string | null;
  /** This session's idle-compaction floor outcome for status. */
  idleCompact: string | null;
  /** Last main-loop context tokens `session.measure` reported. */
  lastTokens: number | null;
  /** Running context estimate: exact at each measure, then grown by
   * `estimateTokens` for every row appended since, so a single long turn
   * can cross the prepare threshold between measures. */
  tokenEstimate: number | null;
  /** The serving or preparing checkpoint was started below the prepare
   * threshold for idle compaction; refresh it once the threshold is hit. */
  idleCheckpoint: boolean;
  /** Which host command pauses a held compaction; -1 when none works. */
  pauseCommand: number | null;
  lastAttempt: Attempt | undefined;
  completedTurns: number;
  coolingDown: boolean;
  effectivePrepareThreshold: number;
  replacementBudget: number;
  configuredModel: string | null;
  configuringWindow: Promise<void> | undefined;
  windowOverride: { previous: string | undefined; applied: string } | undefined;
  idleOverride: { previous: string | undefined; applied: string } | undefined;
}

function createRuntime(config: ShadowConfig): Runtime {
  return {
    config,
    state: new ShadowState(),
    sessionId: "unknown",
    cwd: "",
    archive: undefined,
    messageRowIds: [],
    transcript: new LiveTranscript(),
    preparation: undefined,
    runtimeId: crypto.randomUUID(),
    traceSequence: 0,
    initializing: undefined,
    reconciliation: undefined,
    historyStatus: "pending",
    historyEpoch: 0,
    revision: 0,
    pendingAppends: 0,
    lifecycle: 0,
    historyReadGeneration: 0,
    awaitingCompactionRow: false,
    lastFallback: null,
    nativeFallbacks: 0,
    autoCompactWindow: null,
    idleCompact: null,
    lastTokens: null,
    tokenEstimate: null,
    idleCheckpoint: false,
    pauseCommand: null,
    lastAttempt: undefined,
    completedTurns: 0,
    coolingDown: false,
    effectivePrepareThreshold: config.prepareThresholdTokens,
    replacementBudget: 160_000,
    configuredModel: null,
    configuringWindow: undefined,
    windowOverride: undefined,
    idleOverride: undefined,
  };
}

async function ensureSession($: EngineInterface, rt: Runtime): Promise<EvidenceArchive> {
  if (!rt.initializing) rt.initializing = initializeSession($, rt);
  const task = rt.initializing;
  try { await task; } catch (error) { if (rt.initializing === task) rt.initializing = undefined; throw error; }
  return rt.archive!;
}

async function initializeSession($: EngineInterface, rt: Runtime): Promise<void> {
  const lifecycle = rt.lifecycle;
  const cwd = await $.session.cwd().catch(() => rt.cwd);
  const id = await $.session.id().catch(() => rt.sessionId);
  if (lifecycle !== rt.lifecycle) throw new Error("session changed during initialization");
  rt.cwd = cwd;
  rt.sessionId = id;
  rt.archive = new EvidenceArchive(cwd);
}

/** All changes are synchronous until the new canonical index is committed.
 * Persist superseded archives separately; never insert an old prefix after new rows. */
async function adoptHistory($: EngineInterface, rt: Runtime, messages: readonly SessionMessage[], source: string): Promise<void> {
  if (source === "compact") rt.historyReadGeneration += 1;
  const previous = rt.archive!;
  const ids = rt.transcript.bind(messages, rt.messageRowIds, rt.historyEpoch + 1);
  const indexes = ids.map(id => previous.indexOf(id));
  const missing = indexes.some(index => index < 0);
  const outOfOrder = indexes.some((index, i) => i > 0 && index <= indexes[i - 1]!);
  const firstMissing = indexes.indexOf(-1);
  const missingTail = firstMissing >= 0 && (firstMissing > 0 || previous.size === 0) && indexes.slice(firstMissing).every(index => index < 0) &&
    indexes.slice(0, firstMissing).every((index, i, prefix) => i === 0 || index > prefix[i - 1]!);
  let superseded: string | undefined;
  const contentChanged = ids.some((id, index) => {
    const observed = rt.transcript.messages([id])?.[0];
    return observed && messageIdentity(observed) !== messageIdentity(messages[index]!);
  });
  // A compacted canonical prefix intentionally places a new checkpoint before
  // older retained rows. Keep the original evidence archive for later grounding.
  const retained = rt.transcript.matchesPrefix(messages);
  const rebuilt = contentChanged || (missing && !missingTail) || (outOfOrder && !retained);
  if (rebuilt) {
    superseded = previous.size ? previous.fullText() : undefined;
    const archive = new EvidenceArchive(rt.cwd);
    messages.forEach((message, index) => archive.addSessionMessage(ids[index]!, message, "reconciled"));
    rt.archive = archive;
    rt.historyEpoch += 1;
    rt.state.discardPublished();

  } else if (missingTail) {
    messages.slice(firstMissing).forEach((message, index) => previous.addSessionMessage(ids[firstMissing + index]!, message, "reconciled"));
  }
  rt.messageRowIds = ids;
  rt.transcript.remember(messages, ids);
  rt.historyStatus = messages.length ? `reconciled:${source}` : "pending:empty";
  if (superseded) await $.fs.write(`${dataDir($, rt)}/history-before-${rt.historyEpoch}.jsonl`, superseded);
  await trace($, rt, "history-reconciled", { source, messages: messages.length, epoch: rt.historyEpoch, rebuilt });
}

async function readHistory($: EngineInterface, rt: Runtime): Promise<void> {
  const lifecycle = rt.lifecycle;
  const readGeneration = rt.historyReadGeneration;
  rt.historyStatus = "reading";
  try {
    // An append racing the host read causes a fresh read, not a lost or
    // duplicated suffix. No append can interleave the final synchronous commit.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const revision = rt.revision;
      const messages = await $.session.messages();
      if (lifecycle !== rt.lifecycle) throw new Error("session changed during reconciliation");
      if (readGeneration !== rt.historyReadGeneration) throw new Error("history read superseded by compaction");
      if (revision !== rt.revision || rt.pendingAppends) {
        if (!(await hostPause($, rt))) throw new Error("history read could not pause for pending appends");
        continue;
      }
      if (messages.length >= 4096) throw new Error("history-read-limited:4096");
      if (!messages.length && rt.messageRowIds.length) throw new Error("history-read-empty");
      await adoptHistory($, rt, messages, "canonical");
      return;
    }
    throw new Error("history-read-raced-appends");
  } catch (error) {
    if (lifecycle !== rt.lifecycle || readGeneration !== rt.historyReadGeneration) throw error;
    rt.historyStatus = `retryable:${oneLine(error)}`;
    await trace($, rt, "history-read-failed", { reason: oneLine(error) });
    throw error;
  }
}

async function reconcileHistory($: EngineInterface, rt: Runtime): Promise<void> {
  if (!rt.reconciliation) rt.reconciliation = readHistory($, rt);
  const task = rt.reconciliation;
  try { await task; } finally { if (rt.reconciliation === task) rt.reconciliation = undefined; }
}

/** A compaction row arrived: acknowledge an owned install or invalidate an
 * unexpected replacement. Handle reconciliation happens at the compact input. */
function noteCompactionRow(rt: Runtime, uuid: string): boolean {
  if (rt.awaitingCompactionRow) {
    rt.awaitingCompactionRow = false;
    return false;
  }
  rt.messageRowIds = [uuid];
  rt.state.discardPublished();
  return true;
}

/** Each event is its own file: concurrent dispatches cannot overwrite it. */
async function trace($: EngineInterface, rt: Runtime, event: string, details: Record<string, unknown> = {}): Promise<void> {
  const sequence = ++rt.traceSequence;
  const row = { version: PLUGIN_VERSION, sessionId: rt.sessionId, at: await $.clock.now(), event, ...details };
  await $.fs.write(`${dataDir($, rt)}/events/${rt.runtimeId}-${String(sequence).padStart(6, "0")}.json`, JSON.stringify(row))
    .catch(() => { $.ui.log("shadow-compact: could not persist a diagnostic event", { to: "debug" }); });
}

async function stopPreparation($: EngineInterface, rt: Runtime, reason: string): Promise<void> {
  const control = rt.preparation;
  if (!control || control.finished || control.stopping) return;
  control.stopping = true;
  control.cancel(reason);
  // The worker polls this file and aborts its current provider request.
  await $.fs.write(`${control.directory}/cancel`, reason).catch(() => undefined);
  await trace($, rt, "prepare-cancel", { generation: control.generation, reason });
}

function noteDraft($: EngineInterface, rt: Runtime, control: PreparationControl, coverage: string): void {
  control.coverageEndEntryId = coverage;
  if (rt.preparation !== control) control.cancel("superseded preparation");
  else if (!rt.messageRowIds.includes(coverage)) {
    void stopPreparation($, rt, `stale:coverage ${coverage} compacted away`);
  }
}

/**
 * Remember native's entire result by content and identity, including its new
 * summary. This also handles hosts which install without a compaction append.
 */
async function compactNatively(
  $: EngineInterface,
  rt: Runtime,
  before: readonly SessionMessage[],
  run: () => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> {
  const beforeIds = rt.transcript.resolve(before);
  const byHandle = new Map(before.flatMap((message, index) => message.handle ? [[message.handle, beforeIds[index]!] as const] : []));
  // Native is about to summarize this history: any in-flight snapshot
  // predates that summary, even when its coverage row survives in the
  // kept tail. Publishing it later would displace the native summary at
  // the next compaction with older, partial state, so it is cancelled
  // now rather than left running (and spending) while native writes.
  // A stale cancel re-arms, so a failed native run re-prepares later.
  if (rt.preparation) {
    await stopPreparation($, rt, "stale:native compaction replaced history");
  }
  rt.awaitingCompactionRow = true;
  const result = await run().catch((error: unknown) => {
    rt.awaitingCompactionRow = false;
    throw error;
  });
  if (!result.messages) {
    rt.awaitingCompactionRow = false;
    return result;
  }
  rt.messageRowIds = result.messages.map(message => {
    const kept = message.handle && byHandle.get(message.handle);
    if (kept && !kept.startsWith("unknown-")) return kept;
    const id = `native-${crypto.randomUUID()}`;
    rt.archive?.addSessionMessage(id, message);
    return id;
  });
  rt.transcript.remember(result.messages, rt.messageRowIds);
  rt.historyReadGeneration += 1;
  rt.revision += 1;
  rt.historyStatus = "reconciled:native";
  // The pre-compaction token figures describe history that is gone.
  rt.tokenEstimate = null;
  rt.lastTokens = null;
  // Native summarized what the checkpoint covered: prepare afresh.
  rt.state.discardPublished();
  rt.archive?.setPreviousCheckpoint(undefined, null);
  rt.lastAttempt = undefined;

  await trace($, rt, "native-complete", { messages: result.messages.length });
  return result;
}

/** Confirms an attempted install against canonical history. */
async function confirmInstall($: EngineInterface, rt: Runtime): Promise<void> {
  const published = rt.state.attemptedCheckpoint;
  if (!published && !rt.awaitingCompactionRow) return;
  const messages = await $.session.messages().catch(() => [] as SessionMessage[]);
  if (rt.awaitingCompactionRow && rt.transcript.matchesPrefix(messages)) rt.awaitingCompactionRow = false;
  if (!rt.state.attemptedCheckpointId || !published) return;
  const first = messages[0];
  if (
    first?.role === "user" && first.text === published.rendered &&
    rt.state.confirmInstall(published.checkpointId)
  ) {
    rt.awaitingCompactionRow = false;
    await trace($, rt, "install-confirmed", { checkpoint: published.checkpointId, coverage: published.coverageEndEntryId });
    $.ui.log("shadow-compact: installed verified checkpoint + exact recent tail", { to: "debug" });
  }
}

function dataDir($: EngineInterface, rt: Runtime): string {
  return `${$.plugin.root}/.shadow-data/${rt.sessionId}`;
}

/** One transport, one retry per affected role, and a fresh deadline per request. */
function roleExecutor($: EngineInterface, rt: Runtime, control: PreparationControl, metrics: ReturnType<typeof emptyPreparationMetrics>): AskFn {
  return async request => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      control.assertActive();
      const roleAttempt = control.beginRole(await $.clock.now(), ROLE_TIMEOUT_MS);
      $.clock.after(ROLE_TIMEOUT_MS, () => {
        if (rt.preparation === control && !control.finished && control.roleDeadline !== undefined && control.roleAttempt === roleAttempt) {
          void stopPreparation($, rt, `role_deadline_exceeded:${request.role}`);
        }
      });
      try {
        const model = request.model === "inherit" ? await $.session.model() : request.model;
        const run = workerRequest(request, model, rt.config.checkpointEffort, control, ROLE_TIMEOUT_MS);
        await $.fs.write(`${control.directory}/${request.role}-request.json`, JSON.stringify(run));
        await trace($, rt, "role-start", { generation: control.generation, role: request.role, attempt: attempt + 1, timeoutMs: ROLE_TIMEOUT_MS, maxTokens: request.maxTokens });
        control.assertActive();
        const exited = await control.race($.process.run(["node", `${$.plugin.root}/${CLAUDE_WORKER_PATH}`], {
          stdin: JSON.stringify(run), timeoutMs: ROLE_TIMEOUT_MS,
        }).catch((error: unknown) => {
          throw new PreparationError("worker_transport_failed", oneLine(error), !/ENOENT|not found|denied|refused/i.test(oneLine(error)));
        }));
        control.assertActive();
        const raw = await $.fs.read(run.outputPath).catch(() => "");
        const answer = workerAnswer(raw, run, exited.exitCode);
        await trace($, rt, "role-complete", { generation: control.generation, role: request.role, attempt: attempt + 1 });
        return answer;
      } catch (error) {
        if (error instanceof PreparationCancelled) throw error;
        const failure = error instanceof PreparationError ? error : new PreparationError("worker_failed", oneLine(error), true);
        if (attempt || !failure.retryable) throw failure;
        metrics.transportRetries += 1;
        await trace($, rt, "role-retry", { generation: control.generation, role: request.role, reason: failure.code, cooldownMs: RETRY_COOLDOWN_MS });
        control.endRole(roleAttempt);
        if (!await control.race(hostPause($, rt, RETRY_COOLDOWN_MS / 1000))) throw new PreparationError("retry_wait_failed", "host could not wait for retry");
      } finally { control.endRole(roleAttempt); }
    }
    throw new PreparationError("worker_failed", "role retry exhausted");
  };
}

function preparationKey(rt: Runtime, instructions = ""): string {
  return `${rt.historyEpoch}:${rt.config.checkpointModel}:${rt.config.checkpointEffort}:${rt.messageRowIds.join("|")}:${JSON.stringify(instructions)}`;
}

function oneLine(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.slice(0, 160).replace(/\s+/g, " ");
}

async function runPreparation(
  $: EngineInterface, rt: Runtime, recovery: boolean, compactSnapshot?: readonly SessionMessage[], instructions = "",
): Promise<void> {
  if (!rt.archive || rt.state.preparing) return;
  const previous = rt.lastAttempt;
  const thresholdRefresh = rt.idleCheckpoint && (rt.tokenEstimate ?? 0) >= rt.effectivePrepareThreshold;
  if (!recovery) {
    if (rt.state.published && rt.state.published.checkpointId !== rt.state.installedCheckpointId && !thresholdRefresh) return;
    if (previous?.error && (rt.coolingDown || (!thresholdRefresh && previous.completedTurns >= rt.completedTurns))) return;
  }
  if (previous?.error && previous.key === preparationKey(rt, instructions) && (!recovery || !previous.error.retryable)) return;
  const generation = rt.state.startPreparing();
  if (generation === undefined) return;
  const lifecycle = rt.lifecycle;
  const started = performance.now();
  const metrics = emptyPreparationMetrics();
  const directory = `${dataDir($, rt)}/prepare-${rt.runtimeId}-${generation}`;
  const control = new PreparationControl(generation, directory, "pending-history", instructions);
  rt.preparation = control;
  rt.idleCheckpoint = (rt.tokenEstimate ?? rt.lastTokens ?? rt.effectivePrepareThreshold) < rt.effectivePrepareThreshold;
  const attempt: Attempt = { key: preparationKey(rt, instructions), completedTurns: rt.completedTurns, error: undefined };
  rt.lastAttempt = attempt;
  rt.coolingDown = false;
  // Bound history/setup I/O separately; model curation has per-role limits.
  $.clock.after(30_000, () => {
    if (rt.preparation === control && !control.finished && control.roleAttempt === 0) {
      void stopPreparation($, rt, "history_setup_timeout");
    }
  });
  let readiness: string | null = null;
  let errorCode: string | null = null;
  let snapshotMs = 0;
  try {
    if (compactSnapshot) await control.race(adoptHistory($, rt, compactSnapshot, "compact"));
    else await control.race(reconcileHistory($, rt));
    control.assertActive();
    attempt.key = preparationKey(rt, instructions);
    const rows = rt.archive!;
    const liveIds = [...rt.messageRowIds];
    const live = rt.transcript.messages(liveIds);
    if (!live || live.length < 2) throw new PreparationError("history_incomplete", "need at least two reconciled messages");
    const snapshotStarted = performance.now();
    const snapshot = rows.snapshot(rows.size - 1, new Set(liveIds));
    control.coverageEndEntryId = liveIds.at(-1)!;
    const epoch = rt.historyEpoch;
    const evidenceHash = await contentDigest(snapshot.fullText());
    snapshotMs = performance.now() - snapshotStarted;
    await $.fs.write(`${directory}/evidence.jsonl`, snapshot.fullText());
    await trace($, rt, "prepare-start", { generation, directory, rows: snapshot.size, coverage: control.coverageEndEntryId, epoch, evidenceDigest: evidenceHash, roleTimeoutMs: ROLE_TIMEOUT_MS });
    const prepared = await control.race(prepareCheckpoint(roleExecutor($, rt, control, metrics), snapshot,
      rt.config.checkpointModel, draft => noteDraft($, rt, control, draft.coverageEndEntryId), { metrics, instructions }));
    control.assertActive();
    const count = liveIds.indexOf(prepared.coverageEndEntryId) + 1;
    const checkpoint: PublishedCheckpoint = {
      checkpointId: `shadow-${generation}-${prepared.coverageEndEntryId}`,
      rendered: prepared.rendered, coverageEndEntryId: prepared.coverageEndEntryId, validation: prepared.validation, compactionInstructions: instructions,
      proof: { sessionId: rt.sessionId, epoch, snapshotId: `${rt.runtimeId}-${generation}`,
        coveredCount: count, prefixDigest: await prefixDigest(live, count), evidenceDigest: evidenceHash },
    };
    const current = rt.transcript.messages(rt.messageRowIds);
    const stale = !count || epoch !== rt.historyEpoch || !current || current.length < count ||
      await prefixDigest(current, count) !== checkpoint.proof.prefixDigest;
    control.assertActive();
    if (stale) throw new PreparationCancelled("stale:covered history changed");
    if (rt.state.publish(generation, checkpoint)) {
      readiness = "verified";
      rt.lastFallback = null;
      rows.setPreviousCheckpoint(checkpoint.rendered, checkpoint.coverageEndEntryId);
      $.ui.status("checkpoint verified; live coverage will be checked at compaction");
      await $.fs.write(`${directory}/checkpoint.json`, JSON.stringify(checkpoint)).catch(() => undefined);
      await trace($, rt, "prepare-verified", { generation, coverage: checkpoint.coverageEndEntryId, backend: "claude-worker", metrics, snapshotMs, durationMs: Math.round(performance.now() - started) });
    }
  } catch (error) {
    if (lifecycle !== rt.lifecycle || rt.preparation !== control) return;
    const stale = error instanceof PreparationCancelled && (control.reason ?? error.message).startsWith("stale:");
    rt.state.fail(generation);
    const failure = error instanceof PreparationError ? error : new PreparationError(
      stale ? "history_changed_during_preparation" : error instanceof PreparationCancelled
        ? control.reason?.startsWith("role_deadline_exceeded") ? "role_deadline_exceeded" : control.reason === "history_setup_timeout" ? "history_setup_timeout" : "preparation_cancelled"
        : "preparation_failed", oneLine(error),
      !(error instanceof PreparationCancelled));
    errorCode = failure.code;
    if (stale && rt.lastAttempt === attempt) attempt.error = failure;
    if (!stale) {
      attempt.error = failure;
      rt.lastFallback = oneLine(failure);
      rt.coolingDown = true;
      $.clock.after(RETRY_COOLDOWN_MS, () => {
        if (rt.lifecycle !== lifecycle || rt.lastAttempt !== attempt) return;
        rt.coolingDown = false;
        if (rt.completedTurns > attempt.completedTurns && preparationKey(rt) !== attempt.key) void runPreparation($, rt, false);
      });
    }
    await trace($, rt, stale ? "prepare-discarded" : "prepare-failed", { generation, reason: oneLine(failure), code: failure.code, retryable: failure.retryable });
  } finally {
    control.finished = true;
    if (rt.preparation === control) rt.preparation = undefined;
    await $.fs.write(`${directory}/outcome.json`, JSON.stringify({ generation, durationMs: Math.round(performance.now() - started),
      snapshotMs, readiness, metrics, errorCode, cancelled: control.reason })).catch(() => undefined);
  }
}

type InstallPlan =
  | { messages: SessionMessage[]; tailStart: number; checkpointId: string; checkpoint: PublishedCheckpoint }
  | { reason: string };

/**
 * Plans installing the serving checkpoint over the live compaction's
 * transcript. Coverage is proven only by the covered row's uuid in the
 * live index and the digest of its entire covered prefix.
 */
async function planInstall(rt: Runtime, messages: readonly SessionMessage[], instructions = ""): Promise<InstallPlan> {
  const published = rt.state.published;
  if (!published) return { reason: "no-checkpoint" };
  if (instructions && published.compactionInstructions !== instructions) return { reason: "manual-focus" };
  // Rebuild from this compact input, never from the append stream's shape.
  rt.messageRowIds = rt.transcript.resolve(messages);
  const proof = published.proof;
  if (proof.sessionId !== rt.sessionId || proof.epoch !== rt.historyEpoch || proof.coveredCount < 1 ||
    messages.length < proof.coveredCount || await prefixDigest(messages, proof.coveredCount) !== proof.prefixDigest) {
    return { reason: "prefix-mismatch" };
  }
  const coveredIndex = proof.coveredCount - 1;
  const handles = messages.flatMap(message => message.handle ? [message.handle] : []);
  if (new Set(handles).size !== handles.length) return { reason: "coverage-ambiguous" };
  const built = buildCandidate(messages, coveredIndex, RECENT_ROUNDS, published.rendered);
  if (isSkipped(built) || !built.messages) {
    return { reason: isSkipped(built) ? built.skipped : "no-candidate" };
  }

  if (estimateMessagesTokens(built.messages) > rt.replacementBudget) return { reason: "replacement-budget-exceeded" };

  return { messages: built.messages, tailStart: built.tailStart, checkpointId: published.checkpointId, checkpoint: published };
}

/** Host commands that sleep one poll; the first that works is kept. */
function pauseCommands(seconds = COMPACT_POLL_SECONDS): string[][] {
  return [
    ["sleep", String(seconds)],
    ["node", "-e", `setTimeout(() => {}, ${seconds * 1000})`],
  ];
}

/**
 * Pauses one poll through a host process. A hook's 10 s budget stops
 * while its `$` calls are in flight, except `$.clock` waits, and awaiting
 * the preparation Promise itself would count too: a chain of short host
 * sleeps is the wait that costs the compact hook nothing. Resolves false
 * when the host cannot sleep, so the caller stops instead of spinning.
 */
async function hostPause($: EngineInterface, rt: Runtime, seconds = COMPACT_POLL_SECONDS): Promise<boolean> {
  const commands = pauseCommands(seconds);
  const order = rt.pauseCommand === null ? commands.map((_, index) => index) : [rt.pauseCommand];
  for (const index of order) {
    if (index < 0) return false;
    const run = await $.process
      .run(commands[index]!, { timeoutMs: seconds * 1000 + 10_000 })
      .catch(() => undefined);
    if (run?.exitCode === 0) {
      rt.pauseCommand = index;
      return true;
    }
  }
  rt.pauseCommand = -1;
  return false;
}

type WaitOutcome = "done" | "failed" | "interrupted" | "hook-budget-exhausted" | "waiter-failed";

/** Await only host process calls. A wait lease is never a preparation deadline. */
async function waitForPreparation(
  $: EngineInterface, rt: Runtime, next: { signal?: AbortSignal; budget?: { remainingMs: number } },
): Promise<WaitOutcome> {
  const lifecycle = rt.lifecycle;
  const abort = () => { void stopPreparation($, rt, "compaction interrupted"); };
  next.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (rt.state.preparing) {
      if (next.signal?.aborted || lifecycle !== rt.lifecycle) return "interrupted";
      if (next.budget && next.budget.remainingMs < COMPACT_BUDGET_RESERVE_MS) return "hook-budget-exhausted";
      const control = rt.preparation;
      if (!control) return "waiter-failed";
      try {
        const result = await $.process.run(["node", `${$.plugin.root}/${CHECKPOINT_WAITER_PATH}`], {
          stdin: JSON.stringify({ directory: control.directory, generation: control.generation, leaseMs: COMPACT_WAIT_LEASE_MS }),
          timeoutMs: COMPACT_WAIT_LEASE_MS + 5_000,
        });
        if (next.signal?.aborted || lifecycle !== rt.lifecycle) return "interrupted";
        if (result.exitCode !== 0) return "waiter-failed";
        const status = JSON.parse(result.stdout) as { generation?: number; status?: string };
        if (status.generation !== control.generation || !["pending", "settled"].includes(status.status ?? "")) return "waiter-failed";
        // A callback publishing the outcome may still be finishing. One small
        // host pause prevents a bad helper returning immediately from spinning.
        if (rt.preparation === control && !control.finished && status.status === "settled") {
          if (!await hostPause($, rt)) return "waiter-failed";
        }
      } catch { return next.signal?.aborted || lifecycle !== rt.lifecycle ? "interrupted" : "waiter-failed"; }
    }
    return rt.state.published ? "done" : "failed";
  } finally { next.signal?.removeEventListener("abort", abort); }
}

async function configureAutoCompactWindow($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.configuringWindow) return rt.configuringWindow;
  const task = applyAutoCompactWindow($, rt);
  rt.configuringWindow = task;
  try { await task; } finally { if (rt.configuringWindow === task) rt.configuringWindow = undefined; }
}

/** A session environment override beats modelSettings without rewriting it. */
async function applyAutoCompactWindow($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: "summary" });
    const before = usage.context.breakdown;
    if (!before) { rt.autoCompactWindow = "unconfirmed:no-breakdown"; return; }
    const decision = decideAutoCompactWindow(rt.config, { modelWindow: usage.context.window });
    if (!decision.apply) { rt.autoCompactWindow = `unconfirmed:${decision.reason}`; return; }
    const requested = decision.tokens;
    rt.replacementBudget = Math.max(1, Math.min(usage.context.window, requested) - 32_000);
    rt.effectivePrepareThreshold = Math.min(rt.config.prepareThresholdTokens, Math.max(IDLE_COMPACT_MIN_TOKENS, requested - 40_000));
    if (rt.configuredModel === before.model && before.rawMaxTokens === requested && rt.autoCompactWindow?.startsWith("applied")) return;
    if (rt.configuredModel === before.model && rt.autoCompactWindow?.startsWith("unconfirmed")) {
      if (before.rawMaxTokens === requested && before.autocompactSource === "env" && await $.env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW") === String(requested)) {
        rt.autoCompactWindow = `applied ${requested} (env)`;
        await trace($, rt, "window-configured", { model: before.model, requested, effective: before.rawMaxTokens, source: "env", deferred: true });
      }
      return;
    }
    rt.configuredModel = before.model;
    const previous = await $.env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    const applied = String(requested);
    const original = rt.windowOverride && previous === rt.windowOverride.applied ? rt.windowOverride.previous : previous;
    await $.env.set("CLAUDE_CODE_AUTO_COMPACT_WINDOW", applied);
    const current = await $.env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    if (current === applied) rt.windowOverride = { previous: original, applied };
    const after = (await $.session.usage({ breakdown: "summary" })).context.breakdown;
    if (current !== applied || after?.rawMaxTokens !== requested || after.autocompactSource !== "env") {
      rt.autoCompactWindow = `unconfirmed requested=${requested} effective=${after?.rawMaxTokens ?? "unknown"}`;
      await trace($, rt, "window-unconfirmed", { model: before.model, requested, effective: after?.rawMaxTokens ?? null, source: after?.autocompactSource ?? null });
      return;
    }
    rt.autoCompactWindow = `applied ${requested} (env)`;
    await trace($, rt, "window-configured", { model: before.model, requested, effective: after.rawMaxTokens,
      source: after.autocompactSource, previous: before.rawMaxTokens, modelWindow: usage.context.window,
      requestedPrepareThreshold: rt.config.prepareThresholdTokens, effectivePrepareThreshold: rt.effectivePrepareThreshold });
  } catch (error) {
    rt.autoCompactWindow = `unconfirmed:${oneLine(error)}`;
    $.ui.log(`shadow-compact: window override unavailable (${oneLine(error)})`, { to: "debug" });
  }
}

async function restoreHostPolicy($: EngineInterface, rt: Runtime): Promise<void> {
  if (rt.windowOverride && await $.env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW").catch(() => undefined) === rt.windowOverride.applied) {
    await $.env.set("CLAUDE_CODE_AUTO_COMPACT_WINDOW", rt.windowOverride.previous).catch(() => undefined);
  }
  if (rt.idleOverride && await $.env.get("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS").catch(() => undefined) === rt.idleOverride.applied) {
    await $.env.set("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS", rt.idleOverride.previous).catch(() => undefined);
  }
}

/**
 * Lowers Claude Code's idle-compaction floor for this process. The engine
 * reads `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` when it considers an idle
 * compaction, so the value set here applies to this session; a floor the
 * person set, or `"idleCompaction": false`, is left as it is.
 */
async function configureIdleCompaction($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const previous = await $.env.get("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS");
    const decision = decideIdleCompaction({
      envValue: previous,
      settings: await $.settings.read(),
    });
    if (!decision.apply) {
      rt.idleCompact = decision.reason === "off-settings" ? "disabled by host" : `host floor ${decision.reason.slice("kept-env ".length)}`;
      await trace($, rt, "idle-floor-kept", { reason: decision.reason });
      return;
    }
    const floor = IDLE_COMPACT_MIN_TOKENS;
    await $.env.set("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS", String(floor));
    if (await $.env.get("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS") !== String(floor)) throw new Error("idle floor write refused");
    rt.idleOverride ??= { previous, applied: String(floor) };
    rt.idleCompact = `${floor.toLocaleString("en-US")} tokens`;
    await trace($, rt, "idle-floor-configured", { floor });
  } catch (error) {
    rt.idleCompact = `failed:${oneLine(error)}`;
    $.ui.log(`shadow-compact: idle compaction floor not configured (${oneLine(error)})`, { to: "debug" });
  }
}

function statusText(rt: Runtime): string {
  const published = rt.state.published;
  const issue = rt.lastFallback ??
    (rt.historyStatus.startsWith("retryable:") ? rt.historyStatus : null) ??
    (rt.autoCompactWindow?.startsWith("failed:") || rt.autoCompactWindow?.startsWith("unconfirmed") ? `window setup: ${rt.autoCompactWindow}` : null) ??
    (rt.idleCompact?.startsWith("failed:") ? `idle setup: ${rt.idleCompact}` : null);
  return [
    `Shadow Compact v${PLUGIN_VERSION} · ${rt.state.phase}`,
    published ? `Checkpoint: verified through ${published.coverageEndEntryId} · installs: ${rt.state.installCount}` : "Checkpoint: none yet",
    `Model: ${rt.config.checkpointModel} · effort: ${rt.config.checkpointEffort} · prepare: ${rt.effectivePrepareThreshold.toLocaleString("en-US")} tokens`,
    `Compaction: ${rt.autoCompactWindow?.startsWith("applied") ? `automatic · window: ${rt.autoCompactWindow.slice(8)}` : "window override unconfirmed"} · idle: ${rt.idleCompact ?? "awaiting host setup"} · native fallbacks: ${rt.nativeFallbacks}`,
    ...(issue ? [`Last issue: ${issue}`] : []),
    `Diagnostics: .shadow-data/${rt.sessionId}/events`,
  ].join("\n");
}

export const register: Register = (on, options) => {
  const rt = createRuntime(resolveConfig(options));

  on("session.start", async ($, e, next) => {
    await ensureSession($, rt);
    await reconcileHistory($, rt).catch(() => undefined);
    await $.command
      .register({ name: "compact-native", description: "Run Claude Code native compaction once, bypassing Shadow" })
      .catch(() => undefined);
    await $.command
      .register({ name: "shadow-status", description: "Show Shadow Compact state" })
      .catch(() => undefined);
    const result = await next(e);
    await configureAutoCompactWindow($, rt);
    await configureIdleCompaction($, rt);
    return result;
  });

  on("session.append", async ($, e, next) => {
    if (e.agentId) return next(e);
    const lifecycle = rt.lifecycle;
    rt.revision += 1;
    rt.pendingAppends += 1;
    try {
      const result = await next(e);
      if (lifecycle !== rt.lifecycle) return result;
      if (result.uuid && result.message) {
        await ensureSession($, rt);
        if (lifecycle !== rt.lifecycle) return result;
        const rows = rt.archive!;
        // A replayed uuid is already archived and indexed.
        const added = rows.addAppend(result.uuid, e.door, result.message, e.origin.kind);
        if (added) {
          // Grow the context estimate with every kept row, so a single
          // long turn crossing the threshold between measures still
          // starts background preparation before compaction.
          rt.tokenEstimate = (rt.tokenEstimate ?? 0) + estimateMessagesTokens([messageFromAppend(result.message)]);
          if (isTranscriptRow(result.message)) {
            rt.transcript.observe(result.uuid, messageFromAppend(result.message));
            const isCheckpointRow =
              rt.awaitingCompactionRow && rows.rows[rows.size - 1]!.text.startsWith(CHECKPOINT_HEADING);
            if (e.door === "compaction" || isCheckpointRow) {
              if (noteCompactionRow(rt, result.uuid)) {
                // History was replaced; the pre-compaction estimate is void.
                rt.tokenEstimate = null;
                rt.archive?.setPreviousCheckpoint(undefined, null);
                rt.lastAttempt = undefined;
                await stopPreparation($, rt, "stale:unobserved compaction replaced history");
              }
            }
            else rt.messageRowIds.push(result.uuid);
          }
          const estimate = rt.tokenEstimate;
          if (
            !rt.state.preparing &&
            estimate !== null &&
            estimate >= rt.effectivePrepareThreshold
          ) {
            void runPreparation($, rt, false);
          }
        }
      }
      return result;
    } finally { if (lifecycle === rt.lifecycle) { rt.pendingAppends -= 1; rt.revision += 1; } }
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId) {
      return next(e);
    }
    rt.completedTurns += 1;
    // A finished main turn may be the last before idle compaction:
    // prepare now so the checkpoint is ready long before it fires.
    const tokens = rt.tokenEstimate ?? rt.lastTokens;
    if (
      rt.idleCompact !== "disabled by host" &&
      tokens !== null &&
      tokens >= IDLE_COMPACT_MIN_TOKENS &&
      !rt.state.preparing
    ) {
      void runPreparation($, rt, false);
    }
    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    await ensureSession($, rt);
    await confirmInstall($, rt);
    await configureAutoCompactWindow($, rt);
    const tokens = e.context.tokens;
    if (typeof tokens === "number" && Number.isFinite(tokens)) {
      rt.lastTokens = tokens;
      // Exact figure replaces the append-grown estimate.
      rt.tokenEstimate = tokens;
      if (isAtOrAbove(e.context, rt.effectivePrepareThreshold)) {
        // An idle-floor checkpoint would leave a long tail at engine
        // compaction: refresh it once now that the threshold is reached.
        void runPreparation($, rt, false);
      }
    }
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    if (e.agentId) return next(e);
    if (next.signal?.aborted) {
      await stopPreparation($, rt, "compaction interrupted");
      return { skip: "Shadow Compact: interrupted" };
    }
    // A precomputed result is speculative and could later stand in for
    // the live compaction; Shadow decides only on live compactions.
    if (e.trigger === "precompute") return { skip: "Shadow Compact decides at live compaction" };
    const instructions = "instructions" in e && typeof e.instructions === "string" ? e.instructions.trim() : "";
    await ensureSession($, rt);
    await confirmInstall($, rt);
    rt.messageRowIds = rt.transcript.resolve(e.messages);
    await trace($, rt, "compact-enter", {
      trigger: e.trigger, messages: e.messages.length, archiveRows: rt.archive?.size,
      measuredTokens: rt.lastTokens, estimatedTokens: rt.tokenEstimate, window: rt.autoCompactWindow,
      unknownHandles: rt.messageRowIds.filter(id => id.startsWith("unknown-")).length,
      checkpoint: rt.state.published?.checkpointId ?? null, preparing: rt.state.preparing,
    });
    if (rt.state.attemptedCheckpointId) {
      rt.state.rejectInstall();
      rt.lastFallback = "install-unconfirmed";
    }
    let waited = "";
    const lifecycle = rt.lifecycle;
    const native = async (reason: string) => {
      if (next.signal?.aborted || lifecycle !== rt.lifecycle) return { skip: "Shadow Compact: compaction interrupted" };
      const decision = `trigger=${e.trigger} native:${reason}${waited}`;
      rt.nativeFallbacks += 1;
      rt.lastFallback = reason;
      $.ui.log(`shadow-compact: ${decision}`);
      await trace($, rt, "compact-native", { decision, error: reason });
      return compactNatively($, rt, e.messages, () => next(e));
    };
    let plan = await planInstall(rt, e.messages, instructions);
    if ("reason" in plan) {
      if (plan.reason === "coverage-ambiguous") return native("coverage_ambiguous");
      const needsRepair = plan.reason === "prefix-mismatch" || rt.messageRowIds.some(id => id.startsWith("unknown-")) || !rt.historyStatus.startsWith("reconciled:");
      if (rt.preparation && rt.preparation.instructions !== instructions) {
        const old = rt.preparation;
        await stopPreparation($, rt, "stale:compaction focus changed");
        rt.state.fail(old.generation);
      }
      if (needsRepair) {
        const old = rt.preparation;
        await stopPreparation($, rt, "stale:reconciling complete compact history");
        if (old) rt.state.fail(old.generation);
        rt.state.discardPublished();
        rt.lastAttempt = undefined;
        await trace($, rt, "compact-reconcile", { messages: e.messages.length });
      }
      // Live compaction is a preparation request, regardless of token thresholds
      // or a previous background failure. Never wait for another user action.
      if (!rt.state.preparing) void runPreparation($, rt, true, e.messages, instructions);
      if (rt.state.preparing) {
        const started = await $.clock.now();
        await trace($, rt, "compact-wait-start", { trigger: e.trigger, reason: plan.reason, leaseMs: COMPACT_WAIT_LEASE_MS });
        const outcome = await waitForPreparation($, rt, next);
        waited = ` waited=${Math.round(((await $.clock.now()) - started) / 1000)}s:${outcome}`;
        await trace($, rt, "compact-wait-end", { outcome, waited });
        if (outcome === "interrupted") {
          await stopPreparation($, rt, "compaction interrupted");
          return { skip: "Shadow Compact: compaction interrupted while its checkpoint prepared" };
        }
        if (outcome === "waiter-failed" || outcome === "hook-budget-exhausted") return native(outcome);
      }
      plan = await planInstall(rt, e.messages, instructions);
      if ("reason" in plan) return native(rt.lastAttempt?.error?.message ?? `checkpoint_ineligible:${plan.reason}`);
    }
    await trace($, rt, "compact-eligible", { checkpoint: plan.checkpointId, tailStart: plan.tailStart, tailMessages: plan.messages.length - 1 });
    // Even a refresh whose end row survives has lost its original prefix.
    // Stop it before installing the older serving checkpoint.
    if (rt.state.preparing) await stopPreparation($, rt, "stale:Shadow compaction replaced history");
    rt.state.attemptInstall(plan.checkpoint);
    rt.awaitingCompactionRow = true;
    const checkpointRow = `checkpoint-${crypto.randomUUID()}`;
    rt.archive?.addSessionMessage(checkpointRow, plan.messages[0]!);
    const inputIds = rt.transcript.bind(e.messages, rt.messageRowIds, rt.historyEpoch);
    rt.messageRowIds = [checkpointRow, ...inputIds.slice(plan.tailStart)];
    rt.transcript.remember(plan.messages, rt.messageRowIds);
    rt.historyReadGeneration += 1;
    rt.revision += 1;
    const decision = `trigger=${e.trigger} shadow:${plan.checkpointId} tailStart=${plan.tailStart}${waited}`;
    $.ui.log(`shadow-compact: ${decision}`, { to: "debug" });
    await trace($, rt, "compact-shadow", { decision, messages: plan.messages.length });
    return { messages: plan.messages };
  }).catch(async ($, e, next) => {
    if (String(next.error.kind) === "re-entry") return undefined;
    if (next.called) return next(e);
    if (next.signal?.aborted) return { skip: "Shadow Compact: interrupted" };
    const reason = `hook-${next.error.kind}`;
    rt.nativeFallbacks += 1;
    rt.lastFallback = reason;
    // Signal cancellation synchronously; the catch handler has its own short budget.
    rt.preparation?.cancel(reason);
    if (rt.preparation) void $.fs.write(`${rt.preparation.directory}/cancel`, reason).catch(() => undefined);
    return next(e);
  });

  on("command.run", { command: "shadow-status" }, async ($, _e, _next) => {
    await ensureSession($, rt);
    if (!rt.historyStatus.startsWith("reconciled:")) await reconcileHistory($, rt).catch(() => undefined);
    await confirmInstall($, rt);
    return { text: statusText(rt) };
  });

  // `$.session.compact()` skips this mod's own hook: exactly a native run.
  on("command.run", { command: "compact-native" }, async ($, _e, _next) => {
    await ensureSession($, rt);
    $.clock.after(50, () => {
      void compactNatively($, rt, [], () => $.session.compact()).catch((error: unknown) => {
        $.ui.log(`shadow-compact: native compaction failed (${oneLine(error)})`);
      });
    });
    return { text: "shadow-compact: running Claude Code native compaction." };
  });

  on("session.end", async ($, e, next) => {
    await stopPreparation($, rt, "session ended");
    if (rt.configuringWindow) await rt.configuringWindow.catch(() => undefined);
    await restoreHostPolicy($, rt);
    const result = await next(e);
    rt.state.reset();
    rt.preparation = undefined;
    rt.archive = undefined;
    rt.messageRowIds = [];
    rt.transcript = new LiveTranscript();
    rt.initializing = undefined;
    rt.reconciliation = undefined;
    rt.historyStatus = "pending";
    rt.historyEpoch = 0;
    rt.revision = 0;
    rt.pendingAppends = 0;
    rt.lifecycle += 1;
    rt.awaitingCompactionRow = false;
    rt.lastFallback = null;
    rt.nativeFallbacks = 0;
    rt.autoCompactWindow = null;
    rt.idleCompact = null;
    rt.lastTokens = null;
    rt.tokenEstimate = null;
    rt.idleCheckpoint = false;
    rt.pauseCommand = null;
    rt.lastAttempt = undefined;
    rt.completedTurns = 0;
    rt.coolingDown = false;
    rt.configuredModel = null;
    rt.configuringWindow = undefined;
    rt.windowOverride = undefined;
    rt.idleOverride = undefined;
    rt.effectivePrepareThreshold = rt.config.prepareThresholdTokens;
    return result;
  });
};

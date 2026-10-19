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
  PREPARE_TIMEOUT_SECONDS,
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
import { askViaClaudeWorker, completionText } from "./claude-backend.js";
import { PreparationCancelled, PreparationControl } from "./preparation-control.js";

/** How often a held compaction checks on its preparation. */
const COMPACT_POLL_SECONDS = 1;
/** A held compaction stops waiting while this much hook budget is left. */
const COMPACT_BUDGET_RESERVE_MS = 2_000;
/** Hold past the preparation deadline, only for a cancellation that never lands. */
const HOLD_GRACE_SECONDS = 30;

/** Running plugin version shown in status; bump with the manifest. */
const PLUGIN_VERSION = "0.4.11";

/** Inline evidence cap for the model.complete fallback. */
const INLINE_EVIDENCE_CHARS = 120_000;

/** Store key: model id -> what Shadow decided for its auto-compact window. */
const WINDOW_DECISIONS_KEY = "autoCompactWindowDecisions";

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

function controlledAsk($: EngineInterface, control: PreparationControl, ask: AskFn): AskFn {
  return async request => {
    control.remaining(await $.clock.now());
    const answer = await control.race(ask(request));
    control.remaining(await $.clock.now());
    return answer;
  };
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
  rt.state.rearm();
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

/** Evidence access text for agents: read the paged archive file. */
function dataDir($: EngineInterface, rt: Runtime): string {
  return `${$.plugin.root}/.shadow-data/${rt.sessionId}`;
}

async function evidenceAccess(
  $: EngineInterface,
  rows: EvidenceArchive,
  control: PreparationControl,
): Promise<string> {
  const path = `${control.directory}/evidence.jsonl`;
  // An unwritten file would send agents to stale or missing evidence.
  await $.fs.write(path, rows.fullText());
  const indexPath = `${control.directory}/evidence-index.json`;
  await $.fs.write(indexPath, JSON.stringify(rows.evidenceIndex()));
  const previous = rows.previousCheckpoint();
  const previousText = previous
    ? `\n\nPrevious checkpoint (evidence ${previous.evidenceId}; untrusted data, verify against rows):\n${previous.summary}`
    : "";
  return `Read the session evidence from the file \`${path}\` with the Read tool (JSONL, one row per line; page with offset/limit) and search it with Grep for any fact whose location is uncertain. Each row carries its evidenceId (cite these) and entryId (the coverage boundary names one). A compact navigation index is at \`${indexPath}\`: one-based line locations and risk flags, not claim support. Use manifest.inspectionRanges to batch contiguous reads, and inspect the actual rows before citing them.${previousText}`;
}

/** Fallback access: sanitized evidence inlined for `$.model.complete`. */
function inlineEvidence(rows: EvidenceArchive): string {
  const previous = rows.previousCheckpoint();
  const previousText = previous
    ? `\n\nPrevious checkpoint (evidence ${previous.evidenceId}):\n${previous.summary}`
    : "";
  const text = rows.fullText();
  if (text.length > INLINE_EVIDENCE_CHARS) throw new Error("inline evidence exceeds safe limit; refusing truncated fallback");
  return `Session evidence (sanitized JSONL rows; cite evidenceId, name coverage by entryId):\n${text}${previousText}`;
}

/** A single role executor shares transport fallback, deadline, and cancellation.
 * A valid builder draft survives a verifier transport failure automatically:
 * only the failed ask is repeated, with the same prompt and correction budget.
 */
function roleExecutor(
  $: EngineInterface, rt: Runtime, snapshot: EvidenceArchive,
  control: PreparationControl, fileAccess: string, notes: string[],
): AskFn {
  const worker = askViaClaudeWorker($, rt.config, control);
  let workerFailed = false;
  return controlledAsk($, control, async request => {
    if (!workerFailed) {
      try { return await control.race(worker(request)); }
      catch (error) {
        if (error instanceof PreparationCancelled) throw error;
        workerFailed = true;
        notes.push(`${request.role}-worker:${oneLine(error)}`);
        rt.lastFallback = notes.join(" then ");
      }
    }
    control.remaining(await $.clock.now());
    const prompt = request.prompt.replaceAll(fileAccess, inlineEvidence(snapshot));
    // Current host types name only model/prompt/system/maxTokens. Effort and
    // the preparation deadline still travel at runtime; the worker honors
    // both and newer hosts accept them on inline completion as well.
    const completeRequest = {
      model: request.model === "inherit" ? await $.session.model() : request.model,
      system: request.system, prompt, maxTokens: 16_000,
      effort: rt.config.checkpointEffort, timeoutMs: control.remaining(await $.clock.now()),
    } as Parameters<EngineInterface["model"]["complete"]>[0] & {
      effort: ShadowConfig["checkpointEffort"];
      timeoutMs: number;
    };
    return completionText(await $.model.complete(completeRequest));
  });
}

function oneLine(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.slice(0, 160).replace(/\s+/g, " ");
}

async function runPreparation(
  $: EngineInterface, rt: Runtime, recovery: boolean,
  compactSnapshot?: readonly SessionMessage[], sharedDeadline?: number,
): Promise<void> {
  if (!rt.archive || rt.state.preparing) return;
  if (!recovery && !rt.state.refreshArmed) return;
  const generation = rt.state.startPreparing();
  if (generation === undefined) return;
  const lifecycle = rt.lifecycle;
  const started = performance.now();
  const notes: string[] = [];
  const metrics = emptyPreparationMetrics();
  const pipelineOptions: PreparationOptions = { metrics };
  let snapshotMs = 0;
  let readiness: string | null = null;
  const directory = `${dataDir($, rt)}/prepare-${rt.runtimeId}-${generation}`;
  const control = new PreparationControl(generation, directory,
    sharedDeadline ?? (await $.clock.now()) + PREPARE_TIMEOUT_SECONDS * 1000, "pending-history");
  if (lifecycle !== rt.lifecycle) { control.cancel("session changed during preparation startup"); return; }
  rt.preparation = control;
  try {
    $.clock.after(Math.max(1, control.deadline - (await $.clock.now())), () => {
      if (rt.preparation === control && !control.finished) void stopPreparation($, rt, "preparation deadline reached");
    });
    if (compactSnapshot) await control.race(adoptHistory($, rt, compactSnapshot, "compact"));
    else await control.race(reconcileHistory($, rt));
    control.remaining(await $.clock.now());
    rt.state.disarmRefresh();
    const rows = rt.archive!;
    const liveIds = [...rt.messageRowIds];
    const live = rt.transcript.messages(liveIds);
    if (!live || live.length < 2) throw new Error("history-incomplete: need at least 2 reconciled messages");
    const snapshotStarted = performance.now();
    const snapshot = rows.snapshot(rows.size - 1, new Set(liveIds));
    control.coverageEndEntryId = liveIds.at(-1)!;
    const epoch = rt.historyEpoch;
    const evidenceHash = await contentDigest(snapshot.fullText());
    snapshotMs = performance.now() - snapshotStarted;
    await trace($, rt, "prepare-start", { generation, directory, rows: snapshot.size, coverage: control.coverageEndEntryId, epoch, evidenceDigest: evidenceHash, deadline: control.deadline });
    const access = await evidenceAccess($, snapshot, control);
    const prepared = await control.race(prepareCheckpoint(
      roleExecutor($, rt, snapshot, control, access, notes), snapshot, access,
      rt.config.checkpointModel,
      draft => noteDraft($, rt, control, draft.coverageEndEntryId), pipelineOptions,
    ));
    const backend = notes.length ? "claude-complete-fallback" : "claude-worker";
    control.remaining(await $.clock.now());
    const checkpoint: PublishedCheckpoint = {
      checkpointId: `shadow-${generation}-${prepared.coverageEndEntryId}`,
      rendered: prepared.rendered,
      coverageEndEntryId: prepared.coverageEndEntryId,
      validation: prepared.validation,
      proof: {
        sessionId: rt.sessionId, epoch, snapshotId: `${rt.runtimeId}-${generation}`,
        coveredCount: liveIds.indexOf(prepared.coverageEndEntryId) + 1,
        prefixDigest: await prefixDigest(live, liveIds.indexOf(prepared.coverageEndEntryId) + 1),
        evidenceDigest: evidenceHash,
      },
    };
    // A compaction that ran meanwhile may have removed the covered row:
    // such a checkpoint could never install, so it is never published.
    const current = rt.transcript.messages(rt.messageRowIds);
    const stale = !checkpoint.proof.coveredCount || epoch !== rt.historyEpoch || !current ||
      await prefixDigest(current, checkpoint.proof.coveredCount) !== checkpoint.proof.prefixDigest || current.length < checkpoint.proof.coveredCount;
    control.remaining(await $.clock.now());
    if (stale) {
      if (rt.state.discardStale(generation)) {
        notes.push(`stale:coverage ${checkpoint.coverageEndEntryId} compacted away`);
        rt.lastFallback = notes.join(" then ");
        $.ui.log(`shadow-compact: discarded a checkpoint born stale (covers ${checkpoint.coverageEndEntryId})`, { to: "debug" });
      }
    } else if (rt.state.publish(generation, checkpoint)) {
      control.finished = true;
      readiness = "verified";
      rt.lastFallback = notes.length ? notes.join(" then ") : null;
      rows.setPreviousCheckpoint(checkpoint.rendered, checkpoint.coverageEndEntryId);
      $.ui.status(`checkpoint ${readiness}; live coverage will be checked at compaction`);
      await $.fs.write(`${directory}/checkpoint.json`, JSON.stringify(checkpoint)).catch(() => undefined);
      await trace($, rt, "prepare-verified", { generation, coverage: checkpoint.coverageEndEntryId, backend, readiness, validation: prepared.validation, metrics, snapshotMs, durationMs: Math.round(performance.now() - started) });
    }
  } catch (error) {
    if (lifecycle !== rt.lifecycle || rt.preparation !== control) return;
    if (error instanceof PreparationCancelled) await stopPreparation($, rt, control.reason ?? oneLine(error));
    const stale = error instanceof PreparationCancelled && control.reason?.startsWith("stale:");
    if (stale) rt.state.discardStale(generation);
    else rt.state.fail(generation);
    notes.push(`failed:${oneLine(error)}`);
    if (!stale) rt.lastFallback = notes.join(" then ");
    $.ui.log(`shadow-compact: preparation failed (${oneLine(error)})`, { to: "debug" });
    await trace($, rt, stale ? "prepare-discarded" : "prepare-failed", { generation, reason: oneLine(error) });
  } finally {
    control.finished = true;
    if (rt.preparation === control) rt.preparation = undefined;
    await $.fs.write(`${directory}/outcome.json`, JSON.stringify({ generation, durationMs: Math.round(performance.now() - started), snapshotMs, readiness, metrics, fallback: notes, cancelled: control.reason }))
      .catch(() => undefined);
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
async function planInstall(rt: Runtime, messages: readonly SessionMessage[]): Promise<InstallPlan> {
  const published = rt.state.published;
  if (!published) return { reason: "no-checkpoint" };
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

  return { messages: built.messages, tailStart: built.tailStart, checkpointId: published.checkpointId, checkpoint: published };
}

/** Host commands that sleep one poll; the first that works is kept. */
function pauseCommands(): string[][] {
  return [
    ["sleep", String(COMPACT_POLL_SECONDS)],
    ["node", "-e", `setTimeout(() => {}, ${COMPACT_POLL_SECONDS * 1000})`],
  ];
}

/**
 * Pauses one poll through a host process. A hook's 10 s budget stops
 * while its `$` calls are in flight, except `$.clock` waits, and awaiting
 * the preparation Promise itself would count too: a chain of short host
 * sleeps is the wait that costs the compact hook nothing. Resolves false
 * when the host cannot sleep, so the caller stops instead of spinning.
 */
async function hostPause($: EngineInterface, rt: Runtime): Promise<boolean> {
  const commands = pauseCommands();
  const order = rt.pauseCommand === null ? commands.map((_, index) => index) : [rt.pauseCommand];
  for (const index of order) {
    if (index < 0) return false;
    const run = await $.process
      .run(commands[index]!, { timeoutMs: COMPACT_POLL_SECONDS * 1000 + 10_000 })
      .catch(() => undefined);
    if (run?.exitCode === 0) {
      rt.pauseCommand = index;
      return true;
    }
  }
  rt.pauseCommand = -1;
  return false;
}

type WaitOutcome = "done" | "failed" | "timeout" | "interrupted" | "budget" | "no-pause";

/**
 * Holds a live compaction while a preparation runs, until it settles or
 * `waitSeconds` pass. Preparation keeps running in its own dispatches (each role has its own worker process); this only
 * watches for it to settle.
 */
async function waitForPreparation(
  $: EngineInterface,
  rt: Runtime,
  next: { signal?: AbortSignal; budget?: { remainingMs: number } },
  waitSeconds: number,
): Promise<WaitOutcome> {
  const deadline = (await $.clock.now()) + waitSeconds * 1000;
  while (rt.state.preparing) {
    if (next.signal?.aborted) return "interrupted";
    if (next.budget && next.budget.remainingMs < COMPACT_BUDGET_RESERVE_MS) return "budget";
    if ((await $.clock.now()) >= deadline) return "timeout";
    if (!(await hostPause($, rt))) return "no-pause";
  }
  return rt.state.published ? "done" : "failed";
}

/**
 * Sets Claude Code's auto-compact window once per model so engine
 * compaction lands after Shadow's prepare threshold. `/autocompact`
 * applies to the running session and saves under `modelSettings`; an
 * existing env, settings or managed window is left as it is.
 */
async function configureAutoCompactWindow($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const usage = await $.session.usage({ breakdown: "summary" });
    const breakdown = usage.context.breakdown;
    if (!breakdown) {
      rt.autoCompactWindow = "unknown:no-breakdown";
      return;
    }
    const stored = await $.store.get(WINDOW_DECISIONS_KEY);
    const decisions: Record<string, unknown> =
      typeof stored === "object" && stored !== null ? { ...(stored as Record<string, unknown>) } : {};
    const model = breakdown.model;
    const decision = decideAutoCompactWindow(rt.config, {
      model,
      effectiveWindow: breakdown.rawMaxTokens,
      modelWindow: usage.context.window,
      source: breakdown.autocompactSource,
      settings: await $.settings.read(),
      previousDecision: decisions[model],
    });
    const effective = `${breakdown.rawMaxTokens} (${breakdown.autocompactSource})`;
    if (!decision.apply) {
      rt.autoCompactWindow = `${decision.reason} ${effective}`;
      await trace($, rt, "window-kept", { reason: decision.reason, effective: breakdown.rawMaxTokens, model });
      return;
    }
    const requested = decision.tokens;
    await $.command.run({ command: "autocompact", args: String(requested) });
    const after = (await $.session.usage({ breakdown: "summary" })).context.breakdown;
    if (after?.autocompactSource !== "settings" || after.rawMaxTokens !== requested) {
      rt.autoCompactWindow = `unconfirmed requested=${requested} effective=${after ? `${after.rawMaxTokens} (${after.autocompactSource})` : "unknown"}`;
      return;
    }
    await $.store.set(WINDOW_DECISIONS_KEY, { ...decisions, [model]: `applied:${requested}` });
    rt.autoCompactWindow = `applied ${requested} (settings)`;
    await trace($, rt, "window-configured", { model, requested, modelWindow: usage.context.window, prepareThreshold: rt.config.prepareThresholdTokens, previous: decisions[model] ?? null });
  } catch (error) {
    rt.autoCompactWindow = `failed:${oneLine(error)}`;
    $.ui.log(`shadow-compact: auto-compact window not configured (${oneLine(error)})`, { to: "debug" });
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
    const decision = decideIdleCompaction({
      envValue: await $.env.get("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS"),
      settings: await $.settings.read(),
    });
    if (!decision.apply) {
      rt.idleCompact = decision.reason === "off-settings" ? "disabled by host" : `host floor ${decision.reason.slice("kept-env ".length)}`;
      await trace($, rt, "idle-floor-kept", { reason: decision.reason });
      return;
    }
    const floor = IDLE_COMPACT_MIN_TOKENS;
    await $.env.set("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS", String(floor));
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
    `Model: ${rt.config.checkpointModel} · effort: ${rt.config.checkpointEffort} · prepare: ${rt.config.prepareThresholdTokens.toLocaleString("en-US")} tokens`,
    `Compaction: automatic · idle: ${rt.idleCompact ?? "awaiting host setup"} · native fallbacks: ${rt.nativeFallbacks}`,
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
                await stopPreparation($, rt, "stale:unobserved compaction replaced history");
              }
            }
            else rt.messageRowIds.push(result.uuid);
          }
          const estimate = rt.tokenEstimate;
          if (
            !rt.state.preparing &&
            estimate !== null &&
            estimate >= rt.config.prepareThresholdTokens
          ) {
            if (rt.idleCheckpoint) {
              rt.idleCheckpoint = false;
              rt.state.rearm();
            }
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
    // A finished main turn may be the last before idle compaction:
    // prepare now so the checkpoint is ready long before it fires.
    const tokens = rt.tokenEstimate ?? rt.lastTokens;
    if (
      rt.idleCompact !== "disabled by host" &&
      tokens !== null &&
      tokens >= IDLE_COMPACT_MIN_TOKENS &&
      tokens < rt.config.prepareThresholdTokens &&
      !rt.state.preparing
    ) {
      void runPreparation($, rt, false);
      if (rt.state.preparing) rt.idleCheckpoint = true;
    }
    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    await ensureSession($, rt);
    await confirmInstall($, rt);
    const tokens = e.context.tokens;
    if (typeof tokens === "number" && Number.isFinite(tokens)) {
      rt.lastTokens = tokens;
      // Exact figure replaces the append-grown estimate.
      rt.tokenEstimate = tokens;
      if (rt.state.phase === "installed" && tokens < rt.config.prepareThresholdTokens) {
        rt.state.rearm();
      }
      if (isAtOrAbove(e.context, rt.config.prepareThresholdTokens)) {
        // An idle-floor checkpoint would leave a long tail at engine
        // compaction: refresh it once now that the threshold is reached.
        if (rt.idleCheckpoint && !rt.state.preparing) {
          rt.idleCheckpoint = false;
          rt.state.rearm();
        }
        void runPreparation($, rt, false);
      }
    }
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    if (e.agentId) return next(e);
    // A precomputed result is speculative and could later stand in for
    // the live compaction; Shadow decides only on live compactions.
    if (e.trigger === "precompute") return { skip: "Shadow Compact decides at live compaction" };
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
    let firstReason: string | undefined;
    const native = async (reason: string) => {
      const why = firstReason && firstReason !== reason ? `${firstReason}${waited} then:${reason}` : `${reason}${waited}`;
      const decision = `trigger=${e.trigger} native:${why}`;
      rt.nativeFallbacks += 1;
      rt.lastFallback = why;
      $.ui.log(`shadow-compact: ${decision}`);
      await trace($, rt, "compact-native", { decision });
      return compactNatively($, rt, e.messages, () => next(e));
    };
    let plan = await planInstall(rt, e.messages);
    const started = await $.clock.now();
    const deadline = rt.preparation?.deadline ?? started + PREPARE_TIMEOUT_SECONDS * 1000;
    let repaired = false;
    // One repair may replace an obsolete suffix-only preparation. Both waits
    // and that replacement share the original compaction/preparation deadline.
    for (let pass = 0; pass < 2 && "reason" in plan; pass += 1) {
      if (plan.reason === "coverage-ambiguous") break;
      const unknown = rt.messageRowIds.some(id => id.startsWith("unknown-"));
      const needsRepair = plan.reason === "prefix-mismatch" || unknown || !rt.historyStatus.startsWith("reconciled:");
      firstReason ??= needsRepair ? "history-unproven" : plan.reason;
      if (needsRepair && !repaired) {
        repaired = true;
        const old = rt.preparation;
        await stopPreparation($, rt, "stale:reconciling complete compact history");
        if (old) rt.state.discardStale(old.generation);
        rt.state.discardPublished();
        rt.state.rearm();
        await trace($, rt, "compact-reconcile", { messages: e.messages.length, deadline });
        void runPreparation($, rt, true, e.messages, deadline);
      } else if (!rt.state.preparing && !needsRepair) {
        void runPreparation($, rt, false, e.messages, deadline);
      }
      if (!rt.state.preparing) break;
      const waitSeconds = Math.max(0, Math.ceil((deadline - (await $.clock.now())) / 1000)) + HOLD_GRACE_SECONDS;
      await trace($, rt, "compact-wait-start", { trigger: e.trigger, reason: firstReason, seconds: waitSeconds });
      const outcome = await waitForPreparation($, rt, next, waitSeconds);
      waited = ` waited=${Math.round(((await $.clock.now()) - started) / 1000)}s:${outcome}`;
      await trace($, rt, "compact-wait-end", { outcome, waited });
      if (outcome === "interrupted") {
        await stopPreparation($, rt, "compaction interrupted");
        await trace($, rt, "compact-interrupted", { trigger: e.trigger, waited });
        return { skip: "Shadow Compact: compaction interrupted while its checkpoint prepared" };
      }
      plan = await planInstall(rt, e.messages);
      if (outcome !== "done") break;
    }
    if ("reason" in plan) return native(plan.reason);
    await trace($, rt, "compact-eligible", { checkpoint: plan.checkpointId, tailStart: plan.tailStart, tailMessages: plan.messages.length - 1 });
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
    if (String(next.error.kind) === "re-entry" || next.called) return undefined;
    const decision = `trigger=${e.trigger} native:hook-${next.error.kind}`;
    rt.nativeFallbacks += 1;
    rt.lastFallback = `hook-${next.error.kind}`;
    $.ui.log(`shadow-compact: ${decision}`);
    await trace($, rt, "compact-native", { decision });
    return compactNatively($, rt, e.messages, () => next(e));
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
    return result;
  });
};

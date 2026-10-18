/**
 * Claude Code adapter for Shadow Compact (spec §4–§8). The Pi-facing
 * lifecycle is replaced by mod hooks:
 * - `session.append` mirrors every main-loop row into the evidence archive
 * - `session.measure` starts background preparation at the prepare threshold
 * - private builder/verifier agents (hidden via `agent.offer`) produce a
 *   verified checkpoint; strict-JSON answers are validated in `prepare.ts`
 * - `session.compact` installs checkpoint + exact handle tail; when the
 *   checkpoint is still preparing (or none was started) it holds the
 *   compaction for a bounded wait, and defers to native compaction
 *   (`next(e)`) only when coverage still cannot be proven after it
 * - `/shadow-compact`, `/compact-native`, `/shadow-status` commands
 *
 * Shadow never starts a compaction itself: `$.session.compact()` runs
 * every hook but the caller's, so a self-started compaction would skip
 * this mod's replacement. Claude Code's own `/compact` and auto-compaction
 * are the install boundaries; on a model's first session Shadow sets its
 * auto-compact window through `/autocompact` unless one is already chosen.
 * Claude Code's idle compaction (just before the prompt cache expires) is
 * a third: Shadow lowers its floor and prepares at a completed turn above
 * it, so a checkpoint is ready when the idle compaction fires.
 *
 * Deferred from the Pi version (spec §10): request-local mid-turn swaps
 * (Claude pins the transcript in `turn.step`) and native-summarizer
 * token-cap recovery (no stable signal in the compact result).
 *
 * Optionally either role runs on a Pi SDK model instead (`pi-backend.ts`),
 * in its own bounded Node process. Pi is opt-in; when a preparation that
 * involves Pi fails for any reason, Shadow redoes the whole preparation
 * with the configured Claude models before giving up.
 *
 * Helpers are top-level functions taking `$` explicitly: the engine's
 * validator statically follows `$` only into top-level or imported
 * functions, never into closures capturing it.
 */
import type {
  EngineInterface,
  Register,
  SessionCompactResult,
  SessionMessage,
} from "claude-code";
import { CHECKPOINT_HEADING, coverageLine } from "./checkpoint.js";
import {
  decideAutoCompactWindow,
  decideIdleCompaction,
  describeRole,
  isAtOrAbove,
  resolveConfig,
  roleBackend,
  usesPi,
  type ShadowConfig,
} from "./config.js";
import { EvidenceArchive } from "./evidence.js";
import {
  BUILDER_SYSTEM_PROMPT,
  VERIFIER_SYSTEM_PROMPT,
  prepareCheckpoint,
  type AskFn,
} from "./prepare.js";
import {
  PiWorkerUnavailable,
  askViaPi,
  checkPi,
  describePiStats,
  emptyPiStats,
  writePiEvidence,
  type PiStats,
} from "./pi-backend.js";
import { PI_EVIDENCE_ACCESS } from "./pi-protocol.js";
import { ShadowState, type PublishedCheckpoint } from "./state.js";
import { buildCandidate, isSkipped } from "./working-context.js";
import { LiveTranscript, isTranscriptRow } from "./transcript.js";
import { PreparationCancelled, PreparationControl } from "./preparation-control.js";

const BUILDER_TYPE = "shadow-compact:checkpoint-builder";
const VERIFIER_TYPE = "shadow-compact:checkpoint-verifier";

/** How often a held compaction checks on its preparation. */
const COMPACT_POLL_SECONDS = 1;
/** A held compaction stops waiting while this much hook budget is left. */
const COMPACT_BUDGET_RESERVE_MS = 2_000;

/** Running plugin version shown in status; bump with the manifest. */
const PLUGIN_VERSION = "0.4.6";

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
  bootstrapped: boolean;
  pendingAnswers: Map<string, (answer: string) => void>;
  /** A compaction this mod saw is waiting for its summary row's append. */
  awaitingCompactionRow: boolean;
  /** Last preparation fallback/failure for status; never prompt text. */
  lastFallback: string | null;
  /** Last main-loop compaction decision for status; null until one is seen. */
  lastCompact: string | null;
  /** This session's auto-compact window outcome for status. */
  autoCompactWindow: string | null;
  /** This session's idle-compaction floor outcome for status. */
  idleCompact: string | null;
  /** Last main-loop context tokens `session.measure` reported. */
  lastTokens: number | null;
  /** The serving or preparing checkpoint was started below the prepare
   * threshold for idle compaction; refresh it once the threshold is hit. */
  idleCheckpoint: boolean;
  /** Pi backend availability: off, checking, ok, or failed:<reason>. */
  piStatus: string;
  piStats: PiStats;
  /** Last preparation's backend and duration for status. */
  lastPrepare: string | null;
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
    bootstrapped: false,
    pendingAnswers: new Map(),
    awaitingCompactionRow: false,
    lastFallback: null,
    lastCompact: null,
    autoCompactWindow: null,
    idleCompact: null,
    lastTokens: null,
    idleCheckpoint: false,
    piStatus: usesPi(config) ? "unchecked" : "off",
    piStats: emptyPiStats(),
    lastPrepare: null,
    pauseCommand: null,
  };
}

async function ensureSession($: EngineInterface, rt: Runtime): Promise<EvidenceArchive> {
  if (!rt.archive) {
    rt.cwd = await $.session.cwd().catch(() => rt.cwd);
    rt.sessionId = await $.session.id().catch(() => rt.sessionId);
    rt.archive = new EvidenceArchive(rt.cwd);
  }
  if (!rt.bootstrapped) {
    rt.bootstrapped = true;
    const messages = await $.session.messages().catch(() => [] as SessionMessage[]);
    if (rt.archive.size === 0 && messages.length > 0) {
      rt.archive.bootstrap(messages);
      rt.messageRowIds = rt.archive.rows.map((row) => row.id);
      rt.transcript.remember(messages, rt.messageRowIds);
    }
  }
  return rt.archive;
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
  for (const agentId of control.agents) {
    await $.tool.call({ tool: "TaskStop", task_id: agentId }).catch(() => undefined);
  }
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
  if (rt.preparation && !rt.messageRowIds.includes(rt.preparation.coverageEndEntryId)) {
    await stopPreparation($, rt, `stale:coverage ${rt.preparation.coverageEndEntryId} compacted away`);
  }
  // Native summarized what the checkpoint covered: prepare afresh.
  rt.state.discardPublished();
  rt.state.rearm();
  await trace($, rt, "native-complete", { messages: result.messages.length });
  return result;
}

/** Confirms an attempted install against canonical history. */
async function confirmInstall($: EngineInterface, rt: Runtime): Promise<void> {
  const published = rt.state.published;
  if (!rt.state.attemptedCheckpointId && !rt.awaitingCompactionRow) return;
  const messages = await $.session.messages().catch(() => [] as SessionMessage[]);
  if (rt.awaitingCompactionRow && rt.transcript.matchesPrefix(messages)) rt.awaitingCompactionRow = false;
  if (!rt.state.attemptedCheckpointId || !published) return;
  const first = messages[0];
  if (
    first?.text.startsWith(CHECKPOINT_HEADING) &&
    first.text.includes(coverageLine(published.coverageEndEntryId))
  ) {
    rt.state.confirmInstall();
    rt.awaitingCompactionRow = false;
    await trace($, rt, "install-confirmed", { checkpoint: published.checkpointId, coverage: published.coverageEndEntryId });
    $.ui.log("shadow-compact: installed verified checkpoint + exact recent tail");
  }
}

/** Evidence access text for agents: read the paged archive file. */
function dataDir($: EngineInterface, rt: Runtime): string {
  return `${$.plugin.root}/.shadow-data/${rt.sessionId}`;
}

async function evidenceAccess(
  $: EngineInterface,
  rt: Runtime,
  rows: EvidenceArchive,
  control: PreparationControl,
): Promise<string> {
  const path = `${control.directory}/evidence.jsonl`;
  // An unwritten file would send agents to stale or missing evidence.
  await $.fs.write(path, rows.fullText());
  const previous = rows.previousCheckpoint();
  const previousText = previous
    ? `\n\nPrevious checkpoint (evidence ${previous.evidenceId}; untrusted data, verify against rows):\n${previous.summary}`
    : "";
  return `Read the session evidence from the file \`${path}\` with the Read tool (JSONL, one row per line; page with offset/limit) and search it with Grep for any fact whose location is uncertain. Each row carries its evidenceId (cite these) and entryId (the coverage boundary names one).${previousText}`;
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

function askViaAgent($: EngineInterface, rt: Runtime, kind: "builder" | "verifier", control: PreparationControl): AskFn {
  return async (request) => {
    const spawned = await $.agent.spawn({
      subagentType: kind === "builder" ? BUILDER_TYPE : VERIFIER_TYPE,
      prompt: request.prompt,
      description: kind === "builder" ? "Build shadow checkpoint" : "Verify shadow checkpoint",
      ...(request.model !== "inherit" ? { model: request.model } : {}),
    });
    if (spawned.deny || !spawned.agentId) {
      throw new Error(`Agent spawn refused: ${spawned.deny ?? "no agent id"}`);
    }
    const agentId = spawned.agentId;
    control.agents.add(agentId);
    if (control.reason) {
      await $.tool.call({ tool: "TaskStop", task_id: agentId }).catch(() => undefined);
      throw new PreparationCancelled(control.reason);
    }
    const answer = new Promise<string>((resolve) => {
      rt.pendingAnswers.set(agentId, resolve);
    });
    try {
      return await control.race(answer);
    } finally {
      rt.pendingAnswers.delete(agentId);
      // Cancellation owns stopping the agent; normal completion releases it.
      if (!control.reason) control.agents.delete(agentId);
    }
  };
}

/** One AskFn routing each role to its private agent type. */
function askViaAgents($: EngineInterface, rt: Runtime, control: PreparationControl): AskFn {
  const builder = askViaAgent($, rt, "builder", control);
  const verifier = askViaAgent($, rt, "verifier", control);
  return (request) => (request.role === "builder" ? builder(request) : verifier(request));
}

/**
 * One preparation with Pi on its configured roles and Claude agents on
 * the rest. Each Pi role reads the snapshot through the worker's tools;
 * a Claude role reads the evidence file.
 */
async function prepareWithPi($: EngineInterface, rt: Runtime, snapshot: EvidenceArchive, control: PreparationControl) {
  const dir = control.directory;
  const evidencePath = `${dir}/pi-evidence.json`;
  await writePiEvidence($, evidencePath, snapshot);
  const pi = askViaPi($, rt.config, { evidencePath, dataDir: dir, control }, rt.piStats);
  const claudeRoles = roleBackend(rt.config, "builder") === "claude" || roleBackend(rt.config, "verifier") === "claude";
  const claudeAccess = claudeRoles ? await evidenceAccess($, rt, snapshot, control) : "";
  const agents = askViaAgents($, rt, control);
  const ask: AskFn = (request) =>
    roleBackend(rt.config, request.role) === "pi" ? pi(request) : agents(request);
  const access = {
    builder: roleBackend(rt.config, "builder") === "pi" ? PI_EVIDENCE_ACCESS : claudeAccess,
    verifier: roleBackend(rt.config, "verifier") === "pi" ? PI_EVIDENCE_ACCESS : claudeAccess,
  };
  return prepareCheckpoint(controlledAsk($, control, ask), snapshot, access, {
    builder: rt.config.builderModel,
    verifier: rt.config.verifierModel,
  }, coverage => { noteDraft($, rt, control, coverage); });
}

/** Claude-only preparation: private agents, then inline `model.complete`. */
async function prepareWithClaude(
  $: EngineInterface,
  rt: Runtime,
  snapshot: EvidenceArchive,
  notes: string[],
  control: PreparationControl,
): Promise<{ prepared: Awaited<ReturnType<typeof prepareCheckpoint>>; backend: string }> {
  const models = { builder: rt.config.builderModel, verifier: rt.config.verifierModel };
  // Side agents read the paged evidence file; when agents are
  // unavailable the whole pipeline retries on inline evidence.
  control.remaining(await $.clock.now());
  const access = await evidenceAccess($, rt, snapshot, control);
  try {
    return { prepared: await prepareCheckpoint(controlledAsk($, control, askViaAgents($, rt, control)), snapshot, access, models, coverage => { noteDraft($, rt, control, coverage); }), backend: "claude-agents" };
  } catch (error) {
    if (error instanceof PreparationCancelled) throw error;
    notes.push(`agents:${oneLine(error)}`);
    rt.lastFallback = notes.join(" then ");
  }
  return {
    prepared: await prepareCheckpoint(controlledAsk($, control, askViaComplete($)), snapshot, inlineEvidence(snapshot), models, coverage => { noteDraft($, rt, control, coverage); }),
    backend: "claude-complete",
  };
}

/** The prompt already carries the inline snapshot evidence as its access text. */
function askViaComplete($: EngineInterface): AskFn {
  return async (request) =>
    $.model.complete({
      model: request.model === "inherit" ? "haiku" : request.model,
      system: request.system,
      prompt: request.prompt,
      maxTokens: 16_000,
    });
}

function oneLine(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.slice(0, 160).replace(/\s+/g, " ");
}

async function runPreparation($: EngineInterface, rt: Runtime, manual: boolean): Promise<void> {
  const rows = rt.archive;
  if (!rows || rt.state.preparing) return;
  if (!manual && !rt.state.refreshArmed) return;
  if (rows.size < 2) return;
  const generation = rt.state.startPreparing();
  if (generation === undefined) return;
  // Rows appended mid-preparation (agent hand-backs, new turns) stay out.
  const snapshot = rows.snapshot(rows.size - 1);
  const started = performance.now();
  const notes: string[] = [];
  const coverage = snapshot.rows.findLast(row => rt.transcript.knownIds.has(row.id))?.id;
  if (!coverage) { rt.state.fail(generation); return; }
  const directory = `${dataDir($, rt)}/prepare-${rt.runtimeId}-${generation}`;
  const control = new PreparationControl(generation, directory,
    (await $.clock.now()) + rt.config.prepareTimeoutSeconds * 1000, coverage);
  rt.preparation = control;
  try {
    $.clock.after(rt.config.prepareTimeoutSeconds * 1000, () => {
      if (rt.preparation === control && !control.finished) void stopPreparation($, rt, "preparation deadline reached");
    });
    await trace($, rt, "prepare-start", { generation, directory, rows: snapshot.size, coverage, deadline: control.deadline });
    let prepared: Awaited<ReturnType<typeof prepareCheckpoint>> | undefined;
    let backend = "";
    if (usesPi(rt.config)) {
      if (rt.piStatus.startsWith("failed")) {
        notes.push(`pi-unavailable:${rt.piStatus.slice("failed:".length)}`);
      } else {
        try {
          prepared = await control.race(prepareWithPi($, rt, snapshot, control));
          backend = rt.config.builderBackend === rt.config.verifierBackend ? "pi" : "mixed";
        } catch (error) {
          if (error instanceof PreparationCancelled) throw error;
          // Any Pi-involving failure redoes the whole preparation on Claude.
          if (error instanceof PiWorkerUnavailable) rt.piStatus = `failed:${oneLine(error)}`;
          notes.push(`pi:${oneLine(error)}`);
        }
      }
      if (notes.length > 0) rt.lastFallback = notes.join(" then ");
    }
    if (!prepared) ({ prepared, backend } = await control.race(prepareWithClaude($, rt, snapshot, notes, control)));
    control.remaining(await $.clock.now());
    rt.lastPrepare = `${backend} ${Math.round(performance.now() - started)}ms`;
    const checkpoint: PublishedCheckpoint = {
      checkpointId: `shadow-${generation}-${prepared.coverageEndEntryId}`,
      rendered: prepared.rendered,
      coverageEndEntryId: prepared.coverageEndEntryId,
    };
    // A compaction that ran meanwhile may have removed the covered row:
    // such a checkpoint could never install, so it is never published.
    if (!rt.messageRowIds.includes(checkpoint.coverageEndEntryId)) {
      if (rt.state.discardStale(generation)) {
        notes.push(`stale:coverage ${checkpoint.coverageEndEntryId} compacted away`);
        rt.lastFallback = notes.join(" then ");
        $.ui.log(`shadow-compact: discarded a checkpoint born stale (covers ${checkpoint.coverageEndEntryId})`, { to: "debug" });
      }
    } else if (rt.state.publish(generation, checkpoint)) {
      control.finished = true;
      rows.setPreviousCheckpoint(checkpoint.rendered, checkpoint.coverageEndEntryId);
      $.ui.log(
        `shadow-compact: verified checkpoint ready (covers ${prepared.coverageEndEntryId}); it installs at the next /compact or auto-compaction`,
      );
      await $.fs.write(`${directory}/checkpoint.json`, JSON.stringify(checkpoint)).catch(() => undefined);
      await trace($, rt, "prepare-ready", { generation, coverage: checkpoint.coverageEndEntryId, backend, durationMs: Math.round(performance.now() - started) });
    }
  } catch (error) {
    if (error instanceof PreparationCancelled) await stopPreparation($, rt, control.reason ?? oneLine(error));
    if (error instanceof PreparationCancelled && control.reason?.startsWith("stale:")) rt.state.discardStale(generation);
    else rt.state.fail(generation);
    notes.push(`failed:${oneLine(error)}`);
    rt.lastFallback = notes.join(" then ");
    rt.lastPrepare = `failed ${Math.round(performance.now() - started)}ms`;
    $.ui.log(`shadow-compact: preparation failed (${oneLine(error)})`, { to: "debug" });
    await trace($, rt, "prepare-failed", { generation, reason: oneLine(error) });
  } finally {
    control.finished = true;
    if (rt.preparation === control) rt.preparation = undefined;
    await $.fs.write(`${directory}/outcome.json`, JSON.stringify({ generation, durationMs: Math.round(performance.now() - started), fallback: notes, cancelled: control.reason }))
      .catch(() => undefined);
  }
}

type InstallPlan =
  | { messages: SessionMessage[]; tailStart: number; checkpointId: string }
  | { reason: string };

/**
 * Plans installing the serving checkpoint over the live compaction's
 * transcript. Coverage is proven only by the covered row's uuid in the
 * live index; a checkpoint whose row is gone is discarded.
 */
function planInstall(rt: Runtime, messages: readonly SessionMessage[]): InstallPlan {
  const published = rt.state.published;
  if (!published) return { reason: "no-checkpoint" };
  // Rebuild from this compact input, never from the append stream's shape.
  rt.messageRowIds = rt.transcript.resolve(messages);
  const coveredIndex = rt.messageRowIds.indexOf(published.coverageEndEntryId);
  if (coveredIndex < 0) {
    rt.state.discardPublished();
    return { reason: "coverage-unproven" };
  }
  if (rt.messageRowIds.lastIndexOf(published.coverageEndEntryId) !== coveredIndex) return { reason: "coverage-ambiguous" };
  const built = buildCandidate(messages, coveredIndex, rt.config.recentTurns, published.rendered);
  if (isSkipped(built) || !built.messages) {
    return { reason: isSkipped(built) ? built.skipped : "no-candidate" };
  }
  if (rt.messageRowIds.slice(0, built.tailStart).some(id => id.startsWith("unknown-"))) {
    return { reason: "history-unproven" };
  }
  return { messages: built.messages, tailStart: built.tailStart, checkpointId: published.checkpointId };
}

/** Host commands that sleep one poll; the first that works is kept. */
function pauseCommands(rt: Runtime): string[][] {
  return [
    ["sleep", String(COMPACT_POLL_SECONDS)],
    [rt.config.piNodePath, "-e", `setTimeout(() => {}, ${COMPACT_POLL_SECONDS * 1000})`],
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
  const commands = pauseCommands(rt);
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

type WaitOutcome = "done" | "timeout" | "interrupted" | "budget" | "no-pause";

/**
 * Holds a live compaction while a preparation runs, up to the configured
 * wait. Preparation keeps running in its own dispatches (agent answers
 * arrive through `turn.complete`, Pi through its own process); this only
 * watches for it to settle.
 */
async function waitForPreparation(
  $: EngineInterface,
  rt: Runtime,
  next: { signal?: AbortSignal; budget?: { remainingMs: number } },
): Promise<WaitOutcome> {
  const deadline = (await $.clock.now()) + rt.config.compactWaitSeconds * 1000;
  while (rt.state.preparing) {
    if (next.signal?.aborted) return "interrupted";
    if (next.budget && next.budget.remainingMs < COMPACT_BUDGET_RESERVE_MS) return "budget";
    if ((await $.clock.now()) >= deadline) return "timeout";
    if (!(await hostPause($, rt))) return "no-pause";
  }
  return "done";
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
    const decisions: Record<string, string> =
      typeof stored === "object" && stored !== null ? { ...(stored as Record<string, string>) } : {};
    const model = breakdown.model;
    const decision = decideAutoCompactWindow(rt.config, {
      model,
      modelWindow: usage.context.window,
      source: breakdown.autocompactSource,
      settings: await $.settings.read(),
      decidedBefore: model in decisions,
    });
    const effective = `${breakdown.rawMaxTokens} (${breakdown.autocompactSource})`;
    if (!decision.apply) {
      rt.autoCompactWindow = `${decision.reason} ${effective}`;
      if (decision.final && !(model in decisions)) {
        await $.store.set(WINDOW_DECISIONS_KEY, { ...decisions, [model]: decision.reason });
      }
      return;
    }
    const requested = rt.config.autoCompactWindowTokens;
    await $.command.run({ command: "autocompact", args: String(requested) });
    const after = (await $.session.usage({ breakdown: "summary" })).context.breakdown;
    if (after?.autocompactSource !== "settings" || after.rawMaxTokens !== requested) {
      rt.autoCompactWindow = `unconfirmed requested=${requested} effective=${after ? `${after.rawMaxTokens} (${after.autocompactSource})` : "unknown"}`;
      return;
    }
    await $.store.set(WINDOW_DECISIONS_KEY, { ...decisions, [model]: `applied:${requested}` });
    rt.autoCompactWindow = `applied ${requested} (settings)`;
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
    const decision = decideIdleCompaction(rt.config, {
      envValue: await $.env.get("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS"),
      settings: await $.settings.read(),
    });
    if (!decision.apply) {
      rt.idleCompact = decision.reason;
      return;
    }
    const floor = rt.config.idleCompactMinTokens;
    await $.env.set("CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS", String(floor));
    rt.idleCompact = `applied ${floor} (env)`;
  } catch (error) {
    rt.idleCompact = `failed:${oneLine(error)}`;
    $.ui.log(`shadow-compact: idle compaction floor not configured (${oneLine(error)})`, { to: "debug" });
  }
}

async function startPiCheck($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    rt.piStatus = await checkPi($, rt.config);
  } catch (error) {
    rt.piStatus = `failed:${oneLine(error)}`;
  }
  if (rt.piStatus !== "ok") {
    $.ui.log(`shadow-compact: Pi backend unavailable, using Claude models (${rt.piStatus})`);
  }
}

function statusText(rt: Runtime): string {
  const published = rt.state.published;
  return [
    `shadow-compact: v${PLUGIN_VERSION} phase=${rt.state.phase}`,
    `archive rows=${rt.archive?.size ?? 0}`,
    published
      ? `checkpoint=${published.checkpointId} coverage=${published.coverageEndEntryId}`
      : "checkpoint=none",
    `installs=${rt.state.installCount}`,
    `prepare=${rt.config.prepareThresholdTokens} tokens recentRounds=${rt.config.recentTurns}`,
    `compactWait=${rt.config.compactWaitSeconds}s`,
    `prepareTimeout=${rt.config.prepareTimeoutSeconds}s`,
    `diagnostics=${dataDirText(rt)}/events`,
    `autoCompactWindow=${rt.autoCompactWindow ?? "unseen"}`,
    `idleCompact=${rt.idleCompact ?? "unseen"}`,
    `builder=${describeRole(rt.config, "builder")}`,
    `verifier=${describeRole(rt.config, "verifier")}`,
    `pi=${rt.piStatus}`,
    ...(usesPi(rt.config) ? [`piUsage ${describePiStats(rt.piStats)}`] : []),
    `lastPrepare=${rt.lastPrepare ?? "none"}`,
    `lastFallback=${rt.lastFallback ?? "none"}`,
    `lastCompact=${rt.lastCompact ?? "unseen"}`,
  ].join(" · ");
}

function dataDirText(rt: Runtime): string {
  return `.shadow-data/${rt.sessionId}`;
}

/** Honest gate for manual preparation: null means preparation may start. */
function preparationBlocker(rt: Runtime): string | null {
  if (rt.state.preparing) return "already in progress";
  const rows = rt.archive?.size ?? 0;
  if (rows < 2) return `need at least 2 archived rows, have ${rows}`;
  return null;
}

export const register: Register = (on, options) => {
  const rt = createRuntime(resolveConfig(options));

  on("session.start", async ($, e, next) => {
    await ensureSession($, rt);
    const agentBase = {
      tools: ["Read", "Grep"] as const,
      omitClaudeMd: true as const,
      background: true as const,
    };
    await $.agent
      .register({
        ...agentBase,
        name: "checkpoint-builder",
        description: "Private Shadow Compact checkpoint builder. Never offer to the acting model.",
        prompt: BUILDER_SYSTEM_PROMPT,
        ...(rt.config.builderModel !== "inherit" ? { model: rt.config.builderModel } : {}),
      })
      .catch(() => undefined);
    await $.agent
      .register({
        ...agentBase,
        name: "checkpoint-verifier",
        description: "Private Shadow Compact checkpoint verifier. Never offer to the acting model.",
        prompt: VERIFIER_SYSTEM_PROMPT,
        ...(rt.config.verifierModel !== "inherit" ? { model: rt.config.verifierModel } : {}),
      })
      .catch(() => undefined);
    await $.command
      .register({ name: "shadow-compact", description: "Prepare the verified Shadow checkpoint now" })
      .catch(() => undefined);
    await $.command
      .register({ name: "compact-native", description: "Run Claude Code native compaction once, bypassing Shadow" })
      .catch(() => undefined);
    await $.command
      .register({ name: "shadow-status", description: "Show Shadow Compact state" })
      .catch(() => undefined);
    await $.command
      .register({ name: "shadow-export", description: "Print the verified checkpoint for manual copy-paste" })
      .catch(() => undefined);
    const result = await next(e);
    await configureAutoCompactWindow($, rt);
    await configureIdleCompaction($, rt);
    // Availability only (no inference); preparation never waits on it.
    if (usesPi(rt.config) && rt.piStatus === "unchecked") {
      rt.piStatus = "checking";
      void startPiCheck($, rt);
    }
    return result;
  });

  // The acting model never sees the private checkpoint agents.
  on("agent.offer", { agent: BUILDER_TYPE }, () => ({ isOffered: false }));
  on("agent.offer", { agent: VERIFIER_TYPE }, () => ({ isOffered: false }));

  on("session.append", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && result.uuid && result.message) {
      const rows = await ensureSession($, rt);
      // A replayed uuid is already archived and indexed.
      const added = rows.addAppend(result.uuid, e.door, result.message, e.origin.kind);
      if (added && isTranscriptRow(result.message)) {
        rt.transcript.knownIds.add(result.uuid);
        const isCheckpointRow =
          rt.awaitingCompactionRow && rows.rows[rows.size - 1]!.text.startsWith(CHECKPOINT_HEADING);
        if (e.door === "compaction" || isCheckpointRow) {
          if (noteCompactionRow(rt, result.uuid)) await stopPreparation($, rt, "stale:unobserved compaction replaced history");
        }
        else rt.messageRowIds.push(result.uuid);
      }
    }
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId) {
      rt.pendingAnswers.get(e.agentId)?.(e.answer);
      rt.pendingAnswers.delete(e.agentId);
      return next(e);
    }
    // A finished main turn may be the last before idle compaction:
    // prepare now so the checkpoint is ready long before it fires.
    const tokens = rt.lastTokens;
    if (
      rt.config.configureIdleCompaction &&
      tokens !== null &&
      tokens >= rt.config.idleCompactMinTokens &&
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
      unknownHandles: rt.messageRowIds.filter(id => id.startsWith("unknown-")).length,
      checkpoint: rt.state.published?.checkpointId ?? null, preparing: rt.state.preparing,
    });
    if (rt.preparation && !rt.messageRowIds.includes(rt.preparation.coverageEndEntryId)) {
      await stopPreparation($, rt, `stale:coverage ${rt.preparation.coverageEndEntryId} no longer live`);
    }
    if (rt.state.attemptedCheckpointId) {
      rt.state.rejectInstall();
      rt.lastFallback = "install-unconfirmed";
    }
    let waited = "";
    let firstReason: string | undefined;
    const native = async (reason: string) => {
      const why = firstReason && firstReason !== reason ? `${firstReason}${waited} then:${reason}` : `${reason}${waited}`;
      rt.lastCompact = `trigger=${e.trigger} native:${why}`;
      $.ui.log(`shadow-compact: ${rt.lastCompact}`);
      await trace($, rt, "compact-native", { decision: rt.lastCompact });
      return compactNatively($, rt, e.messages, () => next(e));
    };
    if (rt.config.manualCompactMode === "native" && e.trigger === "manual") return native("manual-mode");
    let plan = planInstall(rt, e.messages);
    // Checkpoint-first: a checkpoint still preparing is not a failed one.
    // Hold this compaction for it (or for one just-in-time attempt when
    // none is running) instead of letting native win the race.
    if ("reason" in plan && plan.reason !== "history-unproven" && plan.reason !== "coverage-ambiguous" && rt.config.compactWaitSeconds > 0) {
      firstReason = plan.reason;
      if (!rt.state.preparing) void runPreparation($, rt, false);
      if (rt.state.preparing) {
        const started = await $.clock.now();
        await trace($, rt, "compact-wait-start", { trigger: e.trigger, reason: firstReason, seconds: rt.config.compactWaitSeconds });
        const outcome = await waitForPreparation($, rt, next);
        waited = ` waited=${Math.round(((await $.clock.now()) - started) / 1000)}s:${outcome}`;
        await trace($, rt, "compact-wait-end", { outcome, waited });
        if (outcome === "interrupted") {
          rt.lastCompact = `trigger=${e.trigger} interrupted${waited}`;
          return { skip: "Shadow Compact: compaction interrupted while its checkpoint prepared" };
        }
        plan = planInstall(rt, e.messages);
      }
    }
    if ("reason" in plan) return native(plan.reason);
    rt.state.attemptInstall();
    rt.awaitingCompactionRow = true;
    const checkpointRow = `checkpoint-${crypto.randomUUID()}`;
    rt.archive?.addSessionMessage(checkpointRow, plan.messages[0]!);
    rt.messageRowIds = [checkpointRow, ...rt.messageRowIds.slice(plan.tailStart)];
    rt.transcript.remember(plan.messages, rt.messageRowIds);
    rt.lastCompact = `trigger=${e.trigger} shadow:${plan.checkpointId} tailStart=${plan.tailStart}${waited}`;
    $.ui.log(`shadow-compact: ${rt.lastCompact}`, { to: "debug" });
    await trace($, rt, "compact-shadow", { decision: rt.lastCompact, messages: plan.messages.length });
    return { messages: plan.messages };
  });

  on("command.run", { command: "shadow-status" }, async ($, _e, _next) => {
    await ensureSession($, rt);
    await confirmInstall($, rt);
    return { text: statusText(rt) };
  });

  on("command.run", { command: "shadow-compact" }, async ($, _e, _next) => {
    await ensureSession($, rt);
    const published = rt.state.published;
    if (published && rt.state.installedCheckpointId !== published.checkpointId) {
      return { text: "shadow-compact: verified checkpoint ready; run /compact to install it." };
    }
    const blocker = preparationBlocker(rt);
    if (blocker) {
      return { text: `shadow-compact: idle (${blocker}; archive rows=${rt.archive?.size ?? 0}).` };
    }
    void runPreparation($, rt, true);
    return {
      text: `shadow-compact: background builder/verifier preparation started (archive rows=${rt.archive?.size ?? 0}); it installs at the next /compact or auto-compaction.`,
    };
  });

  on("command.run", { command: "shadow-export" }, async ($, _e, _next) => {
    await ensureSession($, rt);
    const published = rt.state.published;
    if (!published) {
      return { text: "shadow-compact: no verified checkpoint to export yet." };
    }
    return { text: published.rendered };
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
    rt.archive = undefined;
    rt.messageRowIds = [];
    rt.transcript = new LiveTranscript();
    rt.bootstrapped = false;
    rt.awaitingCompactionRow = false;
    rt.lastFallback = null;
    rt.lastCompact = null;
    rt.autoCompactWindow = null;
    rt.idleCompact = null;
    rt.lastTokens = null;
    rt.idleCheckpoint = false;
    rt.piStatus = usesPi(rt.config) ? "unchecked" : "off";
    rt.piStats = emptyPiStats();
    rt.lastPrepare = null;
    rt.pauseCommand = null;
    return result;
  });
};

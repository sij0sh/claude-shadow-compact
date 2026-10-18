/**
 * Claude Code adapter for Shadow Compact (spec §4–§8). The Pi-facing
 * lifecycle is replaced by mod hooks:
 * - `session.append` mirrors every main-loop row into the evidence archive
 * - `session.measure` starts background preparation at the prepare threshold
 * - private builder/verifier agents (hidden via `agent.offer`) produce a
 *   verified checkpoint; strict-JSON answers are validated in `prepare.ts`
 * - `session.compact` installs checkpoint + exact handle tail, or defers
 *   to native compaction (`next(e)`) whenever coverage cannot be proven
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

const BUILDER_TYPE = "shadow-compact:checkpoint-builder";
const VERIFIER_TYPE = "shadow-compact:checkpoint-verifier";
const AGENT_TIMEOUT_MS = 600_000;

/** Running plugin version shown in status; bump with the manifest. */
const PLUGIN_VERSION = "0.4.4";

/** Inline evidence cap for the model.complete fallback. */
const INLINE_EVIDENCE_CHARS = 120_000;

/** Store key: model id -> what Shadow decided for its auto-compact window. */
const WINDOW_DECISIONS_KEY = "autoCompactWindowDecisions";

/** Index slot for a compaction's summary row until its append names it. */
const SUMMARY_PLACEHOLDER = "compaction-summary";

interface Runtime {
  config: ShadowConfig;
  state: ShadowState;
  sessionId: string;
  cwd: string;
  archive: EvidenceArchive | undefined;
  /** Transcript message order as archive row ids; `unknown-N` marks a
   * message no append named, so coverage on it can never be proven. */
  messageRowIds: string[];
  bootstrapped: boolean;
  pendingAnswers: Map<string, (answer: string) => void>;
  /** A compaction this mod saw is waiting for its summary row's append. */
  awaitingCompactionRow: boolean;
  lastCompactionRowId: string | null;
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
}

function createRuntime(config: ShadowConfig): Runtime {
  return {
    config,
    state: new ShadowState(),
    sessionId: "unknown",
    cwd: "",
    archive: undefined,
    messageRowIds: [],
    bootstrapped: false,
    pendingAnswers: new Map(),
    awaitingCompactionRow: false,
    lastCompactionRowId: null,
    lastFallback: null,
    lastCompact: null,
    autoCompactWindow: null,
    idleCompact: null,
    lastTokens: null,
    idleCheckpoint: false,
    piStatus: usesPi(config) ? "unchecked" : "off",
    piStats: emptyPiStats(),
    lastPrepare: null,
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
    }
  }
  return rt.archive;
}

/** A compaction row arrived: name the summary slot, or drop an index a
 * compaction this mod never saw has invalidated. */
function noteCompactionRow(rt: Runtime, uuid: string): void {
  rt.lastCompactionRowId = uuid;
  if (rt.awaitingCompactionRow) {
    rt.awaitingCompactionRow = false;
    rt.messageRowIds[0] = uuid;
    return;
  }
  rt.messageRowIds = [uuid];
  rt.state.discardPublished();
}

/**
 * Runs a native compaction and rebuilds the index for its result:
 * messages kept by handle keep their row ids, the summary (first,
 * handle-less) takes the compaction row once its append names it.
 */
async function compactNatively(
  rt: Runtime,
  before: readonly SessionMessage[],
  run: () => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> {
  const byHandle = new Map<string, string>();
  if (before.length === rt.messageRowIds.length) {
    before.forEach((message, index) => {
      if (message.handle) byHandle.set(message.handle, rt.messageRowIds[index]!);
    });
  }
  rt.awaitingCompactionRow = true;
  const summaryRowBefore = rt.lastCompactionRowId;
  const result = await run().catch((error: unknown) => {
    rt.awaitingCompactionRow = false;
    throw error;
  });
  if (!result.messages) {
    rt.awaitingCompactionRow = false;
    return result;
  }
  // The summary row may already have appended while core compacted.
  let summary = SUMMARY_PLACEHOLDER;
  if (rt.lastCompactionRowId !== summaryRowBefore) {
    summary = rt.lastCompactionRowId!;
    rt.awaitingCompactionRow = false;
  }
  rt.messageRowIds = result.messages.map(
    (message, index) =>
      (message.handle && byHandle.get(message.handle)) ||
      (index === 0 ? summary : `unknown-${index}`),
  );
  // Native summarized what the checkpoint covered: prepare afresh.
  rt.state.discardPublished();
  rt.state.rearm();
  return result;
}

/** Confirms an attempted install against canonical history. */
async function confirmInstall($: EngineInterface, rt: Runtime): Promise<void> {
  const published = rt.state.published;
  if (!rt.state.attemptedCheckpointId || !published) return;
  const first = (await $.session.messages().catch(() => [] as SessionMessage[]))[0];
  if (
    first?.text.startsWith(CHECKPOINT_HEADING) &&
    first.text.includes(coverageLine(published.coverageEndEntryId))
  ) {
    rt.state.confirmInstall();
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
): Promise<string> {
  const path = `${dataDir($, rt)}/evidence.jsonl`;
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
  return `Session evidence (sanitized JSONL rows; cite evidenceId, name coverage by entryId):\n${rows.fullText().slice(0, INLINE_EVIDENCE_CHARS)}${previousText}`;
}

function askViaAgent($: EngineInterface, rt: Runtime, kind: "builder" | "verifier"): AskFn {
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
    const answer = new Promise<string>((resolve) => {
      rt.pendingAnswers.set(agentId, resolve);
    });
    const timeout = $.clock.sleep(AGENT_TIMEOUT_MS).then(() => {
      if (rt.pendingAnswers.delete(agentId)) throw new Error(`${kind} agent timed out`);
      return "";
    });
    try {
      return await Promise.race([answer, timeout]);
    } finally {
      rt.pendingAnswers.delete(agentId);
    }
  };
}

/** One AskFn routing each role to its private agent type. */
function askViaAgents($: EngineInterface, rt: Runtime): AskFn {
  const builder = askViaAgent($, rt, "builder");
  const verifier = askViaAgent($, rt, "verifier");
  return (request) => (request.role === "builder" ? builder(request) : verifier(request));
}

/**
 * One preparation with Pi on its configured roles and Claude agents on
 * the rest. Each Pi role reads the snapshot through the worker's tools;
 * a Claude role reads the evidence file.
 */
async function prepareWithPi($: EngineInterface, rt: Runtime, snapshot: EvidenceArchive) {
  const dir = dataDir($, rt);
  const evidencePath = `${dir}/pi-evidence.json`;
  await writePiEvidence($, evidencePath, snapshot);
  const pi = askViaPi($, rt.config, { evidencePath, dataDir: dir }, rt.piStats);
  const claudeRoles = roleBackend(rt.config, "builder") === "claude" || roleBackend(rt.config, "verifier") === "claude";
  const claudeAccess = claudeRoles ? await evidenceAccess($, rt, snapshot) : "";
  const agents = askViaAgents($, rt);
  const ask: AskFn = (request) =>
    roleBackend(rt.config, request.role) === "pi" ? pi(request) : agents(request);
  const access = {
    builder: roleBackend(rt.config, "builder") === "pi" ? PI_EVIDENCE_ACCESS : claudeAccess,
    verifier: roleBackend(rt.config, "verifier") === "pi" ? PI_EVIDENCE_ACCESS : claudeAccess,
  };
  return prepareCheckpoint(ask, snapshot, access, {
    builder: rt.config.builderModel,
    verifier: rt.config.verifierModel,
  });
}

/** Claude-only preparation: private agents, then inline `model.complete`. */
async function prepareWithClaude(
  $: EngineInterface,
  rt: Runtime,
  snapshot: EvidenceArchive,
  notes: string[],
): Promise<{ prepared: Awaited<ReturnType<typeof prepareCheckpoint>>; backend: string }> {
  const models = { builder: rt.config.builderModel, verifier: rt.config.verifierModel };
  // Side agents read the paged evidence file; when agents are
  // unavailable the whole pipeline retries on inline evidence.
  const access = await evidenceAccess($, rt, snapshot);
  try {
    return { prepared: await prepareCheckpoint(askViaAgents($, rt), snapshot, access, models), backend: "claude-agents" };
  } catch (error) {
    notes.push(`agents:${oneLine(error)}`);
    rt.lastFallback = notes.join(" then ");
  }
  return {
    prepared: await prepareCheckpoint(askViaComplete($), snapshot, inlineEvidence(snapshot), models),
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
  try {
    let prepared: Awaited<ReturnType<typeof prepareCheckpoint>> | undefined;
    let backend = "";
    if (usesPi(rt.config)) {
      if (rt.piStatus.startsWith("failed")) {
        notes.push(`pi-unavailable:${rt.piStatus.slice("failed:".length)}`);
      } else {
        try {
          prepared = await prepareWithPi($, rt, snapshot);
          backend = rt.config.builderBackend === rt.config.verifierBackend ? "pi" : "mixed";
        } catch (error) {
          // Any Pi-involving failure redoes the whole preparation on Claude.
          if (error instanceof PiWorkerUnavailable) rt.piStatus = `failed:${oneLine(error)}`;
          notes.push(`pi:${oneLine(error)}`);
        }
      }
      if (notes.length > 0) rt.lastFallback = notes.join(" then ");
    }
    if (!prepared) ({ prepared, backend } = await prepareWithClaude($, rt, snapshot, notes));
    rt.lastPrepare = `${backend} ${Math.round(performance.now() - started)}ms`;
    const checkpoint: PublishedCheckpoint = {
      checkpointId: `shadow-${generation}-${prepared.coverageEndEntryId}`,
      rendered: prepared.rendered,
      coverageEndEntryId: prepared.coverageEndEntryId,
    };
    if (rt.state.publish(generation, checkpoint)) {
      rows.setPreviousCheckpoint(checkpoint.rendered, checkpoint.coverageEndEntryId);
      $.ui.log(
        `shadow-compact: verified checkpoint ready (covers ${prepared.coverageEndEntryId}); it installs at the next /compact or auto-compaction`,
      );
    }
  } catch (error) {
    rt.state.fail(generation);
    notes.push(`failed:${oneLine(error)}`);
    rt.lastFallback = notes.join(" then ");
    rt.lastPrepare = `failed ${Math.round(performance.now() - started)}ms`;
    $.ui.log(`shadow-compact: preparation failed (${oneLine(error)})`, { to: "debug" });
  }
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
    `prepare=${rt.config.prepareThresholdTokens} tokens recentTurns=${rt.config.recentTurns}`,
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
      if (added && result.message.role) {
        const isCheckpointRow =
          rt.awaitingCompactionRow && rows.rows[rows.size - 1]!.text.startsWith(CHECKPOINT_HEADING);
        if (e.door === "compaction" || isCheckpointRow) noteCompactionRow(rt, result.uuid);
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
    if (rt.state.attemptedCheckpointId) {
      rt.state.rejectInstall();
      rt.lastFallback = "install-unconfirmed";
    }
    const native = (reason: string) => {
      rt.lastCompact = `trigger=${e.trigger} native:${reason}`;
      $.ui.log(`shadow-compact: ${rt.lastCompact}`, { to: "debug" });
      return compactNatively(rt, e.messages, () => next(e));
    };
    if (rt.config.manualCompactMode === "native" && e.trigger === "manual") return native("manual-mode");
    const published = rt.state.published;
    if (!published) return native("no-checkpoint");
    if (rt.messageRowIds.length !== e.messages.length) return native("index-misaligned");
    // Coverage is proven only by the covered row's uuid in the live index.
    const coveredIndex = rt.messageRowIds.indexOf(published.coverageEndEntryId);
    if (coveredIndex < 0) {
      rt.state.discardPublished();
      return native("coverage-unproven");
    }
    const built = buildCandidate(e.messages, coveredIndex, rt.config.recentTurns, published.rendered);
    if (isSkipped(built) || !built.messages) {
      return native(isSkipped(built) ? built.skipped : "no-candidate");
    }
    rt.state.attemptInstall();
    rt.awaitingCompactionRow = true;
    rt.messageRowIds = [SUMMARY_PLACEHOLDER, ...rt.messageRowIds.slice(built.tailStart)];
    rt.lastCompact = `trigger=${e.trigger} shadow:${published.checkpointId} tailStart=${built.tailStart}`;
    $.ui.log(`shadow-compact: ${rt.lastCompact}`, { to: "debug" });
    return { messages: built.messages };
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
      void compactNatively(rt, [], () => $.session.compact()).catch((error: unknown) => {
        $.ui.log(`shadow-compact: native compaction failed (${oneLine(error)})`);
      });
    });
    return { text: "shadow-compact: running Claude Code native compaction." };
  });

  on("session.end", async ($, e, next) => {
    const result = await next(e);
    rt.state.reset();
    rt.archive = undefined;
    rt.messageRowIds = [];
    rt.bootstrapped = false;
    rt.awaitingCompactionRow = false;
    rt.lastCompactionRowId = null;
    rt.lastFallback = null;
    rt.lastCompact = null;
    rt.autoCompactWindow = null;
    rt.idleCompact = null;
    rt.lastTokens = null;
    rt.idleCheckpoint = false;
    rt.piStatus = usesPi(rt.config) ? "unchecked" : "off";
    rt.piStats = emptyPiStats();
    rt.lastPrepare = null;
    return result;
  });
};

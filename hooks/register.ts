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
 * Deferred from the Pi version (spec §10): request-local mid-turn swaps
 * (Claude pins the transcript in `turn.step`) and native-summarizer
 * token-cap recovery (no stable signal in the compact result).
 *
 * Helpers are top-level functions taking `$` explicitly: the engine's
 * validator statically follows `$` only into top-level or imported
 * functions, never into closures capturing it.
 */
import type { EngineInterface, Register, SessionMessage } from "claude-code";
import { currentPromptVersions } from "./checkpoint.js";
import {
  describeModel,
  isAtOrAbove,
  resolveConfig,
  type ShadowConfig,
} from "./config.js";
import { EvidenceArchive } from "./evidence.js";
import {
  BUILDER_SYSTEM_PROMPT,
  VERIFIER_SYSTEM_PROMPT,
  prepareCheckpoint,
  type AskFn,
} from "./prepare.js";
import { ShadowState, type PublishedCheckpoint } from "./state.js";
import { buildCandidate, isSkipped } from "./working-context.js";

const BUILDER_TYPE = "shadow-compact:checkpoint-builder";
const VERIFIER_TYPE = "shadow-compact:checkpoint-verifier";
const AGENT_TIMEOUT_MS = 600_000;

/** Running plugin version shown in status; bump with the manifest. */
const PLUGIN_VERSION = "0.3.0";

/** Max persisted transcript index entries; ids only, never text. */
const MAX_PERSISTED_INDEX = 2000;

/** Inline evidence cap for the model.complete fallback. */
const INLINE_EVIDENCE_CHARS = 120_000;

interface Runtime {
  config: ShadowConfig;
  state: ShadowState;
  sessionId: string;
  cwd: string;
  archive: EvidenceArchive | undefined;
  /** Transcript message order as archive row ids; `native-summary` and
   * `unknown-N` placeholders keep indexes honest across native compactions. */
  messageRowIds: string[];
  bootstrapped: boolean;
  pendingAnswers: Map<string, (answer: string) => void>;
  installScheduled: boolean;
  hardLimitReached: boolean;
  /** Last fallback reason class for status; memory only, never prompt text. */
  lastFallback: string | null;
  /** True once a main-loop session.compact dispatch has been observed. */
  compactHookSeen: boolean;
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
    installScheduled: false,
    hardLimitReached: false,
    lastFallback: null,
    compactHookSeen: false,
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
    await restore($, rt);
    try {
      const raw = await $.store.get(indexKey(rt.sessionId));
      if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
        const ids = raw as string[];
        // Only adopt a stored index when we have no live one yet; live
        // appends after reload win over the snapshot.
        if (rt.messageRowIds.length === 0 && ids.length > 0) {
          rt.messageRowIds = ids.slice(-MAX_PERSISTED_INDEX);
        }
      }
    } catch {
      // A broken index entry must never block the session.
    }
  }
  return rt.archive;
}

async function restore($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const raw = await $.store.get(`checkpoint:${rt.sessionId}`);
    if (!raw || typeof raw !== "object") return;
    const saved = raw as PublishedCheckpoint;
    if (saved.sessionId !== rt.sessionId || !saved.coverage || !saved.rendered) return;
    if (!rt.archive) return;
    if (rt.archive.indexOf(saved.coverage.coverageEndEntryId) < 0) {
      // After reload/resume the archive is rebuilt with synthetic
      // bootstrap ids, so the uuid can miss while the position still
      // matches. Keep the checkpoint when the saved index is in range;
      // session.compact re-anchors by position and otherwise fails closed.
      const at = saved.coverageMessageIndex;
      if (typeof at !== "number" || at < 0 || at >= rt.archive.size) {
        rt.state.rearm();
        return;
      }
    }
    rt.state.restorePublished(saved);
    rt.archive.setPreviousCheckpoint(saved.rendered, saved.coverage.coverageEndEntryId);
  } catch {
    // A broken store entry must never block the session.
  }
}

function indexKey(sessionId: string): string {
  return `shadow-index:${sessionId}`;
}

async function persistIndex($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const tail = rt.messageRowIds.slice(-MAX_PERSISTED_INDEX);
    await $.store.set(indexKey(rt.sessionId), tail);
  } catch {
    // Index persistence is best-effort; compaction still fails closed.
  }
}

/** Evidence access text for agents: read the paged archive file. */
async function evidenceAccess(
  $: EngineInterface,
  rt: Runtime,
  rows: EvidenceArchive,
): Promise<string> {
  const path = `${$.plugin.root}/.shadow-data/${rt.sessionId}/evidence.jsonl`;
  await $.fs.write(path, rows.fullText()).catch(() => undefined);
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

/** One AskFn routing builder/verifier systems to their agent types. */
function askViaAgents($: EngineInterface, rt: Runtime): AskFn {
  const builder = askViaAgent($, rt, "builder");
  const verifier = askViaAgent($, rt, "verifier");
  return (request) =>
    request.system.includes("create evidence-grounded") ? builder(request) : verifier(request);
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

/**
 * Installs at the next safe boundary by running the built-in /compact,
 * whose session.compact dispatch (engine-originated) this mod answers
 * with the verified checkpoint, or defers to native at the hard token limit.
 */
function scheduleInstall($: EngineInterface, rt: Runtime): void {
  if (rt.installScheduled) return;
  const published = rt.state.published;
  const ready = published && rt.state.installedCheckpointId !== published.checkpointId;
  if (!ready && !rt.hardLimitReached) return;
  rt.installScheduled = true;
  $.clock.after(50, () => {
    void (async () => {
      try {
        const current = rt.state.published;
        const ready = current && rt.state.installedCheckpointId !== current.checkpointId;
        if (!ready && !rt.hardLimitReached) return;
        await $.command.run({ command: "compact" });
      } catch {
        // A turn is running or the command is unavailable: the next
        // turn.complete / auto-compaction boundary retries.
      } finally {
        rt.installScheduled = false;
      }
    })();
  });
}

async function runPreparation($: EngineInterface, rt: Runtime, manual: boolean): Promise<void> {
  const rows = rt.archive;
  if (!rows || rt.state.preparing) return;
  if (!manual && !rt.state.refreshArmed) return;
  if (rows.size < 2) return;
  const preparing = rt.state.startPreparing();
  if (!preparing) return;
  const generation = preparing.generation;
  const snapshotLastIndex = rows.size - 1;
  const snapshotLeaf = rows.rows[snapshotLastIndex]!.id;
  // Rows appended mid-preparation (agent hand-backs, new turns) stay out.
  const snapshot = rows.snapshot(snapshotLastIndex);
  try {
    const models = { builder: rt.config.builderModel, verifier: rt.config.verifierModel };
    // Side agents read the paged evidence file; when agents are
    // unavailable the whole pipeline retries on inline evidence.
    const access = await evidenceAccess($, rt, snapshot);
    let prepared;
    try {
      prepared = await prepareCheckpoint(askViaAgents($, rt), snapshot, access, models);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      rt.lastFallback = `agents:${reason.slice(0, 160).replace(/\s+/g, " ")}`;
      prepared = await prepareCheckpoint(askViaComplete($), snapshot, inlineEvidence(snapshot), models);
    }
    if (rows.indexOf(prepared.coverageEndEntryId) > snapshotLastIndex) {
      throw new Error("Coverage boundary is past the inspected snapshot");
    }
    const checkpoint: PublishedCheckpoint = {
      checkpointId: `shadow-${generation}-${prepared.coverageEndEntryId}`,
      sessionId: rt.sessionId,
      structured: prepared.structured,
      rendered: prepared.rendered,
      coverage: {
        sourceStartEntryId: rows.rows[0]?.id ?? null,
        coverageEndEntryId: prepared.coverageEndEntryId,
        preparedAtLeafId: snapshotLeaf,
        publishedAtLeafId: rows.rows[rows.size - 1]?.id ?? snapshotLeaf,
      },
      generatedAt: Date.now(),
      prompts: currentPromptVersions(),
      coverageMessageIndex: rt.messageRowIds.indexOf(prepared.coverageEndEntryId),
    };
    if (rt.state.publish(generation, checkpoint)) {
      await $.store.set(`checkpoint:${rt.sessionId}`, checkpoint).catch(() => undefined);
      void persistIndex($, rt);
      rows.setPreviousCheckpoint(checkpoint.rendered, checkpoint.coverage.coverageEndEntryId);
      $.ui.log(`shadow-compact: verified checkpoint ready (covers ${prepared.coverageEndEntryId})`);
      scheduleInstall($, rt);
    }
  } catch (error) {
    rt.state.fail(generation);
    $.ui.log(
      `shadow-compact: preparation failed (${error instanceof Error ? error.message : String(error)})`,
      { to: "debug" },
    );
  }
}

function statusText(rt: Runtime): string {
  const published = rt.state.published;
  return [
    `shadow-compact: v${PLUGIN_VERSION} phase=${rt.state.phase}`,
    `archive rows=${rt.archive?.size ?? 0}`,
    published
      ? `checkpoint=${published.checkpointId} coverage=${published.coverage.coverageEndEntryId} installs=${rt.state.installCount}`
      : "checkpoint=none",
    `thresholds prepare=${rt.config.prepareThresholdTokens} tokens hard=${rt.config.hardThresholdTokens} tokens recentTurns=${rt.config.recentTurns}`,
    `builder=${describeModel(rt.config.builderModel)}`,
    `verifier=${describeModel(rt.config.verifierModel)}`,
    `lastFallback=${rt.lastFallback ?? "none"}`,
    `compact-hook=${rt.compactHookSeen ? "seen" : "unseen"}`,
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
      .register({ name: "shadow-compact", description: "Prepare or install the verified Shadow checkpoint" })
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
    return next(e);
  });

  // The acting model never sees the private checkpoint agents.
  on("agent.offer", { agent: BUILDER_TYPE }, () => ({ isOffered: false }));
  on("agent.offer", { agent: VERIFIER_TYPE }, () => ({ isOffered: false }));

  on("session.append", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && result.uuid && result.message) {
      const rows = await ensureSession($, rt);
      rows.addAppend(result.uuid, e.door, result.message, e.origin.kind);
      if (result.message.role) {
        if (e.door === "compaction") rt.messageRowIds = [result.uuid];
        else rt.messageRowIds.push(result.uuid);
        void persistIndex($, rt);
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
    await ensureSession($, rt);
    // Retry at a safe boundary for a ready checkpoint or the hard token limit.
    scheduleInstall($, rt);
    return next(e);
  });

  on("session.measure", async ($, e, next) => {
    await ensureSession($, rt);
    const tokens = e.context.tokens;
    if (typeof tokens === "number" && Number.isFinite(tokens)) {
      rt.hardLimitReached = isAtOrAbove(e.context, rt.config.hardThresholdTokens);
      if (
        rt.state.published &&
        rt.state.installedCheckpointId === rt.state.published.checkpointId &&
        tokens < rt.config.prepareThresholdTokens
      ) {
        rt.state.rearm();
      }
      if (isAtOrAbove(e.context, rt.config.prepareThresholdTokens) && !rt.state.preparing) {
        void runPreparation($, rt, false);
      }
      // Request our own compaction independently of Claude's auto threshold.
      // The command can fail during a turn; turn.complete retries it.
      if (rt.hardLimitReached) scheduleInstall($, rt);
    }
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    await ensureSession($, rt);
    if (!e.agentId) rt.compactHookSeen = true;
    // Native path helper: after any core compaction, realign the
    // transcript index with placeholders so later coverage math fails
    // closed or counts indexes honestly.
    const native = async () => {
      const result = await next(e);
      if (result.messages && !e.agentId && e.trigger !== "precompute") {
        rt.hardLimitReached = false;
        rt.state.rearm();
        rt.messageRowIds = result.messages.map((_, index) =>
          index === 0 ? "native-summary" : `unknown-${index}`,
        );
        void persistIndex($, rt);
      }
      return result;
    };
    if (e.agentId) return native();
    if (rt.state.consumeNativeBypass()) return native();
    if (rt.config.manualCompactMode === "native" && e.trigger === "manual") return native();
    const published = rt.state.published;
    if (!published) return native();
    if (rt.messageRowIds.length !== e.messages.length) return native();
    let coveredIndex = rt.messageRowIds.indexOf(published.coverage.coverageEndEntryId);
    if (coveredIndex < 0) {
      // Reload/resume rebuilds the archive with synthetic ids, so the
      // uuid can miss while the saved position still matches. Re-anchor
      // by position only when lengths agree and the index is in range.
      const at = published.coverageMessageIndex;
      if (typeof at !== "number" || at < 0 || at >= e.messages.length) {
        rt.state.discardPublished();
        return native();
      }
      coveredIndex = at;
    }
    const built = buildCandidate(e.messages, coveredIndex, rt.config.recentTurns, published.rendered);
    if (isSkipped(built) || !built.messages) return native();
    if (e.trigger !== "precompute") {
      rt.hardLimitReached = false;
      rt.state.markInstalled();
      rt.state.clearPendingNativeFallback();
      rt.messageRowIds = [
        `checkpoint:${published.checkpointId}`,
        ...rt.messageRowIds.slice(built.tailStart),
      ];
      rt.archive?.setPreviousCheckpoint(published.rendered, published.coverage.coverageEndEntryId);
      void persistIndex($, rt);
      $.ui.log("shadow-compact: installed verified checkpoint + exact recent tail");
    }
    return { messages: built.messages };
  });

  on("command.run", { command: "shadow-status" }, async ($, _e, _next) => {
    await ensureSession($, rt);
    return { text: statusText(rt) };
  });

  on("command.run", { command: "shadow-compact" }, async ($, _e, _next) => {
    await ensureSession($, rt);
    if (rt.state.published && rt.state.installedCheckpointId !== rt.state.published.checkpointId) {
      scheduleInstall($, rt);
      return { text: "shadow-compact: installing verified checkpoint at this boundary." };
    }
    const blocker = preparationBlocker(rt);
    if (blocker) {
      const rows = rt.archive?.size ?? 0;
      if (rt.state.preparing) {
        return { text: "shadow-compact: checkpoint preparation already in progress." };
      }
      return { text: `shadow-compact: idle (${blocker}; archive rows=${rows}).` };
    }
    void runPreparation($, rt, true);
    return {
      text: `shadow-compact: background builder/verifier preparation started (archive rows=${rt.archive?.size ?? 0}); it installs at the next safe compaction boundary.`,
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

  on("command.run", { command: "compact-native" }, async ($, _e, _next) => {
    await ensureSession($, rt);
    rt.state.armNativeBypass();
    $.clock.after(50, () => {
      void $.command.run({ command: "compact" }).catch(() => undefined);
    });
    return { text: "shadow-compact: next compaction will use Claude Code native compaction." };
  });

  on("session.end", async ($, e, next) => {
    const result = await next(e);
    rt.state.reset();
    rt.archive = undefined;
    rt.messageRowIds = [];
    rt.bootstrapped = false;
    rt.hardLimitReached = false;
    rt.lastFallback = null;
    return result;
  });
};



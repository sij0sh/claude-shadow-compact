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
import { isAtOrAbove, resolveConfig, type ShadowConfig } from "./config.js";
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
  }
  return rt.archive;
}

async function restore($: EngineInterface, rt: Runtime): Promise<void> {
  try {
    const raw = await $.store.get(`checkpoint:${rt.sessionId}`);
    if (!raw || typeof raw !== "object") return;
    const saved = raw as PublishedCheckpoint;
    if (saved.sessionId !== rt.sessionId || !saved.coverage || !saved.rendered) return;
    if (!rt.archive || rt.archive.indexOf(saved.coverage.coverageEndEntryId) < 0) {
      // Coverage row is not in this transcript (resumed after the
      // boundary was compacted away): fail closed, prepare fresh.
      rt.state.rearm();
      return;
    }
    rt.state.restorePublished(saved);
    rt.archive.setPreviousCheckpoint(saved.rendered, saved.coverage.coverageEndEntryId);
  } catch {
    // A broken store entry must never block the session.
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
  return `Session evidence (sanitized JSONL rows; cite evidenceId, name coverage by entryId):\n${rows.fullText().slice(0, 120_000)}${previousText}`;
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

function askViaComplete($: EngineInterface, rt: Runtime): AskFn {
  return async (request) => {
    if (!rt.archive) throw new Error("Evidence archive not ready");
    return $.model.complete({
      model: request.model === "inherit" ? "haiku" : request.model,
      system: request.system,
      prompt: `${request.prompt}\n\n${inlineEvidence(rt.archive)}`,
      maxTokens: 16_000,
    });
  };
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
  try {
    const access = await evidenceAccess($, rt, rows);
    const models = { builder: rt.config.builderModel, verifier: rt.config.verifierModel };
    let prepared;
    try {
      prepared = await prepareCheckpoint(askViaAgents($, rt), rows, access, models);
    } catch {
      prepared = await prepareCheckpoint(askViaComplete($, rt), rows, inlineEvidence(rows), models);
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
    `shadow-compact: phase=${rt.state.phase}`,
    `archive rows=${rt.archive?.size ?? 0}`,
    published
      ? `checkpoint=${published.checkpointId} coverage=${published.coverage.coverageEndEntryId} installs=${rt.state.installCount}`
      : "checkpoint=none",
    `thresholds prepare=${rt.config.prepareThresholdTokens} tokens hard=${rt.config.hardThresholdTokens} tokens recentTurns=${rt.config.recentTurns}`,
  ].join(" · ");
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
    return next(e);
  });

  // The acting model never sees the private checkpoint agents.
  on("agent.offer", { agent: BUILDER_TYPE }, () => ({ isOffered: false }));
  on("agent.offer", { agent: VERIFIER_TYPE }, () => ({ isOffered: false }));

  on("session.append", async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId && result.uuid && result.message) {
      const rows = await ensureSession($, rt);
      rows.addAppend(result.uuid, e.door, result.message);
      if (result.message.role) {
        if (e.door === "compaction") rt.messageRowIds = [result.uuid];
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
      }
      return result;
    };
    if (e.agentId) return native();
    if (rt.state.consumeNativeBypass()) return native();
    if (rt.config.manualCompactMode === "native" && e.trigger === "manual") return native();
    const published = rt.state.published;
    if (!published) return native();
    if (rt.messageRowIds.length !== e.messages.length) return native();
    const coveredIndex = rt.messageRowIds.indexOf(published.coverage.coverageEndEntryId);
    if (coveredIndex < 0) {
      rt.state.discardPublished();
      return native();
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
    if (rt.state.preparing) {
      return { text: "shadow-compact: checkpoint preparation already in progress." };
    }
    void runPreparation($, rt, true);
    return {
      text: "shadow-compact: background builder/verifier preparation started; it installs at the next safe compaction boundary.",
    };
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
    return result;
  });
};



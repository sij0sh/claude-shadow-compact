/**
 * Plugin-option configuration. The single source is the manifest's
 * `userConfig`, delivered to `register(on, options)` with defaults
 * already filled. Values are re-validated here because stored settings
 * can predate the manifest's options.
 */
import type { ContextWindowSource, PluginOptions, Settings } from "claude-code";
import { PI_THINKING_LEVELS, type CheckpointRole, type PiTarget, type PiThinkingLevel } from "./pi-protocol.js";

export const DEFAULT_PREPARE_THRESHOLD_TOKENS = 150_000;
/**
 * Claude Code auto-compact window Shadow sets once per model. The engine
 * reserves headroom below the window; the observed Opus trigger is around
 * 157–162k for a 190k window. The bounded wait supplies additional time.
 */
export const DEFAULT_AUTO_COMPACT_WINDOW_TOKENS = 190_000;
/**
 * Context floor Shadow gives Claude Code's idle compaction (which fires
 * shortly before the one-hour prompt cache expires). Claude Code's own
 * default is 200k and it refuses anything under 100k.
 */
export const DEFAULT_IDLE_COMPACT_MIN_TOKENS = 100_000;
export const MIN_IDLE_COMPACT_MIN_TOKENS = 100_000;
export const DEFAULT_RECENT_TURNS = 10;
export const DEFAULT_PREPARE_TIMEOUT_SECONDS = 360;
/** Default checkpoint-agent model: cheap and fast, never the session model. */
export const DEFAULT_MODEL = "haiku";
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const DEFAULT_AGENT_EFFORT: AgentEffort = "high";

export type ManualCompactMode = "shadow" | "native";

/** Who answers a checkpoint role. `pi` is opt-in only; `claude` is the default. */
export type CheckpointBackend = "claude" | "pi";

export const DEFAULT_NODE_PATH = "node";
export const DEFAULT_PI_THINKING: PiThinkingLevel = "low";

export interface ShadowConfig {
  prepareThresholdTokens: number;
  autoCompactWindowTokens: number;
  configureAutoCompactWindow: boolean;
  idleCompactMinTokens: number;
  configureIdleCompaction: boolean;
  /** Recent assistant/tool rounds kept verbatim (option key kept from turns). */
  recentTurns: number;
  /**
   * Hold a live compaction until its preparation settles: a checkpoint,
   * or a failure (the preparation deadline included). Slowness alone
   * never hands the compaction to native.
   */
  holdCompaction: boolean;
  prepareTimeoutSeconds: number;
  builderModel: string;
  verifierModel: string;
  builderEffort: AgentEffort;
  verifierEffort: AgentEffort;
  manualCompactMode: ManualCompactMode;
  builderBackend: CheckpointBackend;
  verifierBackend: CheckpointBackend;
  /** Pi provider/model per role; null when either half is missing. */
  piBuilder: PiTarget | null;
  piVerifier: PiTarget | null;
  /** Node executable that runs the bundled Pi worker. */
  piNodePath: string;
  claudePath: string;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function model(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : DEFAULT_MODEL;
}

function effort(value: unknown): AgentEffort {
  return (AGENT_EFFORTS as readonly unknown[]).includes(value) ? (value as AgentEffort) : DEFAULT_AGENT_EFFORT;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function backend(value: unknown): CheckpointBackend {
  return value === "pi" ? "pi" : "claude";
}

function thinking(value: unknown): PiThinkingLevel {
  const level = text(value);
  return (PI_THINKING_LEVELS as readonly string[]).includes(level) ? (level as PiThinkingLevel) : DEFAULT_PI_THINKING;
}

function piTarget(provider: unknown, modelId: unknown, level: unknown): PiTarget | null {
  const target = { provider: text(provider), model: text(modelId), thinking: thinking(level) };
  return target.provider && target.model ? target : null;
}

export function resolveConfig(options: PluginOptions): ShadowConfig {
  return {
    prepareThresholdTokens: positiveInt(options.prepareThresholdTokens, DEFAULT_PREPARE_THRESHOLD_TOKENS),
    autoCompactWindowTokens: positiveInt(options.autoCompactWindowTokens, DEFAULT_AUTO_COMPACT_WINDOW_TOKENS),
    configureAutoCompactWindow: options.configureAutoCompactWindow !== false,
    idleCompactMinTokens: Math.max(
      MIN_IDLE_COMPACT_MIN_TOKENS,
      positiveInt(options.idleCompactMinTokens, DEFAULT_IDLE_COMPACT_MIN_TOKENS),
    ),
    configureIdleCompaction: options.configureIdleCompaction !== false,
    recentTurns: positiveInt(options.recentTurns, DEFAULT_RECENT_TURNS),
    // The former `compactWaitSeconds: 0` meant "never wait".
    holdCompaction: options.holdCompaction !== false && Number(options.compactWaitSeconds) !== 0,
    prepareTimeoutSeconds: Math.min(600, positiveInt(options.prepareTimeoutSeconds, DEFAULT_PREPARE_TIMEOUT_SECONDS)),
    builderModel: model(options.builderModel),
    verifierModel: model(options.verifierModel),
    builderEffort: effort(options.builderEffort),
    verifierEffort: effort(options.verifierEffort),
    manualCompactMode: options.manualCompactMode === "native" ? "native" : "shadow",
    builderBackend: backend(options.builderBackend),
    verifierBackend: backend(options.verifierBackend),
    piBuilder: piTarget(options.piBuilderProvider, options.piBuilderModel, options.piBuilderThinking),
    piVerifier: piTarget(options.piVerifierProvider, options.piVerifierModel, options.piVerifierThinking),
    piNodePath: text(options.piNodePath) || DEFAULT_NODE_PATH,
    claudePath: text(options.claudePath) || "claude",
  };
}

/** Human-readable model for `/shadow-status`. */
export function describeModel(claudeModel: string): string {
  return `claude:${claudeModel}`;
}

export function roleBackend(config: ShadowConfig, role: CheckpointRole): CheckpointBackend {
  return role === "builder" ? config.builderBackend : config.verifierBackend;
}

export function piTargetFor(config: ShadowConfig, role: CheckpointRole): PiTarget | null {
  return role === "builder" ? config.piBuilder : config.piVerifier;
}

/** True when any role is configured for the Pi worker. */
export function usesPi(config: ShadowConfig): boolean {
  return config.builderBackend === "pi" || config.verifierBackend === "pi";
}

/** A role's backend and model for `/shadow-status`. */
export function describeRole(config: ShadowConfig, role: CheckpointRole): string {
  if (roleBackend(config, role) === "claude") {
    return role === "builder"
      ? `${describeModel(config.builderModel)}@${config.builderEffort}`
      : `${describeModel(config.verifierModel)}@${config.verifierEffort}`;
  }
  const target = piTargetFor(config, role);
  return target ? `pi:${target.provider}/${target.model}@${target.thinking}` : "pi:unconfigured";
}

export interface ThresholdUsage {
  tokens?: number | null | undefined;
  percent?: number | null | undefined;
}

export function isAtOrAbove(usage: ThresholdUsage, thresholdTokens: number): boolean {
  return typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= thresholdTokens;
}

export interface WindowFacts {
  /** The session model's id, as the context breakdown names it. */
  model: string;
  /** The model's full context window. */
  modelWindow: number;
  source: ContextWindowSource;
  /** The merged settings, read for an explicit window (`auto` included). */
  settings: Settings;
  /** Shadow already decided this model's window in an earlier session. */
  decidedBefore: boolean;
}

export type WindowDecision =
  | { apply: true }
  | { apply: false; reason: string; /** Remember so later sessions leave it. */ final: boolean };

function hasExplicitWindow(settings: Settings, model: string): boolean {
  if (settings.autoCompactWindow !== undefined) return true;
  const perModel = settings.modelSettings;
  if (typeof perModel !== "object" || perModel === null) return false;
  const entry = (perModel as Record<string, unknown>)[model];
  return typeof entry === "object" && entry !== null && "autoCompactWindow" in entry;
}

/**
 * Whether Shadow should set Claude Code's auto-compact window for this
 * model: once, and never over a window the person, an env override or
 * managed settings already chose.
 */
export function decideAutoCompactWindow(config: ShadowConfig, facts: WindowFacts): WindowDecision {
  if (!config.configureAutoCompactWindow) return { apply: false, reason: "disabled", final: false };
  if (facts.decidedBefore) return { apply: false, reason: "decided-before", final: true };
  if (facts.source === "env") return { apply: false, reason: "kept-env", final: true };
  if (facts.source === "settings" || hasExplicitWindow(facts.settings, facts.model)) {
    return { apply: false, reason: "kept-settings", final: true };
  }
  if (config.autoCompactWindowTokens <= config.prepareThresholdTokens) {
    return { apply: false, reason: "window-below-prepare-threshold", final: false };
  }
  if (config.autoCompactWindowTokens >= facts.modelWindow) {
    return { apply: false, reason: "model-window-smaller", final: false };
  }
  return { apply: true };
}

export type IdleCompactDecision = { apply: true } | { apply: false; reason: string };

/**
 * Whether Shadow should set Claude Code's idle-compaction floor
 * (`CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`) for this process: never over
 * a floor the person set, nor when idle compaction is turned off.
 */
export function decideIdleCompaction(
  config: ShadowConfig,
  facts: { envValue: string | undefined; settings: Settings },
): IdleCompactDecision {
  if (!config.configureIdleCompaction) return { apply: false, reason: "disabled" };
  if (facts.settings.idleCompaction === false) return { apply: false, reason: "off-settings" };
  if (facts.envValue !== undefined && facts.envValue !== "") return { apply: false, reason: `kept-env ${facts.envValue}` };
  return { apply: true };
}

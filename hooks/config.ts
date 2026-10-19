/** Three user preferences; host scheduling and safety limits are internal policy. */
import type { ContextWindowSource, PluginOptions, Settings } from "claude-code";

export const DEFAULT_PREPARE_THRESHOLD_TOKENS = 160_000;
export const IDLE_COMPACT_MIN_TOKENS = 100_000;
export const RECENT_ROUNDS = 10;
export const PREPARE_TIMEOUT_SECONDS = 360;
export const DEFAULT_MODEL = "haiku";
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const DEFAULT_AGENT_EFFORT: AgentEffort = "high";
const TARGET_COMPACT_TOKENS = 200_000;
const PREPARATION_LEAD_TOKENS = 40_000;
// Initial allowance for native headroom, based on the bundled v0.4.10 observations.
// This is a scheduling estimate, not a promise about Claude's actual trigger.
const NATIVE_HEADROOM_TOKENS = 35_000;
const MAX_AUTO_COMPACT_WINDOW_TOKENS = 1_000_000;

export interface ShadowConfig {
  prepareThresholdTokens: number;
  checkpointModel: string;
  checkpointEffort: AgentEffort;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveConfig(options: PluginOptions): ShadowConfig {
  const model = options.checkpointModel;
  const effort = options.checkpointEffort;
  return {
    prepareThresholdTokens: positiveInt(options.prepareThresholdTokens, DEFAULT_PREPARE_THRESHOLD_TOKENS),
    checkpointModel: typeof model === "string" && model.trim() ? model.trim() : DEFAULT_MODEL,
    checkpointEffort: (AGENT_EFFORTS as readonly unknown[]).includes(effort) ? effort as AgentEffort : DEFAULT_AGENT_EFFORT,
  };
}

export interface ThresholdUsage {
  tokens?: number | null | undefined;
  percent?: number | null | undefined;
}

export function isAtOrAbove(usage: ThresholdUsage, thresholdTokens: number): boolean {
  return typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= thresholdTokens;
}

export interface WindowFacts {
  model: string;
  modelWindow: number;
  effectiveWindow: number;
  source: ContextWindowSource;
  settings: Settings;
  /** Persisted `applied:<tokens>` is proof of what Shadow previously set. */
  previousDecision?: unknown;
}

export type WindowDecision =
  | { apply: true; tokens: number }
  | { apply: false; reason: string };

/** Accept only persisted records that name an actual value Shadow applied. */
function managedTokens(record: unknown): number | undefined {
  if (typeof record === "string" && /^applied:\d+$/.test(record)) return Number(record.slice(8));
  return undefined;
}

export function decideAutoCompactWindow(config: ShadowConfig, facts: WindowFacts): WindowDecision {
  if (facts.source === "env") return { apply: false, reason: "kept-env" };
  // A global choice might come from managed policy; never write over it.
  if (facts.settings.autoCompactWindow !== undefined) return { apply: false, reason: "kept-settings" };
  const entry = typeof facts.settings.modelSettings === "object" && facts.settings.modelSettings !== null
    ? (facts.settings.modelSettings as Record<string, unknown>)[facts.model] : undefined;
  const chosen = entry && typeof entry === "object" && "autoCompactWindow" in entry ? entry.autoCompactWindow : undefined;
  const previous = managedTokens(facts.previousDecision);
  const owned = previous !== undefined && facts.effectiveWindow === previous && chosen === previous;
  if (!owned && (facts.source === "settings" || chosen !== undefined)) return { apply: false, reason: "kept-settings" };
  // A user who changed a previously managed window to `auto` also owns that choice.
  if (!owned && facts.previousDecision !== undefined) return { apply: false, reason: "kept-user-choice" };
  if (!Number.isSafeInteger(facts.modelWindow) || facts.modelWindow < IDLE_COMPACT_MIN_TOKENS) {
    return { apply: false, reason: "model-window-unknown-or-small" };
  }
  const target = Math.max(TARGET_COMPACT_TOKENS, config.prepareThresholdTokens + PREPARATION_LEAD_TOKENS);
  const tokens = Math.min(facts.modelWindow, MAX_AUTO_COMPACT_WINDOW_TOKENS, target + NATIVE_HEADROOM_TOKENS);
  if (owned && previous === tokens) return { apply: false, reason: "managed" };
  return { apply: true, tokens };
}

export type IdleCompactDecision = { apply: true } | { apply: false; reason: string };

export function decideIdleCompaction(facts: { envValue: string | undefined; settings: Settings }): IdleCompactDecision {
  if (facts.settings.idleCompaction === false) return { apply: false, reason: "off-settings" };
  if (facts.envValue !== undefined && facts.envValue !== "") return { apply: false, reason: `kept-env ${facts.envValue}` };
  return { apply: true };
}

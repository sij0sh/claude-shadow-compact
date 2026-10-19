/** Three user preferences; host scheduling and safety limits are internal policy. */
import type { PluginOptions, Settings } from "claude-code";

export const DEFAULT_PREPARE_THRESHOLD_TOKENS = 160_000;
export const IDLE_COMPACT_MIN_TOKENS = 100_000;
export const RECENT_ROUNDS = 10;
export const ROLE_TIMEOUT_MS = 600_000;
export const RETRY_COOLDOWN_MS = 60_000;
export const COMPACT_WAIT_LEASE_MS = 240_000;
export const DEFAULT_MODEL = "haiku";
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const DEFAULT_AGENT_EFFORT: AgentEffort = "high";
const MIN_AUTO_COMPACT_WINDOW_TOKENS = 240_000;
const PREPARATION_LEAD_TOKENS = 80_000;
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

export interface WindowFacts { modelWindow: number }

export type WindowDecision =
  | { apply: true; tokens: number }
  | { apply: false; reason: string };

export function decideAutoCompactWindow(config: ShadowConfig, facts: WindowFacts): WindowDecision {
  if (!Number.isSafeInteger(facts.modelWindow) || facts.modelWindow < IDLE_COMPACT_MIN_TOKENS) {
    return { apply: false, reason: "model-window-unknown-or-small" };
  }
  const target = Math.max(MIN_AUTO_COMPACT_WINDOW_TOKENS, config.prepareThresholdTokens + PREPARATION_LEAD_TOKENS);
  const tokens = Math.min(facts.modelWindow, MAX_AUTO_COMPACT_WINDOW_TOKENS, target);
  return { apply: true, tokens };
}

export type IdleCompactDecision = { apply: true } | { apply: false; reason: string };

export function decideIdleCompaction(facts: { envValue: string | undefined; settings: Settings }): IdleCompactDecision {
  if (facts.settings.idleCompaction === false) return { apply: false, reason: "off-settings" };
  if (facts.envValue !== undefined && facts.envValue !== "") return { apply: false, reason: `kept-env ${facts.envValue}` };
  return { apply: true };
}

/**
 * Plugin-option configuration. The Pi version layered global/project
 * JSON files plus env overrides; the Claude version's single source is
 * the manifest's `userConfig`, delivered to `register(on, options)`
 * with defaults already filled. Values are re-validated here because
 * stored settings can predate the manifest's options.
 */
import type { PluginOptions } from "claude-code";

export const DEFAULT_PREPARE_THRESHOLD_TOKENS = 160_000;
export const DEFAULT_HARD_THRESHOLD_TOKENS = 250_000;
export const DEFAULT_RECENT_TURNS = 10;

export type ManualCompactMode = "shadow" | "native";

export interface ShadowConfig {
  prepareThresholdTokens: number;
  hardThresholdTokens: number;
  recentTurns: number;
  builderModel: string;
  verifierModel: string;
  manualCompactMode: ManualCompactMode;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function model(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : "inherit";
}

export function resolveConfig(options: PluginOptions): ShadowConfig {
  let prepare = positiveInt(options.prepareThresholdTokens, DEFAULT_PREPARE_THRESHOLD_TOKENS);
  // Leave room for a strictly higher hard limit, even for stored settings.
  if (prepare === Number.MAX_SAFE_INTEGER) prepare = DEFAULT_PREPARE_THRESHOLD_TOKENS;
  const hard = positiveInt(options.hardThresholdTokens, DEFAULT_HARD_THRESHOLD_TOKENS);
  return {
    prepareThresholdTokens: prepare,
    hardThresholdTokens: Math.max(hard, prepare + 1),
    recentTurns: positiveInt(options.recentTurns, DEFAULT_RECENT_TURNS),
    builderModel: model(options.builderModel),
    verifierModel: model(options.verifierModel),
    manualCompactMode: options.manualCompactMode === "native" ? "native" : "shadow",
  };
}

export interface ThresholdUsage {
  tokens?: number | null | undefined;
  percent?: number | null | undefined;
}

export function isAtOrAbove(usage: ThresholdUsage, thresholdTokens: number): boolean {
  return typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= thresholdTokens;
}

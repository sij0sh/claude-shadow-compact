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
export const DEFAULT_PI_BINARY = "pi";
export const DEFAULT_PI_TIMEOUT_MS = 540_000;
export const MAX_PI_TIMEOUT_MS = 600_000;

export type ManualCompactMode = "shadow" | "native";

/** Which engine answers a builder/verifier request. `claude` is the
 * default; `pi` shells out to the Pi CLI through `$.process.run`. */
export type ModelBackend = "claude" | "pi";

/** A Pi provider/model pair. Both blank means the Pi default model. */
export interface PiModelPair {
  provider: string;
  id: string;
}

export interface ShadowConfig {
  prepareThresholdTokens: number;
  hardThresholdTokens: number;
  recentTurns: number;
  builderModel: string;
  verifierModel: string;
  builderBackend: ModelBackend;
  verifierBackend: ModelBackend;
  builderPi: PiModelPair;
  verifierPi: PiModelPair;
  piBinary: string;
  piTimeoutMs: number;
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

function backend(value: unknown): ModelBackend {
  return typeof value === "string" && value.trim().toLowerCase() === "pi" ? "pi" : "claude";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Both blank or both set; a half-set pair falls back to blank. */
function piPair(provider: unknown, id: unknown): PiModelPair {
  const pair = { provider: text(provider), id: text(id) };
  if ((pair.provider === "") !== (pair.id === "")) return { provider: "", id: "" };
  return pair;
}

function piTimeout(value: unknown): number {
  const parsed = positiveInt(value, DEFAULT_PI_TIMEOUT_MS);
  return Math.min(parsed, MAX_PI_TIMEOUT_MS);
}

export function resolveConfig(options: PluginOptions): ShadowConfig {
  let prepare = positiveInt(options.prepareThresholdTokens, DEFAULT_PREPARE_THRESHOLD_TOKENS);
  // Leave room for a strictly higher hard limit, even for stored settings.
  if (prepare === Number.MAX_SAFE_INTEGER) prepare = DEFAULT_PREPARE_THRESHOLD_TOKENS;
  const hard = positiveInt(options.hardThresholdTokens, DEFAULT_HARD_THRESHOLD_TOKENS);
  const builderPi = piPair(options.builderProvider, options.builderId);
  // A blank verifier pair reuses the builder pair, as in the Pi version.
  const verifierRaw = piPair(options.verifierProvider, options.verifierId);
  const verifierPi =
    verifierRaw.provider === "" && verifierRaw.id === "" ? builderPi : verifierRaw;
  const piBinary = text(options.piBinary) === "" ? DEFAULT_PI_BINARY : text(options.piBinary);
  return {
    prepareThresholdTokens: prepare,
    hardThresholdTokens: Math.max(hard, prepare + 1),
    recentTurns: positiveInt(options.recentTurns, DEFAULT_RECENT_TURNS),
    builderModel: model(options.builderModel),
    verifierModel: model(options.verifierModel),
    builderBackend: backend(options.builderBackend),
    verifierBackend: backend(options.verifierBackend),
    builderPi,
    verifierPi,
    piBinary,
    piTimeoutMs: piTimeout(options.piTimeoutMs),
    manualCompactMode: options.manualCompactMode === "native" ? "native" : "shadow",
  };
}

/** Human-readable backend + model for `/shadow-status`. */
export function describeBackend(backendName: ModelBackend, claudeModel: string, pi: PiModelPair): string {
  if (backendName === "pi") {
    return pi.id === "" ? "pi:default" : `pi:${pi.provider}/${pi.id}`;
  }
  return `claude:${claudeModel}`;
}

export interface ThresholdUsage {
  tokens?: number | null | undefined;
  percent?: number | null | undefined;
}

export function isAtOrAbove(usage: ThresholdUsage, thresholdTokens: number): boolean {
  return typeof usage.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= thresholdTokens;
}

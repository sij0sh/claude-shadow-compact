/** Minimal input types for the portable core check only. Not a substitute for /plugin-types. */
declare module "claude-code" {
  export type PluginOptions = Record<string, unknown>;
  export type ContextWindowSource = "model-default" | "settings" | "env";
  export interface Settings {
    autoCompactWindow?: unknown;
    modelSettings?: unknown;
    idleCompaction?: boolean;
  }
}

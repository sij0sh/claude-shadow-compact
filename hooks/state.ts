/**
 * Rolling working-set state machine, ported from pi-shadow-compact
 * `state.ts`. The checkpoint being installed (`published`) is separate
 * from the one being built (`preparing`): a published checkpoint keeps
 * serving while its replacement prepares. `generation` identifies one
 * preparation attempt so a slow superseded completion can never alias
 * a newer preparation. The refresh gate re-arms only after an observed
 * installation followed by below-prepare context (crossing hysteresis),
 * so preparation cannot spin while context stays above the threshold.
 */
import type { CheckpointCoverage, PromptVersions, Checkpoint } from "./checkpoint.js";

export interface PublishedCheckpoint {
  checkpointId: string;
  sessionId: string;
  structured: Checkpoint;
  rendered: string;
  coverage: CheckpointCoverage;
  generatedAt: number;
  prompts: PromptVersions;
  /** Transcript message index of the coverage boundary at publish time. */
  coverageMessageIndex: number;
}

export interface PreparingInfo {
  generation: number;
  controller: AbortController;
}

export type PendingFallbackReason = "failure" | "emergency";

export class ShadowState {
  #generation = 0;
  #published: PublishedCheckpoint | undefined = undefined;
  #preparing: PreparingInfo | undefined = undefined;
  #installedCheckpointId: string | undefined = undefined;
  #pendingNativeFallback: PendingFallbackReason | null = null;
  #installCount = 0;
  #refreshArmed = true;
  #emptySuppressedAtTokens: number | undefined = undefined;
  #nativeBypassOnce = false;

  get generation(): number {
    return this.#generation;
  }
  get published(): PublishedCheckpoint | undefined {
    return this.#published;
  }
  get preparing(): PreparingInfo | undefined {
    return this.#preparing;
  }
  get installedCheckpointId(): string | undefined {
    return this.#installedCheckpointId;
  }
  get pendingNativeFallback(): boolean {
    return this.#pendingNativeFallback !== null;
  }
  get pendingFallbackReason(): PendingFallbackReason | undefined {
    return this.#pendingNativeFallback ?? undefined;
  }
  get installCount(): number {
    return this.#installCount;
  }
  get refreshArmed(): boolean {
    return this.#refreshArmed;
  }
  get emptySuppressedAtTokens(): number | undefined {
    return this.#emptySuppressedAtTokens;
  }
  get phase(): "idle" | "preparing" | "ready" | "ready-preparing" {
    if (this.#preparing && this.#published) return "ready-preparing";
    if (this.#preparing) return "preparing";
    if (this.#published) return "ready";
    return "idle";
  }

  /** Starts a preparation; fails only while another is in flight. */
  startPreparing(): PreparingInfo | undefined {
    if (this.#preparing) return undefined;
    this.#generation += 1;
    const preparing: PreparingInfo = {
      generation: this.#generation,
      controller: new AbortController(),
    };
    this.#preparing = preparing;
    this.#refreshArmed = false;
    this.#emptySuppressedAtTokens = undefined;
    return preparing;
  }

  /** Publishes a completed preparation, replacing the serving checkpoint. */
  publish(generation: number, result: PublishedCheckpoint): boolean {
    if (!this.#preparing || this.#preparing.generation !== generation) return false;
    if (this.#preparing.controller.signal.aborted) return false;
    this.#preparing = undefined;
    this.#published = result;
    this.#installCount = 0;
    return true;
  }

  /** Restores a persisted checkpoint (session start); no re-persist needed. */
  restorePublished(result: PublishedCheckpoint): void {
    this.#published = result;
    this.#installCount = 0;
    this.#refreshArmed = false;
    this.#installedCheckpointId = undefined;
  }

  fail(generation: number): boolean {
    if (!this.#preparing || this.#preparing.generation !== generation) return false;
    this.#preparing = undefined;
    if (this.#published) {
      // A failed replacement must not manufacture a threshold crossing.
      this.#refreshArmed = false;
    } else {
      this.#pendingNativeFallback = "failure";
      this.#refreshArmed = true;
    }
    return true;
  }

  /** A preparation that found nothing disposable to summarize. */
  skipPreparation(generation: number, currentTokens?: number): boolean {
    if (!this.#preparing || this.#preparing.generation !== generation) return false;
    this.#preparing = undefined;
    this.#refreshArmed = false;
    this.#emptySuppressedAtTokens = currentTokens;
    return true;
  }

  rearmAfterGrowth(currentTokens: number, tailBudgetTokens: number): boolean {
    if (this.#emptySuppressedAtTokens === undefined) return false;
    if (this.#refreshArmed) {
      this.#emptySuppressedAtTokens = undefined;
      return false;
    }
    const threshold =
      this.#emptySuppressedAtTokens + Math.max(1000, tailBudgetTokens * 0.25);
    if (currentTokens < threshold) return false;
    this.#emptySuppressedAtTokens = undefined;
    this.#refreshArmed = true;
    return true;
  }

  /** Records that the serving checkpoint was installed by a compaction. */
  markInstalled(): boolean {
    if (!this.#published) return false;
    this.#installCount += 1;
    this.#installedCheckpointId = this.#published.checkpointId;
    return true;
  }

  /** Re-arms the refresh gate after an observed install + shrink. */
  rearm(): boolean {
    if (this.#refreshArmed) return false;
    this.#refreshArmed = true;
    this.#emptySuppressedAtTokens = undefined;
    return true;
  }

  abortPreparing(): boolean {
    if (!this.#preparing) return false;
    this.#preparing.controller.abort();
    this.#preparing = undefined;
    this.#generation += 1;
    this.#refreshArmed = true;
    return true;
  }

  requestNativeFallback(reason: PendingFallbackReason = "emergency"): boolean {
    if (this.#pendingNativeFallback) return false;
    this.#preparing?.controller.abort();
    this.#preparing = undefined;
    this.#generation += 1;
    this.#pendingNativeFallback = reason;
    return true;
  }

  clearPendingNativeFallback(): boolean {
    if (!this.#pendingNativeFallback || this.#preparing) return false;
    this.#pendingNativeFallback = null;
    return true;
  }

  discardPublished(): boolean {
    if (!this.#published) return false;
    this.#published = undefined;
    this.#installCount = 0;
    this.#refreshArmed = true;
    return true;
  }

  /** One-shot bypass for /compact-native: the next compaction is native. */
  armNativeBypass(): void {
    this.#nativeBypassOnce = true;
  }

  consumeNativeBypass(): boolean {
    if (!this.#nativeBypassOnce) return false;
    this.#nativeBypassOnce = false;
    return true;
  }

  reset(): void {
    this.#preparing?.controller.abort();
    this.#preparing = undefined;
    this.#published = undefined;
    this.#installCount = 0;
    this.#installedCheckpointId = undefined;
    this.#generation += 1;
    this.#pendingNativeFallback = null;
    this.#refreshArmed = true;
    this.#nativeBypassOnce = false;
  }
}

/**
 * Rolling working-set state machine, ported from pi-shadow-compact
 * `state.ts`. The checkpoint being installed (`published`) is separate
 * from the one being built (`preparing`): a published checkpoint keeps
 * serving while its replacement prepares. `generation` identifies one
 * preparation attempt so a slow superseded completion can never alias
 * a newer preparation. Scheduling and bounded retries belong to the runtime;
 * failure never leaves a hidden permission latch closed.
 */
import type { PreparedCheckpoint } from "./prepare.js";

export interface PublishedCheckpoint {
  checkpointId: string;
  rendered: string;
  /** Archive uuid of the last transcript message the checkpoint represents. */
  coverageEndEntryId: string;
  compactionInstructions?: string;
  validation: PreparedCheckpoint["validation"];
  proof: {
    sessionId: string;
    epoch: number;
    snapshotId: string;
    coveredCount: number;
    prefixDigest: string;
    evidenceDigest: string;
  };
}

export class ShadowState {
  #generation = 0;
  #published: PublishedCheckpoint | undefined = undefined;
  #preparing: number | undefined = undefined;
  /** Checkpoint handed to the engine, awaiting canonical confirmation. */
  #attemptedCheckpoint: PublishedCheckpoint | undefined = undefined;
  #installedCheckpointId: string | undefined = undefined;
  #installCount = 0;

  get published(): PublishedCheckpoint | undefined {
    return this.#published;
  }
  get preparing(): boolean {
    return this.#preparing !== undefined;
  }
  get attemptedCheckpointId(): string | undefined {
    return this.#attemptedCheckpoint?.checkpointId;
  }
  get attemptedCheckpoint(): PublishedCheckpoint | undefined {
    return this.#attemptedCheckpoint;
  }
  get installedCheckpointId(): string | undefined {
    return this.#installedCheckpointId;
  }
  get installCount(): number {
    return this.#installCount;
  }
  get phase(): "idle" | "preparing" | "ready" | "refreshing" | "installing" | "installed" {
    if (this.#attemptedCheckpoint) return "installing";
    const ready = this.#published && this.#published.checkpointId !== this.#installedCheckpointId;
    if (this.preparing) return ready ? "refreshing" : "preparing";
    if (ready) return "ready";
    return this.#published && this.#installedCheckpointId ? "installed" : "idle";
  }

  /** Starts a preparation; returns its generation, or undefined while one is in flight. */
  startPreparing(): number | undefined {
    if (this.#preparing !== undefined) return undefined;
    this.#generation += 1;
    this.#preparing = this.#generation;
    return this.#generation;
  }

  /** Publishes a completed preparation, replacing the serving checkpoint. */
  publish(generation: number, result: PublishedCheckpoint): boolean {
    if (this.#preparing !== generation) return false;
    if (result.validation.deterministic !== "passed" || result.validation.independent !== "accepted") return false;
    this.#preparing = undefined;
    this.#published = result;
    return true;
  }

  /** Clear the active generation without displacing an earlier checkpoint. */
  fail(generation: number): boolean {
    if (this.#preparing !== generation) return false;
    this.#preparing = undefined;
    return true;
  }

  /** The compact hook handed the serving checkpoint to the engine. */
  attemptInstall(checkpoint: PublishedCheckpoint | undefined = this.#published): void {
    this.#attemptedCheckpoint = checkpoint;
  }

  /** Canonical history now opens with the attempted checkpoint. */
  confirmInstall(expectedCheckpointId?: string): boolean {
    if (!this.#attemptedCheckpoint ||
      (expectedCheckpointId !== undefined && this.#attemptedCheckpoint.checkpointId !== expectedCheckpointId)) return false;
    this.#installedCheckpointId = this.#attemptedCheckpoint.checkpointId;
    this.#attemptedCheckpoint = undefined;
    this.#installCount += 1;
    return true;
  }

  /** Canonical history does not show the attempted checkpoint. */
  rejectInstall(): void {
    this.#attemptedCheckpoint = undefined;
  }

  discardPublished(): boolean {
    if (!this.#published) return false;
    this.#published = undefined;
    return true;
  }

  reset(): void {
    this.#preparing = undefined;
    this.#published = undefined;
    this.#attemptedCheckpoint = undefined;
    this.#installedCheckpointId = undefined;
    this.#installCount = 0;
    this.#generation += 1;
  }
}

/**
 * Rolling working-set state machine, ported from pi-shadow-compact
 * `state.ts`. The checkpoint being installed (`published`) is separate
 * from the one being built (`preparing`): a published checkpoint keeps
 * serving while its replacement prepares. `generation` identifies one
 * preparation attempt so a slow superseded completion can never alias
 * a newer preparation. The refresh gate re-arms only after a confirmed
 * installation followed by below-prepare context, or after native
 * compaction, so preparation never spins (or retries a failure) while
 * context stays above the threshold.
 */
export interface PublishedCheckpoint {
  checkpointId: string;
  rendered: string;
  /** Archive uuid of the last transcript message the checkpoint represents. */
  coverageEndEntryId: string;
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
  #attemptedCheckpointId: string | undefined = undefined;
  #installedCheckpointId: string | undefined = undefined;
  #installCount = 0;
  #refreshArmed = true;

  get published(): PublishedCheckpoint | undefined {
    return this.#published;
  }
  get preparing(): boolean {
    return this.#preparing !== undefined;
  }
  get attemptedCheckpointId(): string | undefined {
    return this.#attemptedCheckpointId;
  }
  get installedCheckpointId(): string | undefined {
    return this.#installedCheckpointId;
  }
  get installCount(): number {
    return this.#installCount;
  }
  get refreshArmed(): boolean {
    return this.#refreshArmed;
  }
  get phase(): "idle" | "preparing" | "verified" | "verified-preparing" | "installing" | "installed" {
    if (this.#attemptedCheckpointId) return "installing";
    const ready = this.#published && this.#published.checkpointId !== this.#installedCheckpointId;
    if (this.preparing) return ready ? "verified-preparing" : "preparing";
    if (ready) return "verified";
    return this.#installedCheckpointId ? "installed" : "idle";
  }

  /** Starts a preparation; returns its generation, or undefined while one is in flight. */
  startPreparing(): number | undefined {
    if (this.#preparing !== undefined) return undefined;
    this.#generation += 1;
    this.#preparing = this.#generation;
    this.#refreshArmed = false;
    return this.#generation;
  }

  /** Publishes a completed preparation, replacing the serving checkpoint. */
  publish(generation: number, result: PublishedCheckpoint): boolean {
    if (this.#preparing !== generation) return false;
    this.#preparing = undefined;
    this.#published = result;
    return true;
  }

  /**
   * A completion whose coverage a compaction already removed from the
   * transcript: never published, and the refresh gate re-arms so the
   * next measure prepares against the history that is actually live.
   */
  discardStale(generation: number): boolean {
    if (this.#preparing !== generation) return false;
    this.#preparing = undefined;
    this.#refreshArmed = true;
    return true;
  }

  /** A failed preparation stays failed until the next compaction re-arms. */
  fail(generation: number): boolean {
    if (this.#preparing !== generation) return false;
    this.#preparing = undefined;
    return true;
  }

  /** The compact hook handed the serving checkpoint to the engine. */
  attemptInstall(): void {
    this.#attemptedCheckpointId = this.#published?.checkpointId;
  }

  /** Canonical history now opens with the attempted checkpoint. */
  confirmInstall(): boolean {
    if (!this.#attemptedCheckpointId) return false;
    this.#installedCheckpointId = this.#attemptedCheckpointId;
    this.#attemptedCheckpointId = undefined;
    this.#installCount += 1;
    return true;
  }

  /** Canonical history does not show the attempted checkpoint. */
  rejectInstall(): void {
    this.#attemptedCheckpointId = undefined;
  }

  /** Re-arms the refresh gate after an observed install + shrink or a native compaction. */
  rearm(): boolean {
    if (this.#refreshArmed) return false;
    this.#refreshArmed = true;
    return true;
  }

  disarmRefresh(): void { this.#refreshArmed = false; }

  discardPublished(): boolean {
    if (!this.#published) return false;
    this.#published = undefined;
    this.#refreshArmed = true;
    return true;
  }

  reset(): void {
    this.#preparing = undefined;
    this.#published = undefined;
    this.#attemptedCheckpointId = undefined;
    this.#installedCheckpointId = undefined;
    this.#installCount = 0;
    this.#generation += 1;
    this.#refreshArmed = true;
  }
}

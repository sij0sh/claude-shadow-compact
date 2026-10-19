/** One deadline and cancellation boundary for every backend and retry. */
export class PreparationCancelled extends Error {}

export class PreparationControl {
  readonly cancelled: Promise<never>;
  reason: string | null = null;
  finished = false;
  stopping = false;
  /** Immutable snapshot access text, written once even when a backend falls back. */
  evidenceAccess: string | undefined;
  private reject!: (error: Error) => void;

  constructor(
    readonly generation: number,
    readonly directory: string,
    readonly deadline: number,
    public coverageEndEntryId: string,
  ) {
    this.cancelled = new Promise<never>((_resolve, reject) => { this.reject = reject; });
    // A deadline can fire between requests, when nobody is awaiting it yet.
    void this.cancelled.catch(() => undefined);
  }

  cancel(reason: string): void {
    if (this.finished || this.reason) return;
    this.reason = reason;
    this.reject(new PreparationCancelled(reason));
  }

  remaining(now: number): number {
    if (now >= this.deadline) this.cancel("preparation deadline reached");
    if (this.reason) throw new PreparationCancelled(this.reason);
    return Math.max(1, Math.floor(this.deadline - now));
  }

  race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.cancelled]);
  }
}

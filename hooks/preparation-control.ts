/** Session cancellation is independent of each role's request deadline. */
export class PreparationCancelled extends Error {}

export class PreparationControl {
  readonly cancelled: Promise<never>;
  reason: string | null = null;
  finished = false;
  stopping = false;
  roleDeadline: number | undefined;
  roleAttempt = 0;
  private reject!: (error: Error) => void;

  constructor(
    readonly generation: number,
    readonly directory: string,
    public coverageEndEntryId: string,
    readonly instructions = "",
  ) {
    this.cancelled = new Promise<never>((_resolve, reject) => { this.reject = reject; });
    void this.cancelled.catch(() => undefined);
  }

  cancel(reason: string): void {
    if (this.finished || this.reason) return;
    this.reason = reason;
    this.reject(new PreparationCancelled(reason));
  }

  assertActive(): void {
    if (this.reason) throw new PreparationCancelled(this.reason);
  }

  beginRole(now: number, timeoutMs: number): number {
    this.assertActive();
    this.roleDeadline = now + timeoutMs;
    return ++this.roleAttempt;
  }

  endRole(attempt: number): void {
    if (this.roleAttempt === attempt) this.roleDeadline = undefined;
  }

  race<T>(operation: Promise<T>): Promise<T> {
    this.assertActive();
    return Promise.race([operation, this.cancelled]);
  }
}

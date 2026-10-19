import { access } from "node:fs/promises";

/** The host can cancel a running provider request without a process handle. */
export function workerCancellation(deadlineMs: number, cancelPath?: string, parentSignal?: AbortSignal): { signal: AbortSignal; close: () => void; check: () => Promise<void> } {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(deadlineMs), cancelled.signal, ...(parentSignal ? [parentSignal] : [])]);
  const check = async () => {
    if (cancelPath && await access(cancelPath).then(() => true, () => false)) cancelled.abort();
  };
  const timer = cancelPath ? setInterval(() => { void check(); }, 250) : undefined;
  timer?.unref();
  return { signal, check, close: () => { if (timer) clearInterval(timer); } };
}

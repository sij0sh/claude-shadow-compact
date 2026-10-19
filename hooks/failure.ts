/** Typed failures authorize recovery; absence of a checkpoint does not. */
export class PreparationError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(`${code}: ${message}`);
  }
}

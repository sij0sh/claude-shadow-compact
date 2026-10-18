/**
 * Compaction candidate construction over Claude `SessionMessage`s.
 * Ported from pi-shadow-compact `working-context.ts` / `swap.ts`:
 *   checkpoint coverage ∪ exact recent tail covers the transcript with
 *   no uncovered interval, the tail never splits a tool call from its
 *   result, and a candidate that drops nothing (or saves nothing) is
 *   refused so the caller falls back to native compaction.
 */
import type { SessionMessage } from "claude-code";
import { estimateTokens } from "./normalize.js";

export type TailSkipReason = "stale-coverage" | "no-drop" | "empty-tail" | "orphan" | "no-savings";

export interface TailPlan {
  /** Message index the exact tail starts at. */
  tailStart: number;
  /** Messages dropped from the compacted transcript. */
  dropped: number;
}

export type TailResult = TailPlan | { skipped: TailSkipReason };

export function isSkipped(result: TailResult): result is { skipped: TailSkipReason } {
  return "skipped" in result;
}

function isToolResultCarrier(message: SessionMessage): boolean {
  return message.role === "user" && (message.toolResults?.length ?? 0) > 0;
}

/**
 * A round starts at a person's prompt, or at the assistant response that
 * follows tool results. A round is a prompt with its reply, or one
 * assistant response with the tool results it asked for, so a single
 * long agentic turn still has many places the tail can start.
 */
export function isRoundStart(messages: readonly SessionMessage[], index: number): boolean {
  const message = messages[index];
  if (!message) return false;
  if (message.role === "user") return !isToolResultCarrier(message);
  const previous = messages[index - 1];
  return message.role === "assistant" && previous !== undefined && isToolResultCarrier(previous);
}

/**
 * Plans the tail: it starts at the round containing the first uncovered
 * message, moved earlier when needed to keep `recentRounds` whole rounds,
 * so every dropped message is covered by the checkpoint.
 * `coveredIndex` is the transcript index of the last covered message
 * (-1 when the checkpoint covers nothing yet). Returns a skip when the
 * coverage anchor is off-transcript (stale checkpoint, fail closed).
 */
export function planTail(
  messages: readonly SessionMessage[],
  coveredIndex: number,
  recentRounds: number,
): TailResult {
  if (messages.length === 0) return { skipped: "empty-tail" };
  if (coveredIndex < -1 || coveredIndex >= messages.length) return { skipped: "stale-coverage" };

  const roundStarts: number[] = [];
  messages.forEach((_message, index) => {
    if (isRoundStart(messages, index)) roundStarts.push(index);
  });
  if (roundStarts[0] !== 0) roundStarts.unshift(0);

  // Start of the round holding the first uncovered message (the last
  // round when everything is covered).
  const firstUncovered = Math.min(coveredIndex + 1, messages.length - 1);
  let tailStart = 0;
  for (const start of roundStarts) if (start <= firstUncovered) tailStart = start;
  // Recent-rounds minimum: keep at least `recentRounds` whole rounds.
  const keep = Math.max(1, Math.floor(recentRounds));
  const recentStart = roundStarts[Math.max(0, roundStarts.length - keep)]!;
  if (recentStart < tailStart) tailStart = recentStart;

  if (tailStart <= 0) return { skipped: "no-drop" };
  const tail = messages.slice(tailStart);
  if (tail.length === 0) return { skipped: "empty-tail" };
  if (hasOrphanedToolResult(tail)) return { skipped: "orphan" };
  return { tailStart, dropped: tailStart };
}

/** Every kept tool result must have its call among the kept messages. */
export function hasOrphanedToolResult(messages: readonly SessionMessage[]): boolean {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolUse of message.toolUses) calls.add(toolUse.tool_use_id);
  }
  return messages.some((message) =>
    (message.toolResults ?? []).some((result) => !calls.has(result.tool_use_id)),
  );
}

export function estimateMessagesTokens(messages: readonly SessionMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.text);
    for (const toolUse of message.toolUses) {
      total += estimateTokens(toolUse.text ?? "") + estimateTokens(JSON.stringify(toolUse.input ?? {}));
    }
    for (const result of message.toolResults ?? []) total += estimateTokens(result.text);
  }
  return total;
}

/**
 * Builds the post-compaction transcript: one new checkpoint message
 * (no handle; built by the mod) followed by the exact tail messages
 * with their engine handles untouched. Refuses when the candidate is
 * not smaller than the original (no-savings fails closed to native).
 */
export function buildCandidate(
  messages: readonly SessionMessage[],
  coveredIndex: number,
  recentRounds: number,
  renderedCheckpoint: string,
): TailResult & { messages?: SessionMessage[] } {
  const plan = planTail(messages, coveredIndex, recentRounds);
  if (isSkipped(plan)) return plan;
  const candidate: SessionMessage[] = [
    { role: "user", text: renderedCheckpoint, toolUses: [] },
    ...messages.slice(plan.tailStart),
  ];
  if (estimateMessagesTokens(candidate) >= estimateMessagesTokens(messages)) {
    return { skipped: "no-savings" };
  }
  return { ...plan, messages: candidate };
}

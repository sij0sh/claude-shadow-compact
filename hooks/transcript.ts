/**
 * Compact handles are opaque: look them up verbatim among observed row ids,
 * never infer coverage from append counts, positions, or matching prose.
 * Unknown handles fail closed. Canonical reads do not carry handles, so only
 * compact inputs/results establish which archived identities remain live.
 */
import type { SessionMessage } from "claude-code";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]),
  );
  return value;
}

function identity(message: SessionMessage): string {
  return JSON.stringify(stable({
    role: message.role, text: message.text,
    calls: message.toolUses.map(call => [call.tool_use_id, call.tool, call.input]),
    results: (message.toolResults ?? []).map(result => [result.tool_use_id, result.text, result.isError]),
  }));
}

export class LiveTranscript {
  readonly knownIds = new Set<string>();
  private retained: { keys: string[]; ids: string[] } | undefined;

  /** Remember an entire canonical prefix we seeded or returned to the host.
   * Some hosts clone retained rows with fresh UUIDs. Rebind only if the whole
   * prefix still matches, including tool calls/results, never by position alone. */
  remember(messages: readonly SessionMessage[], ids: readonly string[]): void {
    this.retained = { keys: messages.map(identity), ids: [...ids] };
    for (const id of ids) this.knownIds.add(id);
  }

  matchesPrefix(messages: readonly SessionMessage[]): boolean {
    return !!this.retained && messages.length >= this.retained.keys.length &&
      this.retained.keys.every((key, index) => key === identity(messages[index]!));
  }

  resolve(messages: readonly SessionMessage[]): string[] {
    const expected = this.retained;
    const matches = expected && this.matchesPrefix(messages);
    return messages.map((message, index) => {
      if (matches && index < expected.ids.length) return expected.ids[index]!;
      return message.handle && this.knownIds.has(message.handle) ? message.handle : `unknown-${index}`;
    });
  }
}

export function isTranscriptRow(message: { type: string; role?: string; isMeta?: boolean }): boolean {
  return message.type === "assistant" || (message.type === "user" && message.role === "user" && !message.isMeta);
}

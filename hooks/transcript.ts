/**
 * Compact handles are opaque. Canonical reads reconstruct the complete ordered
 * history; live compact inputs provide authoritative handles. Identity labels
 * alone never prove deletion safety: a checkpoint must match its full covered
 * prefix digest. Newer rows remain in the exact handle tail.
 */
import type { SessionMessage } from "claude-code";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]),
  );
  return value;
}

export function messageIdentity(message: SessionMessage): string {
  return JSON.stringify(stable({
    role: message.role, text: message.text,
    calls: message.toolUses.map(call => [call.tool_use_id, call.tool, call.input]),
    results: (message.toolResults ?? []).map(result => [result.tool_use_id, result.text, result.isError]),
  }));
}

export class LiveTranscript {
  readonly knownIds = new Set<string>();
  private readonly observed = new Map<string, SessionMessage>();
  private retained: { keys: string[]; ids: string[] } | undefined;

  /** Remember an entire canonical prefix we seeded or returned to the host.
   * Some hosts clone retained rows with fresh UUIDs. Rebind only if the whole
   * prefix still matches, including tool calls/results, never by position alone. */
  remember(messages: readonly SessionMessage[], ids: readonly string[]): void {
    this.retained = { keys: messages.map(messageIdentity), ids: [...ids] };
    // The sanitized evidence archive preserves history. Raw message projections
    // are needed only for the current context, not every prior context window.
    this.observed.clear();
    this.knownIds.clear();
    messages.forEach((message, index) => this.observe(ids[index]!, message));
  }

  observe(id: string, message: SessionMessage): void {
    this.knownIds.add(id);
    this.observed.set(id, message);
  }

  messages(ids: readonly string[]): SessionMessage[] | undefined {
    const messages = ids.map(id => this.observed.get(id));
    return messages.every((message): message is SessionMessage => !!message) ? messages : undefined;
  }

  /** Canonical history is the source of content; ids are local evidence labels.
   * Reuse labels only for an entire observed prefix/suffix, never one prose row.
   * Live compact handles can always label their own authoritative snapshot. */
  bind(messages: readonly SessionMessage[], currentIds: readonly string[], epoch: number): string[] {
    const current = this.messages(currentIds);
    const keys = messages.map(messageIdentity);
    const old = current?.map(messageIdentity) ?? [];
    const prefix = old.length <= keys.length && old.every((key, i) => key === keys[i]);
    const offset = keys.length - old.length;
    const suffix = offset >= 0 && old.every((key, i) => key === keys[offset + i]);
    return messages.map((message, index) => {
      if (message.handle) return message.handle;
      if (current && prefix && index < old.length) return currentIds[index]!;
      if (current && suffix && index >= offset) return currentIds[index - offset]!;
      return `bootstrap-${epoch}-${index}`;
    });
  }

  matchesPrefix(messages: readonly SessionMessage[]): boolean {
    return !!this.retained && messages.length >= this.retained.keys.length &&
      this.retained.keys.every((key, index) => key === messageIdentity(messages[index]!));
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

export async function contentDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function prefixDigest(messages: readonly SessionMessage[], count: number): Promise<string> {
  return contentDigest(JSON.stringify(messages.slice(0, count).map(messageIdentity)));
}

/** The same text/tool projection the host exposes in session.messages(). */
export function messageFromAppend(message: { type: string; role?: string; content: unknown }): SessionMessage {
  const blocks = (Array.isArray(message.content) ? message.content : []) as Array<Record<string, any>>;
  const text = typeof message.content === "string" ? message.content : blocks.filter(b => b.type === "text").map(b => b.text).join("");
  const toolUses = blocks.filter(b => b.type === "tool_use").map(b => ({ tool_use_id: String(b.id), tool: String(b.name), input: b.input }));
  const toolResults = blocks.filter(b => b.type === "tool_result").map(b => ({
    tool_use_id: String(b.tool_use_id),
    text: typeof b.content === "string" ? b.content : Array.isArray(b.content)
      ? b.content.filter((c: Record<string, unknown>) => c.type === "text").map((c: Record<string, unknown>) => c.text).join("\n") : "",
    isError: b.is_error === true,
  }));
  return { role: message.type === "assistant" ? "assistant" : "user", text, toolUses, ...(toolResults.length ? { toolResults } : {}) };
}

export function isTranscriptRow(message: { type: string; role?: string; isMeta?: boolean }): boolean {
  return message.type === "assistant" || (message.type === "user" && message.role === "user" && !message.isMeta);
}

/**
 * The Pi worker's checkpoint agent, ported from pi-shadow-compact's
 * checkpoint-agent loop. One role per run: the model inspects the frozen
 * evidence snapshot through read-only tools (never the repository, a
 * shell, or any file but the snapshot) and terminates by calling its
 * submit tool. Submissions are checked here against what this agent was
 * actually served, then handed back to the mod as the role's JSON answer,
 * where `prepare.ts` validates them again before Shadow trusts them.
 *
 * The completion function is injected, so tests drive the loop with
 * scripted responses and no network.
 */
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Api,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { EvidenceArchive, PREVIOUS_CHECKPOINT_EVIDENCE_ID, type EvidenceRow } from "../hooks/evidence.js";
import { sanitizeForContext } from "../hooks/normalize.js";
import { parseSubmission } from "../hooks/prepare.js";
import type { CheckpointRole, PiEvidenceFile, PiUsage } from "../hooks/pi-protocol.js";

export const BUILDER_MAX_ROUNDS = 40;
export const VERIFIER_MAX_ROUNDS = 20;
const MAX_SUBMIT_ATTEMPTS = 3;
/** Share of the private model's context window its transcript may fill. */
const PRIVATE_TRANSCRIPT_SHARE = 0.5;
const CHARS_PER_TOKEN = 4;
const MIN_READ_PAGE_CHARS = 24_000;
const MAX_READ_PAGE_CHARS = 200_000;
const MAX_TURN_RANGE = 25;
const MAX_ROW_RANGE = 50;
const SNIPPET_CHARS = 160;

export type CompleteFn = (context: Context, options: { signal: AbortSignal }) => Promise<AssistantMessage>;

/** Rebuilds the snapshot the mod froze, with the same evidence ids. */
export function archiveFromFile(file: PiEvidenceFile): EvidenceArchive {
  const archive = new EvidenceArchive("");
  for (const row of file.rows) archive.add(row);
  archive.setPreviousCheckpoint(file.previousCheckpoint ?? undefined, file.previousCoverageEndEntryId);
  return archive;
}

export function transcriptBudgetChars(model: Pick<Model<Api>, "contextWindow">): number {
  return model.contextWindow > 0
    ? Math.floor(model.contextWindow * PRIVATE_TRANSCRIPT_SHARE) * CHARS_PER_TOKEN
    : Infinity;
}

/** One read page: a quarter of the transcript budget, within fixed bounds. */
export function readPageChars(model: Pick<Model<Api>, "contextWindow">): number {
  const budget = transcriptBudgetChars(model);
  return Math.min(budget, MAX_READ_PAGE_CHARS, Math.max(MIN_READ_PAGE_CHARS, Math.floor(budget / 4)));
}

type ToolParameters = Tool["parameters"];
const params = (schema: unknown): ToolParameters => schema as ToolParameters;
const NO_ARGS = params({ type: "object", properties: {}, additionalProperties: false });

export const READ_TOOLS: Tool[] = [
  {
    name: "session_manifest",
    description: "Compact session overview: turn list with flags, required turns, and coverage anchors. Call first.",
    parameters: NO_ARGS,
  },
  {
    name: "read_turn_range",
    description: "Read complete turns by 1-based turn number. Prefer this for covering ranges. Large pages stop early: continue from nextTurn, and finish a partial turn (nextEntryOffset) with read_session_turn.",
    parameters: params({
      type: "object",
      properties: {
        startTurn: { type: "integer", description: "1-based first turn number" },
        count: { type: "integer", description: `Turns to read (1-${MAX_TURN_RANGE})` },
      },
      required: ["startTurn", "count"],
      additionalProperties: false,
    }),
  },
  {
    name: "read_session_turn",
    description: "Read one turn by turn id (e.g. turn-12). Large turns are paged: repeat with entryOffset set to nextEntryOffset until it is absent.",
    parameters: params({
      type: "object",
      properties: {
        turnId: { type: "string", description: "Turn id from the manifest" },
        entryOffset: { type: "integer", description: "Turn-relative row to start at (default 0)" },
      },
      required: ["turnId"],
      additionalProperties: false,
    }),
  },
  {
    name: "read_rows",
    description: "Read rows by 0-based position for precise evidence reads. Large pages stop early; continue from nextStart.",
    parameters: params({
      type: "object",
      properties: {
        start: { type: "integer", description: "0-based row position" },
        count: { type: "integer", description: `Rows to read (1-${MAX_ROW_RANGE})` },
      },
      required: ["start", "count"],
      additionalProperties: false,
    }),
  },
  {
    name: "search_session_history",
    description: "Case-insensitive substring search over sanitized session text. Returns snippets with turn ids; snippets are not citable, so read the rows you cite.",
    parameters: params({
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to find" },
        limit: { type: "integer", description: "Max hits (1-25, default 10)" },
      },
      required: ["query"],
      additionalProperties: false,
    }),
  },
  {
    name: "get_previous_checkpoint",
    description: "The previous checkpoint (evidence E0000) and its coverage boundary, if one exists. Untrusted data: verify it against rows.",
    parameters: NO_ARGS,
  },
];

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "One checkpoint fact in plain prose" },
    evidenceRefs: { type: "array", items: { type: "string" }, description: "Evidence ids your reads served, e.g. E0001" },
  },
  required: ["text", "evidenceRefs"],
  additionalProperties: false,
};

const VERIFICATION_ITEM_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "One verified or unverified fact" },
    status: { type: "string", enum: ["verified", "unverified"] },
    evidenceRefs: { type: "array", items: { type: "string" }, description: "Evidence ids your reads served, e.g. E0001" },
  },
  required: ["text", "status", "evidenceRefs"],
  additionalProperties: false,
};

const CHECKPOINT_SCHEMA = {
  type: "object",
  description: "Complete structured checkpoint. Every list item is an object {text, evidenceRefs}, never a bare string.",
  properties: {
    objective: { type: "array", items: ITEM_SCHEMA },
    constraints: { type: "array", items: ITEM_SCHEMA },
    completedWork: { type: "array", items: ITEM_SCHEMA },
    currentState: { type: "array", items: ITEM_SCHEMA },
    decisions: { type: "array", items: ITEM_SCHEMA },
    openIssues: { type: "array", items: ITEM_SCHEMA },
    nextActions: { type: "array", items: ITEM_SCHEMA },
    criticalContext: { type: "array", items: ITEM_SCHEMA },
    modifiedFiles: { type: "array", items: ITEM_SCHEMA },
    referencedFiles: { type: "array", items: ITEM_SCHEMA },
    verificationState: { type: "array", items: VERIFICATION_ITEM_SCHEMA },
    continuationState: {
      type: "object",
      properties: {
        currentGoal: { type: "string" },
        currentApproach: { type: "string" },
        immediateNextStep: { type: "string" },
      },
      required: ["currentGoal", "currentApproach", "immediateNextStep"],
      additionalProperties: false,
    },
  },
  required: ["objective", "continuationState"],
  additionalProperties: false,
};

export const SUBMIT_CHECKPOINT_TOOL: Tool = {
  name: "submit_checkpoint",
  description: "Submit the finished checkpoint. Checks coverage, inspection requirements, and schema; returns errors to fix.",
  parameters: params({
    type: "object",
    properties: {
      checkpoint: CHECKPOINT_SCHEMA,
      coverageEndEntryId: { type: "string", description: "entryId of the last user or assistant row the checkpoint represents" },
    },
    required: ["checkpoint", "coverageEndEntryId"],
    additionalProperties: false,
  }),
};

export const SUBMIT_VERDICT_TOOL: Tool = {
  name: "submit_verdict",
  description: "Accept the draft, repair it with a complete corrected checkpoint, or reject it as unusable.",
  parameters: params({
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["accept", "repair", "unusable"] },
      checkpoint: { ...CHECKPOINT_SCHEMA, description: "Complete corrected checkpoint (required for repair)" },
      coverageEndEntryId: { type: "string", description: "Coverage boundary (required for repair)" },
      reason: { type: "string", description: "One sentence on what was wrong or confirmed" },
    },
    required: ["verdict"],
    additionalProperties: false,
  }),
};

/** Appended to the mod's role prompt: the answer arrives as tool arguments. */
const TOOL_ANSWER_NOTE = {
  builder:
    "Inspect history through the read tools, then terminate by calling submit_checkpoint with the answer's fields as its arguments instead of answering in text.",
  verifier:
    "Inspect history through the read tools, then terminate by calling submit_verdict with the answer's fields as its arguments instead of answering in text.",
} satisfies Record<CheckpointRole, string>;

/** What one agent has inspected: its own, never shared between roles. */
export class Inspection {
  readonly servedRefs = new Set<string>();
  readonly servedRowIds = new Set<string>();
  readCalls = 0;

  constructor(readonly archive: EvidenceArchive) {}

  serve(rows: readonly EvidenceRow[]): void {
    for (const row of rows) {
      this.servedRefs.add(row.evidenceId);
      this.servedRowIds.add(row.id);
    }
    this.readCalls += 1;
  }

  /** A turn is inspected only when every one of its rows was served. */
  missingRequiredTurns(): string[] {
    const required = new Set(this.archive.manifest().requiredTurnIds);
    return this.archive
      .turns()
      .filter((turn) => required.has(turn.turnId) && turn.rowIds.some((id) => !this.servedRowIds.has(id)))
      .map((turn) => turn.turnId);
  }

  /** Every row the boundary newly claims, after the previous one, was served. */
  requireCoverage(coverageEndEntryId: unknown): void {
    if (typeof coverageEndEntryId !== "string" || coverageEndEntryId === "") {
      throw new Error("coverageEndEntryId must name a session row");
    }
    const end = this.archive.indexOf(coverageEndEntryId);
    if (end < 0) throw new Error(`coverageEndEntryId is not a session row: ${coverageEndEntryId}`);
    const previous = this.archive.previousCoverageEndEntryId;
    const previousIndex = previous === null ? -1 : this.archive.indexOf(previous);
    if (end < previousIndex) throw new Error("coverageEndEntryId regresses the previous checkpoint coverage");
    const unread = this.archive.rows
      .slice(previousIndex + 1, end + 1)
      .filter((row) => !this.servedRowIds.has(row.id))
      .map((row) => row.evidenceId);
    if (unread.length > 0) {
      throw new Error(
        `coverageEndEntryId claims ${unread.length} unread row${unread.length === 1 ? "" : "s"}; read them first (e.g. ${unread.slice(0, 3).join(", ")})`,
      );
    }
  }

  requireCompletion(): void {
    const missing = this.missingRequiredTurns();
    if (missing.length > 0) {
      throw new Error(
        `inspection requirements unmet: read every row of the required turns before submitting (${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ` and ${missing.length - 8} more` : ""})`,
      );
    }
  }
}

function view(row: EvidenceRow, position: number) {
  return {
    evidenceId: row.evidenceId,
    entryId: row.id,
    position,
    role: row.role ?? row.door,
    ...(row.isError ? { isError: true } : {}),
    text: row.text,
  };
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** Served size of one row, its JSON framing included. */
function rowCost(archive: EvidenceArchive, index: number): number {
  return archive.rows[index]!.text.length + 200;
}

/** Leading rows of `indexes` within `pageChars`; at least one when `atLeastOne`. */
function page(archive: EvidenceArchive, indexes: readonly number[], pageChars: number, atLeastOne = true): number[] {
  const taken: number[] = [];
  let chars = 0;
  for (const index of indexes) {
    const size = rowCost(archive, index);
    if ((taken.length > 0 || !atLeastOne) && chars + size > pageChars) break;
    taken.push(index);
    chars += size;
  }
  return taken;
}

export function executeReadTool(
  inspection: Inspection,
  pageChars: number,
  name: string,
  args: Record<string, unknown>,
): unknown {
  const archive = inspection.archive;
  switch (name) {
    case "session_manifest":
      return archive.manifest();
    case "get_previous_checkpoint": {
      const previous = archive.previousCheckpoint();
      if (!previous) return { summary: null };
      inspection.servedRefs.add(PREVIOUS_CHECKPOINT_EVIDENCE_ID);
      return { ...previous, coverageEndEntryId: archive.previousCoverageEndEntryId };
    }
    case "read_rows": {
      const start = asInteger(args.start);
      const count = asInteger(args.count);
      if (start === undefined || count === undefined) throw new Error("read_rows needs integer start and count");
      if (start < 0 || start >= archive.size) throw new Error(`start must be 0-${archive.size - 1}`);
      const wanted = Array.from({ length: Math.min(Math.max(count, 1), MAX_ROW_RANGE, archive.size - start) }, (_, i) => start + i);
      const taken = page(archive, wanted, pageChars);
      inspection.serve(taken.map((index) => archive.rows[index]!));
      const next = start + taken.length;
      return { rows: taken.map((index) => view(archive.rows[index]!, index)), ...(next < archive.size ? { nextStart: next } : {}) };
    }
    case "read_session_turn": {
      if (typeof args.turnId !== "string" || !args.turnId) throw new Error("read_session_turn needs a turnId");
      const offset = args.entryOffset === undefined ? 0 : asInteger(args.entryOffset);
      if (offset === undefined || offset < 0) throw new Error("entryOffset must be a non-negative integer");
      const turn = archive.turns().find((candidate) => candidate.turnId === args.turnId);
      if (!turn) throw new Error(`Unknown turn: ${args.turnId}`);
      const indexes = turn.rowIds.slice(offset).map((id) => archive.indexOf(id));
      const taken = page(archive, indexes, pageChars);
      inspection.serve(taken.map((index) => archive.rows[index]!));
      const next = offset + taken.length;
      return {
        turnId: turn.turnId,
        rows: taken.map((index) => view(archive.rows[index]!, index)),
        ...(next < turn.rowIds.length ? { nextEntryOffset: next } : {}),
      };
    }
    case "read_turn_range": {
      const startTurn = asInteger(args.startTurn);
      const count = asInteger(args.count);
      if (startTurn === undefined || count === undefined) throw new Error("read_turn_range needs integer startTurn and count");
      const turns = archive.turns();
      if (startTurn < 1 || startTurn > turns.length) throw new Error(`startTurn must be 1-${turns.length}`);
      const selected = turns.slice(startTurn - 1, startTurn - 1 + Math.min(Math.max(count, 1), MAX_TURN_RANGE));
      const out: Array<{ turnId: string; rows: ReturnType<typeof view>[]; nextEntryOffset?: number }> = [];
      let remaining = pageChars;
      // The first turn not fully served here, when the page stopped early.
      let stoppedAt: number | undefined;
      for (const [i, turn] of selected.entries()) {
        const indexes = turn.rowIds.map((id) => archive.indexOf(id));
        const taken = page(archive, indexes, remaining, out.length === 0);
        if (taken.length === 0) {
          stoppedAt = startTurn + i;
          break;
        }
        inspection.serve(taken.map((index) => archive.rows[index]!));
        remaining -= taken.reduce((sum, index) => sum + rowCost(archive, index), 0);
        const partial = taken.length < indexes.length;
        out.push({
          turnId: turn.turnId,
          rows: taken.map((index) => view(archive.rows[index]!, index)),
          ...(partial ? { nextEntryOffset: taken.length } : {}),
        });
        if (partial) {
          stoppedAt = startTurn + i + 1;
          break;
        }
      }
      const after = stoppedAt ?? startTurn + selected.length;
      const nextTurn = after <= turns.length ? after : undefined;
      return { turns: out, ...(nextTurn !== undefined ? { nextTurn } : {}) };
    }
    case "search_session_history": {
      if (typeof args.query !== "string" || !args.query.trim()) throw new Error("search_session_history needs a query");
      const limit = args.limit === undefined ? 10 : asInteger(args.limit);
      if (limit === undefined) throw new Error("limit must be an integer");
      const needle = args.query.trim().toLowerCase();
      const turnOf = new Map<string, string>();
      for (const turn of archive.turns()) for (const id of turn.rowIds) turnOf.set(id, turn.turnId);
      const hits: Array<{ evidenceId: string; entryId: string; turnId: string; snippet: string }> = [];
      for (const row of archive.rows) {
        const at = row.text.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const from = Math.max(0, at - SNIPPET_CHARS / 2);
        hits.push({
          evidenceId: row.evidenceId,
          entryId: row.id,
          turnId: turnOf.get(row.id) ?? "",
          snippet: row.text.slice(from, from + SNIPPET_CHARS),
        });
        if (hits.length >= Math.min(Math.max(limit, 1), 25)) break;
      }
      return { hits };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const EVIDENCE_ID = /"evidenceId":"(E\d{4,})"/g;

/** Replaces an old read with a stub; its rows stay inspected. */
function elide(message: ToolResultMessage): void {
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  const ids = [...text.matchAll(EVIDENCE_ID)].map((match) => match[1]!);
  message.content = [{
    type: "text",
    text: JSON.stringify({
      elided: true,
      note: "Earlier read result removed to bound private context. Its rows remain inspected; re-read them if you need exact text.",
      evidenceIds: ids.length > 0 ? { first: ids[0], last: ids.at(-1), count: ids.length } : null,
    }),
  }];
}

function chars(message: Message): number {
  return JSON.stringify(message).length;
}

type Outcome = { done: true; answer: string } | { done: false; text: string; isError: boolean };

/** Checks one submit call; a rejection goes back to the agent to fix. */
function submit(
  role: CheckpointRole,
  inspection: Inspection,
  args: Record<string, unknown>,
): Outcome {
  // Some providers encode a nested object as JSON text. Decode that transport
  // representation once; the exact same strict schema/citation checks follow.
  if (typeof args.checkpoint === "string") {
    args = { ...args, checkpoint: JSON.parse(args.checkpoint) as unknown };
  }
  const archive = inspection.archive;
  if (role === "builder") {
    inspection.requireCompletion();
    inspection.requireCoverage(args.coverageEndEntryId);
    const answer = JSON.stringify({ checkpoint: args.checkpoint, coverageEndEntryId: args.coverageEndEntryId });
    parseSubmission(answer, archive, inspection.servedRefs);
    return { done: true, answer };
  }
  if (inspection.readCalls < 1) {
    throw new Error("inspect session history with at least one read tool before submitting a verdict");
  }
  const reason = typeof args.reason === "string" ? args.reason : "";
  if (args.verdict === "accept" || args.verdict === "unusable") {
    // An unusable verdict is the verifier's answer; the mod fails closed on it.
    return { done: true, answer: JSON.stringify({ verdict: args.verdict, reason }) };
  }
  if (args.verdict === "repair") {
    inspection.requireCoverage(args.coverageEndEntryId);
    const repaired = JSON.stringify({ checkpoint: args.checkpoint, coverageEndEntryId: args.coverageEndEntryId });
    parseSubmission(repaired, archive, inspection.servedRefs);
    return {
      done: true,
      answer: JSON.stringify({ verdict: "repair", checkpoint: args.checkpoint, coverageEndEntryId: args.coverageEndEntryId, reason }),
    };
  }
  throw new Error('verdict must be "accept", "repair", or "unusable"');
}

export interface AgentRun {
  role: CheckpointRole;
  model: Pick<Model<Api>, "provider" | "id" | "contextWindow">;
  system: string;
  prompt: string;
  archive: EvidenceArchive;
  complete: CompleteFn;
  signal: AbortSignal;
}

export interface AgentResult {
  answer: string;
  usage: PiUsage;
  toolRounds: number;
}

/** Thrown with the usage spent so far, so failures still report cost. */
export class AgentError extends Error {
  constructor(message: string, readonly usage: PiUsage) {
    super(message);
    this.name = "AgentError";
  }
}

/** Runs one role to a checked submission or a bounded failure. */
export async function runCheckpointAgent(run: AgentRun): Promise<AgentResult> {
  const inspection = new Inspection(run.archive);
  const pageChars = readPageChars(run.model);
  const budget = transcriptBudgetChars(run.model);
  const tools = [...READ_TOOLS, run.role === "builder" ? SUBMIT_CHECKPOINT_TOOL : SUBMIT_VERDICT_TOOL];
  const submitName = tools.at(-1)!.name;
  const maxRounds = run.role === "builder" ? BUILDER_MAX_ROUNDS : VERIFIER_MAX_ROUNDS;
  const label = `${run.role} (${run.model.provider}/${run.model.id})`;
  const usage: PiUsage = { totalTokens: 0, cost: 0 };
  const fail = (message: string): never => {
    throw new AgentError(`${label}: ${message}`, usage);
  };
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: run.prompt }], timestamp: Date.now() },
  ];
  const systemPrompt = `${run.system}\n${TOOL_ANSWER_NOTE[run.role]}`;
  const readResults: ToolResultMessage[] = [];
  let submitAttempts = 0;
  let textOnlyRetries = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    if (run.signal.aborted) fail("deadline reached");
    let response: AssistantMessage;
    try {
      response = await run.complete({ systemPrompt, messages, tools }, { signal: run.signal });
    } catch (error) {
      return fail(`request failed: ${sanitizeForContext(error instanceof Error ? error.message : String(error), "").slice(0, 500)}`);
    }
    usage.totalTokens += response.usage?.totalTokens ?? 0;
    usage.cost += response.usage?.cost?.total ?? 0;
    if (run.signal.aborted) fail("deadline reached");
    if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
      const detail = response.errorMessage ? `: ${sanitizeForContext(response.errorMessage, "").slice(0, 500)}` : "";
      fail(`stopped with ${response.stopReason}${detail}`);
    }
    messages.push(response);
    const calls = response.content.filter((block): block is ToolCall => block.type === "toolCall");
    if (calls.length === 0) {
      if (textOnlyRetries >= 1) fail("returned text without a tool call");
      textOnlyRetries += 1;
      messages.push({
        role: "user",
        content: [{ type: "text", text: `Your response contained no tool call. Continue with the read tools, then terminate with ${submitName}.` }],
        timestamp: Date.now(),
      });
      continue;
    }
    const roundReads: ToolResultMessage[] = [];
    for (const call of calls) {
      const args = call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
        ? (call.arguments as Record<string, unknown>)
        : {};
      let outcome: Outcome;
      if (call.name === submitName) {
        submitAttempts += 1;
        try {
          if (call.argumentsError) throw new Error(call.argumentsError);
          outcome = submit(run.role, inspection, args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (submitAttempts >= MAX_SUBMIT_ATTEMPTS) fail(`${submitName} rejected ${submitAttempts} times: ${message}`);
          outcome = { done: false, text: `${submitName} rejected: ${message}. Pass checkpoint as an object, not text. Every section is an array of {text, evidenceRefs} objects; verificationState adds status (verified or unverified). File paths belong in text. Keep the already-inspected evidence; correct the submission arguments.`, isError: true };
        }
      } else {
        try {
          outcome = { done: false, text: JSON.stringify(executeReadTool(inspection, pageChars, call.name, args)), isError: false };
        } catch (error) {
          outcome = { done: false, text: error instanceof Error ? error.message : String(error), isError: true };
        }
      }
      if (outcome.done) {
        return { answer: outcome.answer, usage, toolRounds: round + 1 };
      }
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: outcome.text }],
        isError: outcome.isError,
        timestamp: Date.now(),
      };
      messages.push(result);
      if (!outcome.isError && call.name !== "session_manifest") roundReads.push(result);
    }
    // Keep this round's reads; elide the oldest until the transcript fits.
    let total = messages.reduce((sum, message) => sum + chars(message), 0);
    while (total > budget && readResults.length > 0) {
      const oldest = readResults.shift()!;
      const before = chars(oldest);
      elide(oldest);
      total -= before - chars(oldest);
    }
    readResults.push(...roundReads);
  }
  return fail(`exceeded ${maxRounds} tool rounds`);
}

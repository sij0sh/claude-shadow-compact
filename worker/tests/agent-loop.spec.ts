import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { EvidenceArchive } from "../../hooks/evidence.js";
import { prepareCheckpoint, type AskFn } from "../../hooks/prepare.js";
import { PI_EVIDENCE_ACCESS } from "../../hooks/pi-protocol.js";
import { AgentError, archiveFromFile, executeReadTool, Inspection, runCheckpointAgent, type CompleteFn } from "../agent-loop.js";

const MODEL = { provider: "test", id: "scripted", contextWindow: 200_000 };

function archive(previous?: { summary: string; coverage: string }): EvidenceArchive {
  const rows: Array<[string, "user" | "assistant", string]> = [
    ["u1", "user", "build the parser"],
    ["a1", "assistant", "parser started in src/parse.ts"],
    ["u2", "user", "no, use the streaming API instead"],
    ["a2", "assistant", "switched to the streaming API"],
    ["u3", "user", "now add tests"],
    ["a3", "assistant", "tests added, not run yet"],
  ];
  const built = new EvidenceArchive("/repo");
  for (const [id, role, text] of rows) {
    built.add({ id, evidenceId: "", role, door: "prompt", text, toolNames: [], hasToolResult: false, isError: false });
  }
  if (previous) built.setPreviousCheckpoint(previous.summary, previous.coverage);
  return built;
}

function checkpoint(ref: string) {
  return {
    objective: [{ text: "Build the parser on the streaming API", evidenceRefs: [ref] }],
    verificationState: [{ text: "Tests not run", status: "unverified", evidenceRefs: [ref] }],
    continuationState: {
      currentGoal: "Streaming parser",
      currentApproach: "Streaming API",
      immediateNextStep: "Run the tests",
    },
  };
}

let callId = 0;

function respond(calls: Array<[string, Record<string, unknown>]>, text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map(([name, args]) => ({ type: "toolCall" as const, id: `call-${++callId}`, name, arguments: args as never })),
    ],
    api: "openai-completions",
    provider: "test",
    model: "scripted",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    },
    stopReason: calls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

/** Plays responses in order and records every context it was sent. */
function script(...responses: AssistantMessage[]): { complete: CompleteFn; contexts: Context[] } {
  const contexts: Context[] = [];
  return {
    contexts,
    complete: async (context) => {
      contexts.push(structuredClone(context));
      const next = responses.shift();
      assert.ok(next, "script ran out of responses");
      return next;
    },
  };
}

const signal = new AbortController().signal;
const readAll = respond([["read_turn_range", { startTurn: 1, count: 3 }]]);

function lastToolText(context: Context): string {
  const result = [...context.messages].reverse().find((message) => message.role === "toolResult");
  assert.ok(result && result.role === "toolResult");
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("pi worker agent loop", () => {
  test("a builder that reads the session submits a checked answer", async () => {
    const { complete, contexts } = script(
      readAll,
      respond([["submit_checkpoint", { checkpoint: checkpoint("E0002"), coverageEndEntryId: "a3" }]]),
    );
    const result = await runCheckpointAgent({ role: "builder", model: MODEL, system: "sys", prompt: "go", archive: archive(), complete, signal });
    assert.equal(result.toolRounds, 2);
    assert.deepEqual(result.usage, { totalTokens: 200, cost: 0.002 });
    assert.deepEqual(JSON.parse(result.answer).coverageEndEntryId, "a3");
    // The role prompt is kept and only told to answer through the tool.
    assert.match(contexts[0]!.systemPrompt!, /^sys\n.*submit_checkpoint/);
    assert.deepEqual(contexts[0]!.tools!.map((tool) => tool.name).sort(), [
      "get_previous_checkpoint", "read_rows", "read_session_turn", "read_turn_range",
      "search_session_history", "session_manifest", "submit_checkpoint",
    ]);
  });

  test("submitting before reading the required turns is rejected and can be fixed", async () => {
    const submitA3 = respond([["submit_checkpoint", { checkpoint: checkpoint("E0001"), coverageEndEntryId: "a3" }]]);
    const { complete, contexts } = script(submitA3, readAll, submitA3);
    const result = await runCheckpointAgent({ role: "builder", model: MODEL, system: "sys", prompt: "go", archive: archive(), complete, signal });
    assert.match(lastToolText(contexts[1]!), /inspection requirements unmet.*turn-1/);
    assert.equal(result.toolRounds, 3);
  });

  test("citations are limited to rows this agent was served", async () => {
    // Coverage through a2 is already checkpointed: turn-2 is not required.
    const prior = archive({ summary: "# Continuation Checkpoint\n- earlier", coverage: "a2" });
    const { complete, contexts } = script(
      respond([["read_session_turn", { turnId: "turn-1" }], ["read_session_turn", { turnId: "turn-3" }]]),
      respond([["submit_checkpoint", { checkpoint: checkpoint("E0003"), coverageEndEntryId: "a3" }]]),
      respond([["get_previous_checkpoint", {}]]),
      respond([["submit_checkpoint", { checkpoint: checkpoint("E0000"), coverageEndEntryId: "a3" }]]),
    );
    const result = await runCheckpointAgent({ role: "builder", model: MODEL, system: "sys", prompt: "go", archive: prior, complete, signal });
    assert.match(lastToolText(contexts[2]!), /Unknown evidence reference.*E0003/);
    assert.equal(JSON.parse(result.answer).checkpoint.objective[0].evidenceRefs[0], "E0000");
  });

  test("coverage cannot claim rows the agent never read", async () => {
    const prior = archive({ summary: "# Continuation Checkpoint\n- earlier", coverage: "a2" });
    const inspection = new Inspection(prior);
    executeReadTool(inspection, 24_000, "read_session_turn", { turnId: "turn-1" });
    executeReadTool(inspection, 24_000, "read_rows", { start: 4, count: 1 });
    assert.throws(() => inspection.requireCoverage("a3"), /claims 1 unread row.*E0006/);
    assert.throws(() => inspection.requireCoverage("a1"), /regresses/);
    assert.throws(() => inspection.requireCompletion(), /turn-3/);
    executeReadTool(inspection, 24_000, "read_rows", { start: 5, count: 1 });
    inspection.requireCoverage("a3");
    inspection.requireCompletion();
    // Search snippets are never citable evidence.
    const fresh = new Inspection(prior);
    const hits = executeReadTool(fresh, 24_000, "search_session_history", { query: "streaming" }) as { hits: unknown[] };
    assert.equal(hits.hits.length, 2);
    assert.equal(fresh.servedRefs.size, 0);
  });

  test("three rejected submissions fail with the usage spent", async () => {
    const bad = respond([["submit_checkpoint", { checkpoint: { objective: "x" }, coverageEndEntryId: "a3" }]]);
    const { complete } = script(readAll, bad, bad, bad);
    await assert.rejects(
      runCheckpointAgent({ role: "builder", model: MODEL, system: "sys", prompt: "go", archive: archive(), complete, signal }),
      (error: unknown) => error instanceof AgentError && /rejected 3 times/.test(error.message) && error.usage.totalTokens === 400,
    );
  });

  test("text without a tool call is nudged once, then fails", async () => {
    const { complete } = script(respond([], "here is my summary"), respond([], "still prose"));
    await assert.rejects(
      runCheckpointAgent({ role: "builder", model: MODEL, system: "sys", prompt: "go", archive: archive(), complete, signal }),
      /returned text without a tool call/,
    );
  });

  test("a provider error stops the run", async () => {
    const failed = { ...respond([]), stopReason: "error", errorMessage: "429 rate limited" } as AssistantMessage;
    const { complete } = script(failed);
    await assert.rejects(
      runCheckpointAgent({ role: "verifier", model: MODEL, system: "sys", prompt: "go", archive: archive(), complete, signal }),
      /verifier \(test\/scripted\): stopped with error: 429 rate limited/,
    );
  });

  test("the verifier must read before its verdict; unusable passes back to Shadow", async () => {
    const unusable = respond([["submit_verdict", { verdict: "unusable", reason: "no evidence" }]]);
    const { complete, contexts } = script(unusable, respond([["read_rows", { start: 0, count: 6 }]]), unusable);
    const result = await runCheckpointAgent({ role: "verifier", model: MODEL, system: "sys", prompt: "go", archive: archive(), complete, signal });
    assert.match(lastToolText(contexts[1]!), /at least one read tool/);
    assert.deepEqual(JSON.parse(result.answer), { verdict: "unusable", reason: "no evidence" });
  });

  test("old reads are elided to fit a small context but stay inspected", async () => {
    const big = new EvidenceArchive("/repo");
    for (let i = 0; i < 6; i += 1) {
      big.add({ id: `r${i}`, evidenceId: "", role: i % 2 ? "assistant" : "user", door: "prompt", text: `${i} ${"x".repeat(3_900)}`, toolNames: [], hasToolResult: false, isError: false });
    }
    const small = { ...MODEL, contextWindow: 8_000 };
    const reads = [0, 1, 2, 3, 4, 5].map((start) => respond([["read_rows", { start, count: 1 }]]));
    const { complete, contexts } = script(
      ...reads,
      respond([["submit_checkpoint", { checkpoint: checkpoint("E0001"), coverageEndEntryId: "r5" }]]),
    );
    const result = await runCheckpointAgent({ role: "builder", model: small, system: "sys", prompt: "go", archive: big, complete, signal });
    assert.equal(result.toolRounds, 7);
    assert.match(JSON.stringify(contexts.at(-1)!.messages), /"elided\\":true/);
  });

  test("worker answers pass Shadow's own preparation and render", async () => {
    const snapshot = archive();
    const file = { rows: snapshot.rows, previousCheckpoint: null, previousCoverageEndEntryId: null };
    const builder = script(readAll, respond([["submit_checkpoint", { checkpoint: checkpoint("E0004"), coverageEndEntryId: "a3" }]]));
    const verifier = script(readAll, respond([["submit_verdict", { verdict: "accept", reason: "grounded" }]]));
    const ask: AskFn = async (request) => {
      const { complete } = request.role === "builder" ? builder : verifier;
      const result = await runCheckpointAgent({ role: request.role, model: MODEL, system: request.system, prompt: request.prompt, archive: archiveFromFile(file), complete, signal });
      return result.answer;
    };
    const prepared = await prepareCheckpoint(ask, snapshot, PI_EVIDENCE_ACCESS, { builder: "pi", verifier: "pi" });
    assert.equal(prepared.coverageEndEntryId, "a3");
    assert.match(prepared.rendered, /Build the parser on the streaming API \[E0004\]/);
    assert.match(JSON.stringify(builder.contexts[0]!.messages[0]), /read_turn_range/);
  });
});

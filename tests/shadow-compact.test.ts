import { describe, expect, test } from "claude-code/testing";
import type { EngineInterface, On, SessionMeasureInput, SessionMessage } from "claude-code";
import {
  renderCheckpoint,
  validateCheckpointObject,
  type Checkpoint,
} from "../hooks/checkpoint.js";
import { decideAutoCompactWindow, decideIdleCompaction, isAtOrAbove, resolveConfig, PREPARE_TIMEOUT_SECONDS, RECENT_ROUNDS, type WindowFacts } from "../hooks/config.js";
import { EvidenceArchive } from "../hooks/evidence.js";
import { redactSecretValue, sanitizeForContext } from "../hooks/normalize.js";
import { BUILDER_SYSTEM_PROMPT, VERIFIER_SYSTEM_PROMPT, prepareCheckpoint, parseSubmission, emptyPreparationMetrics, type AskFn } from "../hooks/prepare.js";
import { completionText } from "../hooks/claude-backend.js";
import type { ClaudeRunRequest } from "../hooks/claude-protocol.js";
import { register } from "../hooks/register.js";
import { ShadowState, type PublishedCheckpoint } from "../hooks/state.js";
import { buildCandidate, hasOrphanedToolResult, isSkipped } from "../hooks/working-context.js";
import { LiveTranscript, messageFromAppend, isTranscriptRow, prefixDigest, messageIdentity } from "../hooks/transcript.js";

function archiveWith(rows: Array<[string, "user" | "assistant", string]>): EvidenceArchive {
  const archive = new EvidenceArchive("/repo");
  for (const [id, role, text] of rows) {
    archive.add({
      id,
      evidenceId: "",
      role,
      door: "prompt",
      text,
      toolNames: [],
      hasToolResult: false,
      isError: false,
    });
  }
  return archive;
}

function checkpointJson(ref: string): Record<string, unknown> {
  return {
    objective: [{ text: "Port shadow compact", evidenceRefs: [ref] }],
    nextActions: [{ text: "Wire the compact hook", evidenceRefs: [ref] }],
    verificationState: [{ text: "Nothing verified yet", status: "unverified", evidenceRefs: [ref] }],
    continuationState: {
      currentGoal: "Port shadow compact",
      currentApproach: "Mod with private agents",
      immediateNextStep: "Wire the compact hook",
    },
  };
}

describe("checkpoint schema", () => {
  test("validates and renders a checkpoint citing served evidence", async () => {
    const checkpoint = validateCheckpointObject(checkpointJson("E0001"), new Set(["E0001"]));
    const rendered = renderCheckpoint(checkpoint, "r1");
    expect(rendered).toContain("# Continuation Checkpoint");
    expect(rendered).toContain("Covers the session through entry r1");
    // Citations survive rendering.
    expect(rendered).toContain("- Port shadow compact [E0001]");
    expect(rendered).toContain("[unverified] Nothing verified yet [E0001]");
    expect(rendered).toContain("Next: Wire the compact hook");
  });

  test("fails closed on unknown evidence refs and unexpected keys", async () => {
    expect(() => validateCheckpointObject(checkpointJson("E9999"), new Set(["E0001"]))).toThrow(
      /Unknown evidence reference/,
    );
    const bad = { ...checkpointJson("E0001"), bogus: [] };
    expect(() => validateCheckpointObject(bad, new Set(["E0001"]))).toThrow(/Unexpected checkpoint key/);
  });
});

describe("sanitization", () => {
  test("preserves code and JSON escapes while normalizing only the working directory", () => {
    const code = String.raw`{"content":"import x from \"./file\";\nconst re = /\d+\s/;","path":"/repo/src/file.ts"}`;
    expect(sanitizeForContext(code, "/repo")).toBe(code.replace("/repo/", "./"));
    expect(sanitizeForContext(String.raw`C:\work\repo\src\file.ts and \n\d`, String.raw`C:\work\repo`))
      .toBe(String.raw`.\src\file.ts and \n\d`);
  });
  test("redacts enumerated and unenumerated secret variants", async () => {
    expect(sanitizeForContext("API_KEY=abc123", "")).toContain("[REDACTED]");
    // A long-form variant the explicit patterns do not enumerate by name:
    // the value still belongs to the protected class and must not pass.
    expect(sanitizeForContext("refresh_token: hunter2hunter2", "")).not.toContain("hunter2");
    expect(sanitizeForContext("Authorization: Bearer abc.def.ghi", "")).not.toContain("abc.def");
    const redacted = redactSecretValue({ refreshTokenValue: "x", count: 3 }) as Record<string, unknown>;
    expect(redacted.refreshTokenValue).toBe("[REDACTED]");
    expect(redacted.count).toBe(3);
  });
});

describe("evidence archive", () => {
  test("role-bearing attachments and meta rows cannot become coverage anchors or inflate turns", () => {
    const archive = archiveWith([["u", "user", "task"], ["a", "assistant", "answer"]]);
    archive.addAppend("reminder", "attachment", { type: "attachment", role: "user", content: [{ type: "text", text: "environment" }] });
    archive.addAppend("meta", "delivery", { type: "user", role: "user", isMeta: true, content: [{ type: "text", text: "reminder" }] });
    expect(archive.manifest().turnCount).toBe(1);
    expect(archive.manifest().lastTranscriptRowId).toBe("a");
    for (const coverage of ["reminder", "meta"]) {
      expect(() => parseSubmission(JSON.stringify({ checkpoint: checkpointJson("E0001"), coverageEndEntryId: coverage }), archive)).toThrow(/must name a user or assistant row/);
    }
  });
  test("manifest flags required turns", async () => {
    const archive = archiveWith([
      ["r1", "user", "build the thing"],
      ["r2", "assistant", "working on it"],
      ["r3", "user", "no, use the other API instead"],
      ["r4", "assistant", "switched to other API"],
    ]);
    const manifest = archive.manifest();
    expect(manifest.turnCount).toBe(2);
    expect(manifest.requiredTurnIds).toContain("turn-1");
    expect(archive.rows[2]?.evidenceId).toBe("E0003");
    expect(archive.knownRefs().has("E0004")).toBe(true);
  });

  test("only the person's prompts count as user corrections", async () => {
    const archive = new EvidenceArchive("/repo");
    const say = (text: string) => ({ type: "user", role: "user", content: [{ type: "text", text }] });
    archive.addAppend("r1", "prompt", say("build the thing"), "composer");
    // A subagent hand-back arrives as a user-role row full of "should"/"no".
    archive.addAppend("r2", "prompt", say('{"checkpoint": "you should never do that"}'), "task-notification");
    archive.addAppend("r3", "prompt", say("no, use the other API instead"), "composer");
    const turns = archive.manifest().turns;
    expect(turns.map((turn) => turn.hasUserCorrection)).toEqual([false, false, true]);
  });
});

function message(role: "user" | "assistant", text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

describe("working context", () => {
  const long = "evidence detail ".repeat(40);
  const messages: SessionMessage[] = [
    message("user", `start ${long}`),
    message("assistant", `first answer ${long}`),
    message("user", `second ask ${long}`),
    message("assistant", "tool time", {
      toolUses: [{ tool_use_id: "t1", tool: "Read", input: {}, text: "read ok" }],
    }),
    message("user", "", { toolResults: [{ tool_use_id: "t1", text: "file body", isError: false }] }),
    message("assistant", "done"),
    message("user", "latest ask"),
    message("assistant", "latest answer"),
  ];

  const handled = messages.map((entry, index) => ({ ...entry, handle: `h${index}` }));

  test("candidate keeps checkpoint plus exact tail with handles", async () => {
    const built = buildCandidate(handled, 1, 2, "# Continuation Checkpoint\n\n- state");
    expect(isSkipped(built)).toBe(false);
    if (!isSkipped(built) && built.messages) {
      expect(built.messages[0]?.text).toContain("Continuation Checkpoint");
      expect(built.messages[0]?.handle).toBe(undefined);
      // Tail starts at a turn boundary, never splitting the tool pair.
      expect(built.tailStart).toBe(2);
      expect(built.messages.slice(1)).toEqual(handled.slice(2));
      expect(hasOrphanedToolResult(built.messages.slice(1))).toBe(false);
    }
  });

  test("coverage ending inside a turn keeps that whole turn", async () => {
    // Covered through index 2 (a user ask); index 3 is its uncovered reply.
    const built = buildCandidate(handled, 2, 1, "# Continuation Checkpoint\n\n- state");
    expect(isSkipped(built)).toBe(false);
    if (!isSkipped(built)) {
      // Never past the first uncovered message: the turn starting at 2 stays.
      expect(built.tailStart).toBe(2);
      expect(built.messages?.slice(1).map((entry) => entry.handle)).toEqual(["h2", "h3", "h4", "h5", "h6", "h7"]);
    }
    // Covered through 3 (mid tool turn): the tail still starts at that turn.
    const midTool = buildCandidate(handled, 3, 1, "# Continuation Checkpoint");
    expect(!isSkipped(midTool) && midTool.tailStart).toBe(2);
    // Fully covered: only the recent-turn minimum is kept.
    const all = buildCandidate(handled, 7, 1, "# Continuation Checkpoint");
    expect(!isSkipped(all) && all.tailStart).toBe(6);
  });

  test("a single long agentic turn compacts by assistant/tool rounds", async () => {
    const agentic: SessionMessage[] = [message("user", `one prompt ${long}`)];
    for (let i = 0; i < 6; i += 1) {
      agentic.push(message("assistant", `step ${i} ${long}`, {
        toolUses: [{ tool_use_id: `t${i}`, tool: "Read", input: {}, text: "read" }],
      }));
      agentic.push(message("user", "", { toolResults: [{ tool_use_id: `t${i}`, text: `body ${long}`, isError: false }] }));
    }
    agentic.push(message("assistant", "final"));
    // Covered through the 4th tool result (index 8); keep 2 rounds.
    const built = buildCandidate(agentic, 8, 2, "# Continuation Checkpoint");
    expect(isSkipped(built)).toBe(false);
    if (!isSkipped(built)) {
      // Rounds start at 0, 1, 3, 5, 7, 9, 11, 13: the last two are 11 and 13.
      expect(built.tailStart).toBe(9);
      expect(hasOrphanedToolResult(built.messages!.slice(1))).toBe(false);
    }
    // Coverage mid-round (the call at 9, its result uncovered) keeps that round whole.
    const mid = buildCandidate(agentic, 9, 1, "# Continuation Checkpoint");
    expect(!isSkipped(mid) && mid.tailStart).toBe(9);
  });

  test("stale coverage and no-savings candidates are refused", async () => {
    expect(isSkipped(buildCandidate(messages, 99, 2, "x"))).toBe(true);
    const tiny: SessionMessage[] = [message("user", "hi"), message("assistant", "hello")];
    const built = buildCandidate(tiny, 0, 10, "# Continuation Checkpoint\n\n" + "padding ".repeat(200));
    expect(isSkipped(built)).toBe(true);
  });

  test("orphan guard detects a result without its call", async () => {
    const orphan: SessionMessage[] = [
      message("user", "", { toolResults: [{ tool_use_id: "nope", text: "x", isError: false }] }),
    ];
    expect(hasOrphanedToolResult(orphan)).toBe(true);
  });
});

describe("state machine", () => {
  const published = (id: string): PublishedCheckpoint => ({
    checkpointId: id,
    rendered: "# Continuation Checkpoint",
    coverageEndEntryId: "r1",
    validation: { deterministic: "passed", independent: "accepted" },
    proof: { sessionId: "test", epoch: 1, snapshotId: "test", coveredCount: 1, prefixDigest: "test", evidenceDigest: "test" },
  });

  test("generations gate stale publishes and rearm needs install", async () => {
    const state = new ShadowState();
    const first = state.startPreparing();
    expect(first).toBe(1);
    expect(state.startPreparing()).toBe(undefined);
    state.reset();
    // A stale completion from the reset generation cannot publish.
    expect(state.publish(first!, published("a"))).toBe(false);
    const second = state.startPreparing();
    expect(state.publish(second!, published("b"))).toBe(true);
    expect(state.phase).toBe("ready");
    expect(state.refreshArmed).toBe(false);
    expect(state.rearm()).toBe(true);
  });

  test("an install counts only once canonical history confirms it", async () => {
    const state = new ShadowState();
    state.publish(state.startPreparing()!, published("a"));
    state.attemptInstall();
    expect(state.phase).toBe("installing");
    expect(state.installCount).toBe(0);
    expect(state.confirmInstall()).toBe(true);
    expect(state.phase).toBe("installed");
    expect(state.installCount).toBe(1);
    state.attemptInstall();
    state.rejectInstall();
    expect(state.installCount).toBe(1);
  });

  test("a failed preparation does not re-arm itself", async () => {
    const state = new ShadowState();
    expect(state.fail(state.startPreparing()!)).toBe(true);
    expect(state.refreshArmed).toBe(false);
  });

  test("a draft cannot publish without independent verification", () => {
    const state = new ShadowState();
    const generation = state.startPreparing()!;
    const candidate = { ...published("unverified"), validation: { deterministic: "passed", independent: "skipped" } } as unknown as PublishedCheckpoint;
    expect(state.publish(generation, candidate)).toBe(false);
    expect(state.preparing).toBe(true);
    expect(state.publish(generation, published("verified"))).toBe(true);
    expect(state.phase).toBe("ready");
    state.rearm();
    state.startPreparing();
    expect(state.phase).toBe("refreshing");
  });
});

describe("prepare pipeline", () => {
  const rows: Array<[string, "user" | "assistant", string]> = [
    ["r1", "user", "build the thing"],
    ["r2", "assistant", "built it"],
  ];

  test("builder then verifier accept yields a rendered checkpoint", async () => {
    const archive = archiveWith(rows);
    const ask = async (request: { system: string; prompt: string; model: string }) => {
      if (request.system.includes("create evidence-grounded")) {
        return JSON.stringify({ checkpoint: checkpointJson("E0001"), coverageEndEntryId: "r2" });
      }
      return JSON.stringify({ verdict: "accept", reason: "grounded" });
    };
    const prepared = await prepareCheckpoint(ask, archive, "evidence inline", "inherit");
    expect(prepared.coverageEndEntryId).toBe("r2");
    expect(prepared.rendered).toContain("Port shadow compact");
  });

  test("verifier unusable verdict fails closed", async () => {
    const archive = archiveWith(rows);
    const ask = async (request: { system: string }) => {
      if (request.system.includes("create evidence-grounded")) {
        return JSON.stringify({ checkpoint: checkpointJson("E0001"), coverageEndEntryId: "r2" });
      }
      return JSON.stringify({ verdict: "unusable", reason: "no evidence" });
    };
    await expect(
      prepareCheckpoint(ask, archive, "evidence inline", "inherit"),
    ).rejects.toThrow(/unusable/);
  });

  test("builder retries once on a validation error", async () => {
    const archive = archiveWith(rows);
    let builderCalls = 0;
    const ask = async (request: { system: string }) => {
      if (request.system.includes("create evidence-grounded")) {
        builderCalls += 1;
        if (builderCalls === 1) return "not json at all";
        return JSON.stringify({ checkpoint: checkpointJson("E0002"), coverageEndEntryId: "r2" });
      }
      return JSON.stringify({ verdict: "accept", reason: "ok" });
    };
    const prepared = await prepareCheckpoint(ask, archive, "evidence inline", "inherit");
    expect(builderCalls).toBe(2);
    expect(prepared.coverageEndEntryId).toBe("r2");
  });

  test("rows appended mid-preparation stay out of the snapshot", async () => {
    const live = archiveWith(rows);
    const snapshot = live.snapshot(live.size - 1);
    const verifierPrompts: string[] = [];
    const ask = async (request: { system: string; prompt: string }) => {
      if (request.system.includes("create evidence-grounded")) {
        // The builder's hand-back and a new turn land in the live archive.
        live.addAppend("r3", "prompt", { type: "user", role: "user", content: [] }, "task-notification");
        live.addAppend("r4", "response", { type: "assistant", role: "assistant", content: [] });
        return JSON.stringify({ checkpoint: checkpointJson("E0002"), coverageEndEntryId: "r2" });
      }
      verifierPrompts.push(request.prompt);
      if (verifierPrompts.length === 1) {
        return JSON.stringify({ verdict: "repair", checkpoint: checkpointJson("E0004"), coverageEndEntryId: "r4" });
      }
      return JSON.stringify({ verdict: "accept", reason: "ok" });
    };
    const prepared = await prepareCheckpoint(ask, snapshot, "evidence inline", "inherit");
    expect(live.size).toBe(4);
    expect(verifierPrompts[0]).toContain('"rowCount":2');
    expect(verifierPrompts[0]).toContain('"lastRowId":"r2"');
    // A repair citing a row the agents never saw is rejected and retried.
    expect(verifierPrompts[1]).toContain("Unknown evidence reference");
    expect(prepared.coverageEndEntryId).toBe("r2");
  });
});

describe("checkpoint integrity", () => {
  const lowArchive = () => archiveWith([["r1", "user", "Port shadow compact"], ["r2", "assistant", "Working on the compact hook"]]);
  const submission = (checkpoint = checkpointJson("E0001"), coverage = "r2") => JSON.stringify({ checkpoint, coverageEndEntryId: coverage });
  test("coverage integrity checks reject regression, forward citations and missing previous evidence", () => {
    const archive = lowArchive();
    expect(() => parseSubmission(submission(checkpointJson("E0002"), "r1"), archive)).toThrow("beyond coverageEndEntryId");
    archive.setPreviousCheckpoint("Previous continuation checkpoint", "r2");
    expect(() => parseSubmission(submission(checkpointJson("E0001"), "r1"), archive)).toThrow("regresses");
    archive.setPreviousCheckpoint("Previous continuation checkpoint", "missing-row");
    expect(() => parseSubmission(submission(), archive)).toThrow("absent from the evidence snapshot");
  });

  test("render size is checked before independent verification", async () => {
    const metrics = emptyPreparationMetrics();
    const oversized = { ...checkpointJson("E0001"), currentState: Array.from({ length: 10 }, () => ({ text: "context ".repeat(950), evidenceRefs: ["E0001"] })) };
    await expect(prepareCheckpoint(async () => submission(oversized), lowArchive(), "inline", "haiku", undefined, { metrics })).rejects.toThrow("Rendered checkpoint exceeds");
    expect(metrics.verifierCalls).toBe(0);
  });

  test("a turn spanning the previous boundary is required and the index contains locations, not duplicate text", () => {
    const archive = lowArchive();
    archive.setPreviousCheckpoint("Prior checkpoint state", "r1");
    expect(archive.manifest().requiredTurnIds).toContain("turn-1");
    expect(archive.manifest().inspectionRanges).toEqual([{ start: 0, count: 2 }]);
    expect(archive.evidenceIndex()[1]).toMatchObject({ evidenceId: "E0002", entryId: "r2", position: 1, line: 2, turnId: "turn-1" });
    expect(JSON.stringify(archive.evidenceIndex())).not.toContain("Working on the compact hook");
    archive.addAppend("r3", "response", { type: "assistant", content: [] });
    expect(archive.evidenceIndex().length).toBe(3);
    expect(archive.manifest().rowCount).toBe(3);
  });
});

type Reply = (request: { system: string; prompt: string }) => string;

interface HostFakes {
  /** Answers isolated Claude worker calls; absent, the worker is unavailable. */
  workerReply?: Reply;
  /** Agent answers land only after this many host sleeps (a slow pipeline). */
  workerDelaySleeps?: number;
  /** Host `sleep` fails, as on a host without it or Node. */
  noSleep?: boolean;
  workerRunTimeMs?: number;
  workerResult?: (request: ClaudeRunRequest, answer: string) => object;
  historyRead?: (messages: SessionMessage[]) => Promise<SessionMessage[]>;
}

function host(options: Record<string, number | string | boolean> = {}, reply?: Reply, fakes: HostFakes = {}) {
  type Handler = ($: EngineInterface, e: any, next: (e: any) => Promise<any>) => any;
  const handlers = new Map<string, Handler>();
  const scheduled: Array<{ at: number; callback: () => void }> = [];
  const logs: string[] = [];
  let canonical: SessionMessage[] = [];
  let workerCalls = 0;
  let selfCompactions = 0;
  const files = new Map<string, string>();
  const completeRequests: Array<{ model: string; system: string; prompt: string; effort?: string; timeoutMs?: number }> = [];
  const commandNames: string[] = [];
  const claudeRuns: ClaudeRunRequest[] = [];
  const appended = new Set<string>();
  let now = 0;
  let sleeps = 0;
  const delayed: Array<{ at: number; deliver: () => Promise<void> }> = [];
  const fireTimers = () => {
    for (const due of scheduled.filter(timer => timer.at <= now)) {
      scheduled.splice(scheduled.indexOf(due), 1);
      due.callback();
    }
  };
  const on = ((event: string, ...args: unknown[]) => {
    const head = args.length >= 2 ? (args[0] as { command?: string }) : undefined;
    const key = head && typeof head.command === "string" ? `${event}:${head.command}` : event;
    handlers.set(key, args[args.length - 1] as Handler);
    return { catch: () => undefined };
  }) as On;
  const $ = {
    plugin: { root: "/plugin" },
    settings: { read: async () => ({}) },
    env: { get: async () => undefined, set: async () => undefined },
    session: {
      usage: async () => ({ context: { window: 1_000_000 } }),
      cwd: async () => "/repo",
      id: async () => "host-test",
      messages: async () => fakes.historyRead ? fakes.historyRead(canonical) : canonical,
      model: async () => "opus",
      compact: async () => {
        selfCompactions += 1;
        return { messages: [message("user", "native summary")] };
      },
    },
    clock: {
      after: (delay: number, callback: () => void) => scheduled.push({ at: now + delay, callback }),
      sleep: () => new Promise(() => undefined),
      now: async () => now,
    },
    command: { register: async (spec: { name: string }) => { commandNames.push(spec.name); return { command: spec.name }; }, run: async () => { throw new Error("Shadow must not run commands"); } },
    fs: {
      write: async (path: string, text: string) => { files.set(path, text); },
      read: async (path: string) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`ENOENT ${path}`);
        return text;
      },
    },
    process: {
      run: async (argv: string[], init: { stdin?: string }) => {
        if (argv[0] === "sleep" || argv[1] === "-e") {
          if (fakes.noSleep) throw new Error("ENOENT");
          for (let i = 0; i < 5; i += 1) await prefixDigest([], 0);
          sleeps += 1;
          now += Number(argv[1] ?? 1) * 1000 || 1000;
          fireTimers();
          for (const due of delayed.filter((entry) => entry.at <= sleeps)) {
            delayed.splice(delayed.indexOf(due), 1);
            await due.deliver();
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (argv[1] === "/plugin/dist/claude-checkpoint-worker.mjs") {
          workerCalls += 1;
          const request = JSON.parse(init.stdin!) as ClaudeRunRequest;
          claudeRuns.push(request);
          if (!fakes.workerReply) throw new Error("Worker unavailable in test");
          now += fakes.workerRunTimeMs ?? 0;
          fireTimers();
          const answer = fakes.workerReply(request);
          if (fakes.workerDelaySleeps !== undefined) {
            return new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
              delayed.push({ at: sleeps + fakes.workerDelaySleeps!, deliver: async () => {
                files.set(request.outputPath, JSON.stringify(fakes.workerResult?.(request, answer) ?? { nonce: request.nonce, ok: true, answer, durationMs: 1 }));
                resolve({ exitCode: 0, stdout: '{"ok":true}', stderr: "" });
              } });
            });
          }
          files.set(request.outputPath, JSON.stringify(fakes.workerResult?.(request, answer) ?? { nonce: request.nonce, ok: true, answer, durationMs: 1 }));
          return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
        }
        throw new Error(`Unexpected process: ${argv[0]}`);
      },
    },
    model: { complete: async (request: { model: string; system: string; prompt: string }) => {
      completeRequests.push(request);
      if (!reply) throw new Error("Models unavailable in test");
      return { isAnswered: true, text: reply(request), usage: {} };
    } },
    ui: { log: (text: string) => { logs.push(text); }, status: (text: string) => { logs.push(text); } },

  } as unknown as EngineInterface;
  register(on, options);
  const keep = (uuid: string, row: { type: string; role?: string; content: unknown; isMeta?: boolean }, door: string) => {
    if (isTranscriptRow(row) && !appended.has(uuid)) {
      const projected = messageFromAppend(row);
      if (door === "compaction") {
        if (!canonical[0] || messageIdentity(canonical[0]) !== messageIdentity(projected)) canonical = [projected];
      }
      else canonical.push(projected);
      appended.add(uuid);
    }
    return { uuid, message: row };
  };
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      for (let i = 0; i < 100; i += 1) await Promise.resolve();
      await prefixDigest([], 0);
    }
  };
  return {
    end: async () => { await handlers.get("session.end")!($, {}, async () => ({})); await settle(); },
    logs,
    settle,
    start: async () => handlers.get("session.start")!($, { cwd: "/repo" }, async () => ({ cwd: "/repo" })),
    get workerCalls() { return workerCalls; },
    files,
    completeRequests,
    commandNames,
    commandHandlers: [...handlers.keys()].filter(key => key.startsWith("command.run:")),
    events: () => [...files.entries()].filter(([path]) => path.includes("/events/")).map(([, text]) => JSON.parse(text)),
    claudeRuns,
    get selfCompactions() { return selfCompactions; },
    get sleeps() { return sleeps; },
    /** Delivers every held agent answer, as a slow pipeline finishing late. */
    deliverLate: async () => {
      for (const due of delayed.splice(0)) await due.deliver();
      await settle();
    },
    setCanonical: (messages: SessionMessage[]) => { canonical = messages; },
    appendRow: (uuid: string, row: { type: string; role?: string; content: unknown; isMeta?: boolean }, door = "attachment") =>
      handlers.get("session.append")!($, { uuid, door, origin: { kind: "model" }, message: row }, async () => keep(uuid, row, door)),
    append: (uuid: string, role: "user" | "assistant", text: string, door = role === "user" ? "prompt" : "response") =>
      handlers.get("session.append")!(
        $,
        { uuid, door, origin: { kind: "composer" }, message: { type: role, role, content: [{ type: "text", text }] } },
        async (e) => keep(e.uuid, e.message, door),
      ),
    runCommand: (name: string) => handlers.get(`command.run:${name}`)!(
      $, {}, async () => ({}),
    ) as Promise<{ text: string }>,
    status: async () => ((await handlers.get("command.run:shadow-status")!($, {}, async () => ({}))) as { text: string }).text,
    measure: async (tokens?: number, percent = 0) => {
      await handlers.get("session.measure")!(
        $, { context: { window: 1_000_000, ...(tokens !== undefined ? { tokens } : {}), percent }, changed: ["context"], rateLimits: [] } as SessionMeasureInput,
        async (e) => ({ changed: e.changed }),
      );
      await settle();
    },
    complete: async () => { await handlers.get("turn.complete")!($, {}, async () => ({})); await settle(); },
    advance: async (ms: number) => { now += ms; fireTimers(); await settle(); },
    /** A compaction the engine starts; core answers with a one-message summary. */
    compact: async (
      messages: SessionMessage[],
      trigger = "auto",
      core: SessionMessage[] = [message("user", "native summary")],
      signal?: AbortSignal,
      remainingMs?: number,
      agentId?: string,
    ) => {
      canonical = [...messages];
      let coreCalls = 0;
      /** Whether the preparation was already cancelled when core began. */
      let cancelledBeforeCore = false;
      const next = Object.assign(
        async () => {
          coreCalls += 1;
          cancelledBeforeCore = [...files.keys()].some(path => path.endsWith("/cancel"));
          return { messages: core };
        },
        signal ? { signal } : {},
        remainingMs !== undefined ? { budget: { remainingMs } } : {},
      );
      const result = await handlers.get("session.compact")!($, { trigger, messages, agentId }, next);
      if (result.messages) canonical = [...result.messages];
      return { result: result as { messages?: SessionMessage[]; skip?: string }, coreCalls, cancelledBeforeCore };
    },
    flush: async () => {
      now += 50;
      fireTimers();
      await settle();
    },
  };
}


const longText = (label: string) => `${label} ${"detail ".repeat(220)}`;
const turns: Array<[string, "user" | "assistant", string]> = Array.from({ length: 20 }, (_, i) => [
  [`u${i + 1}`, "user", longText(`task ${i + 1}`)],
  [`a${i + 1}`, "assistant", longText(`answer ${i + 1}`)],
] as Array<[string, "user" | "assistant", string]>).flat();
const transcript = (rows = turns): SessionMessage[] => rows.map(([id, role, text]) => message(role, text, { handle: id }));
const covering = (coverage = "a18"): Reply => request => request.system === BUILDER_SYSTEM_PROMPT
  ? JSON.stringify({ checkpoint: checkpointJson("E0001"), coverageEndEntryId: coverage })
  : '{"verdict":"accept","reason":"grounded"}';
const coveringManifest: Reply = request => {
  if (request.system === VERIFIER_SYSTEM_PROMPT) return '{"verdict":"accept"}';
  const manifest = JSON.parse(request.prompt.split("Session manifest (start here):\n")[1]!.split("\n")[0]!);
  return JSON.stringify({ checkpoint: checkpointJson("E0001"), coverageEndEntryId: manifest.lastTranscriptRowId });
};
async function fill(h: ReturnType<typeof host>, rows = turns) {
  for (const [id, role, text] of rows) await h.append(id, role, text);
  await h.settle();
}
async function readyHost(coverage = "a18", options = {}, fakes: HostFakes = {}) {
  const h = host(options, undefined, { workerReply: covering(coverage), ...fakes });
  await fill(h);
  await h.measure(160_000);
  return h;
}

describe("three configuration preferences", () => {
  test("defaults are 160k, haiku, high and both roles share the preferences", async () => {
    expect(resolveConfig({})).toEqual({ prepareThresholdTokens: 160_000, checkpointModel: "haiku", checkpointEffort: "high" });
    const h = await readyHost("a18", { checkpointModel: "sonnet", checkpointEffort: "max" });
    expect(h.claudeRuns.map(run => [run.role, run.model, run.effort])).toEqual([["builder", "sonnet", "max"], ["verifier", "sonnet", "max"]]);
  });
  test("stored removed controls cannot disable verification, the hold, or internal limits", () => {
    expect(resolveConfig({ builderBackend: "pi", verificationMode: "adaptive", holdCompaction: false,
      recentTurns: 1, prepareTimeoutSeconds: 1, checkpointModel: " opus ", checkpointEffort: "low" }))
      .toEqual({ prepareThresholdTokens: 160_000, checkpointModel: "opus", checkpointEffort: "low" });
    expect(PREPARE_TIMEOUT_SECONDS).toBe(360);
    expect(RECENT_ROUNDS).toBe(10);
  });
  test("invalid thresholds and efforts use defaults; valid custom token counts survive", () => {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "bad", "", true]) {
      expect(resolveConfig({ prepareThresholdTokens: invalid }).prepareThresholdTokens).toBe(160_000);
    }
    expect(resolveConfig({ prepareThresholdTokens: "180000", checkpointEffort: "invalid", checkpointModel: " " }))
      .toEqual({ prepareThresholdTokens: 180_000, checkpointModel: "haiku", checkpointEffort: "high" });
    expect(isAtOrAbove({ tokens: 159_999, percent: 99 }, 160_000)).toBe(false);
    expect(isAtOrAbove({ tokens: 160_000 }, 160_000)).toBe(true);
    expect(isAtOrAbove({ percent: 100 }, 160_000)).toBe(false);
  });
  test("only status and the native escape hatch are registered", async () => {
    const h = host();
    await h.start();
    expect(h.commandNames).toEqual(["compact-native", "shadow-status"]);
    expect(h.commandHandlers).toEqual(["command.run:shadow-status", "command.run:compact-native"]);
    const status = await h.status();
    expect(status).toContain("Shadow Compact v0.4.11 · idle");
    expect(status).toContain("Model: haiku · effort: high · prepare: 160,000 tokens");
    expect(status.split("\n").length).toBe(5);
  });
});

describe("automatic window policy and migration", () => {
  const config = resolveConfig({});
  const facts = (patch: Partial<WindowFacts> = {}): WindowFacts => ({
    model: "test-model", modelWindow: 1_000_000, effectiveWindow: 1_000_000,
    source: "model-default", settings: {}, ...patch,
  });
  test("targets roughly 200k after headroom and caps at the actual model window", () => {
    expect(decideAutoCompactWindow(config, facts())).toEqual({ apply: true, tokens: 235_000 });
    expect(decideAutoCompactWindow(config, facts({ modelWindow: 200_000 }))).toEqual({ apply: true, tokens: 200_000 });
    expect(decideAutoCompactWindow(resolveConfig({ prepareThresholdTokens: 220_000 }), facts()))
      .toEqual({ apply: true, tokens: 295_000 });
    expect(decideAutoCompactWindow(config, facts({ modelWindow: NaN }))).toMatchObject({ apply: false });
  });
  test("migrates only a proven Shadow-managed per-model value", () => {
    const owned = facts({ source: "settings", effectiveWindow: 190_000, previousDecision: "applied:190000",
      settings: { modelSettings: { "test-model": { autoCompactWindow: 190_000 } } } });
    expect(decideAutoCompactWindow(config, owned)).toEqual({ apply: true, tokens: 235_000 });
    expect(decideAutoCompactWindow(config, { ...owned, previousDecision: undefined })).toMatchObject({ apply: false, reason: "kept-settings" });
    expect(decideAutoCompactWindow(config, { ...owned, effectiveWindow: 210_000 })).toMatchObject({ apply: false, reason: "kept-settings" });
    expect(decideAutoCompactWindow(config, { ...owned, source: "env" })).toMatchObject({ apply: false, reason: "kept-env" });
    expect(decideAutoCompactWindow(config, { ...owned, settings: { autoCompactWindow: 190_000, modelSettings: { "test-model": { autoCompactWindow: 190_000 } } } }))
      .toMatchObject({ apply: false, reason: "kept-settings" });
  });
  test("preserves explicit auto, independent settings, and changed managed values", () => {
    for (const value of ["auto", 190_000, 300_000]) {
      expect(decideAutoCompactWindow(config, facts({ settings: { modelSettings: { "test-model": { autoCompactWindow: value } } } })))
        .toMatchObject({ apply: false, reason: "kept-settings" });
    }
    expect(decideAutoCompactWindow(config, facts({ previousDecision: "applied:190000" })))
      .toMatchObject({ apply: false, reason: "kept-user-choice" });
    expect(decideAutoCompactWindow(config, facts({ source: "settings", effectiveWindow: 235_000,
      settings: { modelSettings: { "test-model": { autoCompactWindow: 235_000 } } },
      previousDecision: "applied:235000" }))).toMatchObject({ apply: false, reason: "managed" });
  });
  test("idle policy honors an explicit host floor or disabled native idle compaction", () => {
    expect(decideIdleCompaction({ envValue: undefined, settings: {} })).toEqual({ apply: true });
    expect(decideIdleCompaction({ envValue: "180000", settings: {} })).toMatchObject({ apply: false, reason: "kept-env 180000" });
    expect(decideIdleCompaction({ envValue: undefined, settings: { idleCompaction: false } })).toMatchObject({ apply: false, reason: "off-settings" });
  });
});

describe("checkpoint scheduling", () => {
  test("the exact threshold starts preparation and high context cannot spin duplicate work", async () => {
    const h = host({}, undefined, { workerReply: covering() });
    await fill(h);
    await h.measure(159_999);
    expect(h.workerCalls).toBe(0);
    await h.measure(160_000);
    expect(h.workerCalls).toBe(2);
    await h.measure(190_000);
    expect(h.workerCalls).toBe(2);
    expect(h.selfCompactions).toBe(0);
  });
  test("a custom threshold applies at the selected token boundary", async () => {
    const h = host({ prepareThresholdTokens: 180_000 }, undefined, { workerReply: covering() });
    await fill(h);
    await h.measure(179_999);
    expect(h.workerCalls).toBe(0);
    await h.measure(180_000);
    expect(h.workerCalls).toBe(2);
  });
  test("a finished turn at 100k prepares for idle compaction and refreshes once at 160k", async () => {
    const h = host({}, undefined, { workerReply: covering() });
    await fill(h);
    await h.measure(99_999);
    await h.complete();
    expect(h.workerCalls).toBe(0);
    await h.measure(100_000);
    expect(h.workerCalls).toBe(0);
    await h.complete();
    expect(h.workerCalls).toBe(2);
    expect((await h.compact(transcript())).coreCalls).toBe(0);
    expect(h.selfCompactions).toBe(0);
    const refreshing = host({}, undefined, { workerReply: covering() });
    await fill(refreshing);
    await refreshing.measure(100_000);
    await refreshing.complete();
    await refreshing.measure(160_000);
    expect(refreshing.workerCalls).toBe(4);
    await refreshing.measure(180_000);
    expect(refreshing.workerCalls).toBe(4);
  });
  test("turn completion uses append growth, including outputs beyond the evidence cap", async () => {
    const h = host({}, undefined, { workerReply: coveringManifest });
    await fill(h);
    await h.measure(99_900);
    await h.append("large", "assistant", "tool output ".repeat(1000));
    await h.complete();
    expect(h.workerCalls).toBe(2);
    const midTurn = host({}, undefined, { workerReply: coveringManifest });
    await fill(midTurn);
    await midTurn.measure(150_000);
    await midTurn.append("large", "assistant", "tool output ".repeat(8000));
    await midTurn.settle();
    expect(midTurn.workerCalls).toBe(2);
  });
  test("a failed preparation is not retried against unchanged high context", async () => {
    const h = host();
    await fill(h);
    await h.measure(160_000);
    await h.measure(180_000);
    await h.complete();
    expect(h.workerCalls).toBe(1);
    expect(await h.status()).toContain("Models unavailable");
  });
  test("subagent compaction and speculative precompute do not touch main history", async () => {
    const h = await readyHost();
    const result = await h.compact(transcript(), "precompute");
    expect(result.coreCalls).toBe(0);
    expect(result.result.skip).toContain("live compaction");
    expect(h.workerCalls).toBe(2);
  });
});

describe("verified swap and recovery", () => {
  test("a ready checkpoint swaps immediately, keeps ten exact rounds, and makes no model call", async () => {
    const h = await readyHost();
    const live = transcript();
    const { result, coreCalls } = await h.compact(live);
    expect(coreCalls).toBe(0);
    expect(h.workerCalls).toBe(2);
    expect(h.sleeps).toBe(0);
    expect(result.messages?.[0]?.text).toContain("entry a18");
    expect(result.messages?.slice(1)).toEqual(live.slice(20));
    expect(await h.status()).toContain("· installed");
    expect(await h.status()).toContain("installs: 1");
    expect(h.events().filter(event => event.event === "install-confirmed").length).toBe(1);
    const entered = h.events().find(event => event.event === "compact-enter");
    expect(entered.measuredTokens).toBe(160_000);
  });
  test("manual compact uses Shadow through the same swap path", async () => {
    const h = await readyHost();
    expect((await h.compact(transcript(), "manual")).coreCalls).toBe(0);
    expect(h.workerCalls).toBe(2);
  });
  test("all uncovered messages survive even when they exceed the ten-round minimum", async () => {
    const h = await readyHost("a2");
    const live = transcript();
    const { result, coreCalls } = await h.compact(live);
    expect(coreCalls).toBe(0);
    expect(result.messages?.slice(1)).toEqual(live.slice(4));
  });
  test("opaque handle changes are safe only with a full unchanged prefix", async () => {
    const h = await readyHost();
    const live = transcript().map((row, index) => ({ ...row, handle: `clone-${index}` }));
    const { result, coreCalls } = await h.compact(live);
    expect(coreCalls).toBe(0);
    expect(result.messages?.slice(1)).toEqual(live.slice(20));
    expect(h.workerCalls).toBe(2);
  });
  test("a changed older row is reconciled and independently verified before replacement", async () => {
    const h = await readyHost();
    const live = transcript().map((row, index) => index === 0 ? { ...row, text: longText("corrected original task") } : row);
    const { result, coreCalls } = await h.compact(live);
    expect(coreCalls).toBe(0);
    expect(h.workerCalls).toBe(4);
    expect(result.messages?.slice(1)).toEqual(live.slice(20));
    const snapshots = [...h.files.entries()].filter(([path]) => path.endsWith("/evidence.jsonl"));
    expect(snapshots.at(-1)![1]).toContain("corrected original task");
    expect(h.events().some(event => event.event === "compact-reconcile")).toBe(true);
  });
  test("duplicate handles cannot authorize deletion or a repair loop", async () => {
    const h = await readyHost();
    const live = transcript().map((row, index) => index === 1 ? { ...row, handle: "u1" } : row);
    expect((await h.compact(live)).coreCalls).toBe(1);
    expect(h.workerCalls).toBe(2);
    expect(await h.status()).toContain("coverage-ambiguous");
  });
  test("a compaction arriving before preparation starts waits for one builder and verifier", async () => {
    const h = host({}, undefined, { workerReply: covering(), workerDelaySleeps: 3 });
    await fill(h);
    const result = await h.compact(transcript());
    expect(result.coreCalls).toBe(0);
    expect(h.workerCalls).toBe(2);
    expect(h.sleeps).toBeGreaterThanOrEqual(6);
  });
  test("a still-running checkpoint holds beyond the old 120-second limit", async () => {
    const h = await readyHost("a18", {}, { workerDelaySleeps: 150 });
    expect(await h.status()).toContain("· preparing");
    expect((await h.compact(transcript())).coreCalls).toBe(0);
    expect(h.sleeps).toBeGreaterThanOrEqual(300);
    expect(h.workerCalls).toBe(2);
  });
  test("one shared deadline stops work and discards every late answer", async () => {
    const h = await readyHost("a18", {}, { workerDelaySleeps: 1000 });
    const result = await h.compact(transcript());
    expect(result.coreCalls).toBe(1);
    expect(result.cancelledBeforeCore).toBe(true);
    expect(h.workerCalls).toBe(1);
    expect(h.sleeps).toBeGreaterThanOrEqual(360);
    await h.deliverLate();
    expect(h.workerCalls).toBe(1);
    expect(await h.status()).toContain("Checkpoint: none yet");
    expect(h.events().filter(event => event.event === "prepare-start").length).toBe(1);
  });
  test("a host unable to pause cancels obsolete work before native compaction", async () => {
    const h = await readyHost("a18", {}, { workerDelaySleeps: 1000, noSleep: true });
    const result = await h.compact(transcript());
    expect(result.coreCalls).toBe(1);
    expect(result.cancelledBeforeCore).toBe(true);
    expect(await h.status()).toContain("no-pause");
    await h.deliverLate();
    expect(await h.status()).toContain("Checkpoint: none yet");
  });
  test("an interrupted hold skips compaction and cancels its workers", async () => {
    const h = await readyHost("a18", {}, { workerDelaySleeps: 1000 });
    const controller = new AbortController();
    controller.abort();
    const result = await h.compact(transcript(), "auto", [], controller.signal);
    expect(result.coreCalls).toBe(0);
    expect(result.result.skip).toContain("interrupted");
    await h.deliverLate();
    expect(h.workerCalls).toBe(1);
  });
  test("low remaining hook budget falls back before spending more wait time", async () => {
    const h = await readyHost("a18", {}, { workerDelaySleeps: 1000 });
    expect((await h.compact(transcript(), "auto", undefined, undefined, 100)).coreCalls).toBe(1);
    expect(h.sleeps).toBe(0);
    expect(await h.status()).toContain("budget");
  });
  test("an unverified or unusable draft never reaches installation or transport retry", async () => {
    const h = await readyHost("a18", {}, { workerReply: request => request.system === BUILDER_SYSTEM_PROMPT ? covering()(request) : '{"verdict":"unusable","reason":"ungrounded"}' });
    expect(h.completeRequests.length).toBe(0);
    expect((await h.compact(transcript())).coreCalls).toBe(1);
    expect(h.workerCalls).toBe(2);
    expect(await h.status()).toContain("native fallbacks: 1");
  });
  test("only the exact checkpoint text can confirm an installation", async () => {
    const h = await readyHost();
    const first = await h.compact(transcript());
    const forged = first.result.messages!.map((row, i) => i === 0 ? { ...row, text: `${row.text}\nchanged` } : row);
    h.setCanonical(forged);
    expect(await h.status()).toContain("· installing");
    expect(await h.status()).toContain("installs: 0");
    h.setCanonical(first.result.messages!);
    expect(await h.status()).toContain("installs: 1");
  });
});

describe("Claude role transport", () => {
  test("verifier transport fallback reuses the builder draft and selected model", async () => {
    const h = host({ checkpointModel: "sonnet", checkpointEffort: "high" }, request => {
      expect(request.system).toBe(VERIFIER_SYSTEM_PROMPT);
      expect(request.prompt).toContain("Session evidence (sanitized JSONL rows");
      expect(request.prompt).not.toContain("Read the session evidence from the file");
      return '{"verdict":"accept"}';
    }, { workerReply: request => { if (request.system === VERIFIER_SYSTEM_PROMPT) throw new Error("transport unavailable"); return covering()(request); } });
    await fill(h);
    await h.measure(160_000);
    expect(h.claudeRuns.map(run => run.role)).toEqual(["builder", "verifier"]);
    expect(h.completeRequests.map(run => [run.model, run.effort])).toEqual([["sonnet", "high"]]);
    expect(h.completeRequests[0]!.timeoutMs!).toBeGreaterThan(0);
    expect((await h.compact(transcript())).coreCalls).toBe(0);
  });
  test("changing transport cannot reset the builder's bounded correction", async () => {
    let workers = 0;
    let inline = 0;
    const h = host({}, () => { inline += 1; return "still malformed"; }, { workerReply: () => {
      workers += 1;
      if (workers === 1) return "malformed";
      throw new Error("transport unavailable");
    } });
    await fill(h);
    await h.measure(160_000);
    expect(workers).toBe(2);
    expect(inline).toBe(1);
    expect(await h.status()).toContain("builder failed validation");
    expect(h.claudeRuns.some(run => run.role === "verifier")).toBe(false);
  });
  test("inline fallback refuses oversized evidence rather than dropping source rows", async () => {
    const h = host({}, covering());
    await fill(h);
    for (let i = 0; i < 40; i++) await h.append(`large-${i}`, "assistant", "context ".repeat(700));
    await h.measure(160_000);
    expect(h.completeRequests.length).toBe(0);
    expect(await h.status()).toContain("refusing truncated fallback");
    expect(await h.status()).toContain("Checkpoint: none yet");
  });
  test("a stale nonce is ignored and the same role can recover through inline completion", async () => {
    const h = host({}, covering(), { workerReply: covering(), workerResult: (_request, answer) => ({ nonce: "stale", ok: true, answer }) });
    await fill(h);
    await h.measure(160_000);
    expect(h.claudeRuns.length).toBe(1);
    expect(h.completeRequests.length).toBe(2);
    expect((await h.compact(transcript())).coreCalls).toBe(0);
  });
  test("deadline expiry during a worker prevents the verifier or inline fallback from starting", async () => {
    const h = await readyHost("a18", {}, { workerRunTimeMs: 360_001 });
    expect(h.workerCalls).toBe(1);
    expect(h.completeRequests.length).toBe(0);
    expect(await h.status()).toContain("preparation deadline reached");
  });
  test("session end cancels a pending preparation and cannot publish its late result", async () => {
    const h = await readyHost("a18", {}, { workerDelaySleeps: 1000 });
    await h.end();
    await h.deliverLate();
    expect(h.workerCalls).toBe(1);
    expect(await h.status()).toContain("Checkpoint: none yet");
    expect(await h.status()).toContain("· idle");
  });
});

describe("history reconciliation and fidelity", () => {
  test("an empty startup read is retried and includes history predating the reload", async () => {
    const h = host({}, undefined, { workerReply: coveringManifest });
    await h.start();
    h.setCanonical(transcript());
    await h.append("u21", "user", longText("after reload"));
    await h.append("a21", "assistant", longText("new answer"));
    await h.measure(160_000);
    const evidence = [...h.files.entries()].find(([path]) => path.endsWith("/evidence.jsonl"))![1];
    expect(evidence).toContain("task 1 detail");
    expect(evidence).toContain("after reload");
    expect(h.workerCalls).toBe(2);
    expect((await h.compact([...transcript(), ...transcript([["u21", "user", longText("after reload")], ["a21", "assistant", longText("new answer")]])])).coreCalls).toBe(0);
  });
  test("a capped canonical read recovers against the complete live compact snapshot", async () => {
    const h = host({}, undefined, { workerReply: coveringManifest, historyRead: async () => Array.from({ length: 4096 }, () => message("user", "capped")) });
    await fill(h);
    await h.measure(160_000);
    expect(h.workerCalls).toBe(0);
    expect((await h.compact(transcript())).coreCalls).toBe(0);
    expect(h.workerCalls).toBe(2);
  });
  test("appends racing a canonical read survive once in the final evidence order", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const h = host({}, undefined, { workerReply: coveringManifest, historyRead: async messages => {
      reads += 1; const snapshot = [...messages]; if (reads === 1) await gate; return snapshot;
    } });
    h.setCanonical(transcript());
    const starting = h.start();
    await h.settle();
    await h.append("u21", "user", longText("arrived during read"));
    await h.append("a21", "assistant", longText("answer during read"));
    release();
    await starting;
    await h.measure(160_000);
    const evidence = [...h.files.entries()].find(([path]) => path.endsWith("/evidence.jsonl"))![1];
    const rows = evidence.trim().split("\n").map(line => JSON.parse(line));
    expect(rows.length).toBe(42);
    expect(rows[0].text).toContain("task 1 detail");
    expect(rows[40].text).toContain("arrived during read");
  });
  test("output projection preserves final errors with honest clipping metadata", () => {
    const archive = new EvidenceArchive("/repo");
    archive.addAppend("output", "tool-result", { type: "user", role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "Command: npm test\n" + "irrelevant log\n".repeat(800) + "\nFAIL tests/export.test.ts:42 expected 17 received 0", is_error: true }] });
    const row = archive.rows[0]!;
    expect(row.text.length).toBe(4000);
    expect(row.text).toContain("Command: npm test");
    expect(row.text).toContain("FAIL tests/export.test.ts:42 expected 17 received 0");
    expect(row.text).toContain("characters omitted");
    expect(row.textTruncated).toBe(true);
    expect(row.isError).toBe(true);
  });
  test("parallel tool calls and their results remain in the original exact tail", async () => {
    const h = host({}, undefined, { workerReply: coveringManifest });
    await fill(h);
    await h.appendRow("calls", { type: "assistant", content: [{ type: "tool_use", id: "x", name: "Read", input: { path: "a.ts" } }, { type: "tool_use", id: "y", name: "Grep", input: { pattern: "needle" } }] }, "response");
    await h.appendRow("results", { type: "user", role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "first output" }, { type: "tool_result", tool_use_id: "y", content: "second output" }] }, "tool-result");
    await h.measure(160_000);
    const calls = message("assistant", "", { handle: "calls", toolUses: [{ tool_use_id: "x", tool: "Read", input: { path: "a.ts" } }, { tool_use_id: "y", tool: "Grep", input: { pattern: "needle" } }] });
    const results = message("user", "", { handle: "results", toolResults: [{ tool_use_id: "x", text: "first output", isError: false }, { tool_use_id: "y", text: "second output", isError: false }] });
    const compacted = await h.compact([...transcript(), calls, results]);
    expect(compacted.coreCalls).toBe(0);
    expect(compacted.result.messages?.slice(-2)).toEqual([calls, results]);
    expect(hasOrphanedToolResult(compacted.result.messages!)).toBe(false);
  });
  test("current and legacy completion responses normalize and unanswered reasons surface", () => {
    expect(completionText({ isAnswered: true, text: "answer", usage: {} })).toBe("answer");
    expect(completionText("legacy")).toBe("legacy");
    expect(() => completionText({ isAnswered: false, reason: "aborted" })).toThrow(/aborted/);
  });
});

describe("host window setup", () => {
  function startHost(initial: { source: string; raw: number }, initialSettings: Record<string, any> = {}, previous?: unknown, unconfirmed = false) {
    const model = "test-model";
    const settings = structuredClone(initialSettings);
    const store = new Map<string, unknown>();
    if (previous !== undefined) store.set("autoCompactWindowDecisions", { [model]: previous });
    const runs: Array<{ command: string; args: string }> = [];
    const env: Record<string, string> = {};
    let effective = { ...initial };
    const handlers = new Map<string, any>();
    const on = ((event: string, ...args: unknown[]) => { if (args.length === 1) handlers.set(event, args[0]); return { catch: () => undefined }; }) as On;
    const $ = {
      plugin: { root: "/plugin" },
      session: { cwd: async () => "/repo", id: async () => "window-test", messages: async () => [],
        usage: async () => ({ context: { window: 1_000_000, breakdown: { model, rawMaxTokens: effective.raw, autocompactSource: effective.source } } }) },
      clock: { now: async () => 0 },
      command: { register: async () => ({}), run: async (input: { command: string; args: string }) => {
        runs.push(input);
        if (!unconfirmed) {
          effective = { source: "settings", raw: Number(input.args) };
          settings.modelSettings ??= {};
          settings.modelSettings[model] = { autoCompactWindow: Number(input.args) };
        }
        return { text: "set" };
      } },
      settings: { read: async () => settings },
      env: { get: async (name: string) => env[name], set: async (name: string, value: string) => { env[name] = value; } },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } },
      fs: { write: async () => undefined }, ui: { log: () => undefined },
    } as unknown as EngineInterface;
    register(on, {});
    return { runs, store, env, start: () => handlers.get("session.start")!($, {}, async () => ({})) };
  }
  test("configures and confirms the window once, then keeps it on later starts", async () => {
    const h = startHost({ source: "model-default", raw: 1_000_000 });
    await h.start();
    expect(h.runs).toEqual([{ command: "autocompact", args: "235000" }]);
    expect(h.store.get("autoCompactWindowDecisions")).toEqual({ "test-model": "applied:235000" });
    expect(h.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS).toBe("100000");
    await h.start();
    expect(h.runs.length).toBe(1);
  });
  test("a recorded old 190k window is upgraded once", async () => {
    const h = startHost({ source: "settings", raw: 190_000 }, { modelSettings: { "test-model": { autoCompactWindow: 190_000 } } }, "applied:190000");
    await h.start();
    await h.start();
    expect(h.runs).toEqual([{ command: "autocompact", args: "235000" }]);
  });
  test("an unconfirmed host setting never becomes an ownership record", async () => {
    const h = startHost({ source: "model-default", raw: 1_000_000 }, {}, undefined, true);
    await h.start();
    expect(h.store.has("autoCompactWindowDecisions")).toBe(false);
  });
  test("a changed user value and an environment override are preserved", async () => {
    const changed = startHost({ source: "settings", raw: 210_000 }, { modelSettings: { "test-model": { autoCompactWindow: 210_000 } } }, "applied:190000");
    await changed.start();
    expect(changed.runs.length).toBe(0);
    const env = startHost({ source: "env", raw: 190_000 }, { modelSettings: { "test-model": { autoCompactWindow: 190_000 } } }, "applied:190000");
    await env.start();
    expect(env.runs.length).toBe(0);
  });
});

describe("continued sessions", () => {
  test("a successful install followed by shrink re-arms a fresh checkpoint", async () => {
    const h = host({}, undefined, { workerReply: coveringManifest });
    await fill(h);
    await h.measure(160_000);
    const first = await h.compact(transcript());
    await h.measure(20_000);
    const newer = Array.from({ length: 12 }, (_, i) => [
      [`u${i + 21}`, "user", longText(`new task ${i + 21}`)],
      [`a${i + 21}`, "assistant", longText(`new answer ${i + 21}`)],
    ] as Array<[string, "user" | "assistant", string]>).flat();
    await fill(h, newer);
    await h.measure(160_000);
    expect(h.workerCalls).toBe(4);
    const live = [...first.result.messages!, ...transcript(newer)].map((row, i) => ({ ...row, handle: `new-handle-${i}` }));
    expect((await h.compact(live)).coreCalls).toBe(0);
    expect(await h.status()).toContain("installs: 2");
  });
  test("the native escape hatch cancels pending work and runs exactly once", async () => {
    const h = await readyHost("a18", {}, { workerDelaySleeps: 1000 });
    await h.runCommand("compact-native");
    await h.flush();
    expect(h.selfCompactions).toBe(1);
    expect([...h.files.keys()].some(path => path.endsWith("/cancel"))).toBe(true);
    await h.deliverLate();
    expect(h.workerCalls).toBe(1);
    expect(await h.status()).toContain("Checkpoint: none yet");
  });
  test("tool arguments participate in prefix proof even when IDs and prose match", () => {
    const index = new LiveTranscript();
    const old = [message("assistant", "", { toolUses: [{ tool_use_id: "t", tool: "Read", input: { file_path: "old" } }] })];
    index.remember(old, ["original"]);
    expect(index.resolve([{ ...old[0]!, handle: "clone" }])).toEqual(["original"]);
    expect(index.resolve([message("assistant", "", { handle: "clone", toolUses: [{ tool_use_id: "t", tool: "Read", input: { file_path: "new" } }] })])).toEqual(["unknown-0"]);
  });
});

// These two tests use Claude Code's real engine fixture. The portable Node
// adapter skips them; run `npm run check:host` in a Claude Code development host.
describe("engine fixture integration", () => {
  test("status command is routed through the Claude engine", async ($, on) => {
    on("session.start", (_$, e) => ({ cwd: e.cwd }));
    await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
    const result = await $.command.run({ command: "shadow-status", args: "", origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 80 } });
    expect(result.text).toContain("Shadow Compact v0.4.11");
    expect(result.text).toContain("prepare: 160,000 tokens");
    expect(result.text).toContain("Model: haiku · effort: high");
  });
  test("an unsafe tiny compaction cannot invent a checkpoint", async ($, on) => {
    on("session.compact", (_$, e) => ({ messages: e.messages }));
    const result = await $.session.compact({ trigger: "manual", messages: [message("user", "hello"), message("assistant", "hi there")] });
    expect((result.messages ?? []).some(entry => entry.text.includes("Continuation Checkpoint"))).toBe(false);
  });
});

describe("refresh and install races", () => {
  test("an in-flight installation confirms its own checkpoint after a refresh publishes", () => {
    const state = new ShadowState();
    const candidate = (id: string): PublishedCheckpoint => ({ checkpointId: id, rendered: id, coverageEndEntryId: id,
      validation: { deterministic: "passed", independent: "accepted" },
      proof: { sessionId: "test", epoch: 0, snapshotId: id, coveredCount: 1, prefixDigest: id, evidenceDigest: id } });
    const old = candidate("older");
    state.publish(state.startPreparing()!, old);
    state.rearm();
    const generation = state.startPreparing()!;
    state.attemptInstall(old);
    state.publish(generation, candidate("newer"));
    expect(state.attemptedCheckpoint?.checkpointId).toBe("older");
    expect(state.confirmInstall("newer")).toBe(false);
    expect(state.confirmInstall("older")).toBe(true);
    expect(state.installedCheckpointId).toBe("older");
    expect(state.published?.checkpointId).toBe("newer");
    expect(state.phase).toBe("ready");
  });
  test("an idle checkpoint serves instantly while its threshold refresh is still running", async () => {
    const fakes: HostFakes = { workerReply: coveringManifest };
    const h = host({}, undefined, fakes);
    await fill(h);
    await h.measure(100_000);
    await h.complete();
    expect(h.workerCalls).toBe(2);
    fakes.workerDelaySleeps = 1000;
    await h.append("u21", "user", longText("new request"));
    await h.append("a21", "assistant", longText("new response"));
    await h.measure(160_000);
    expect(await h.status()).toContain("· refreshing");
    const live = [...transcript(), ...transcript([["u21", "user", longText("new request")], ["a21", "assistant", longText("new response")]])];
    const result = await h.compact(live);
    expect(result.coreCalls).toBe(0);
    expect(result.result.messages?.[0]?.text).toContain("entry a20");
    expect(result.result.messages?.slice(-2)).toEqual(live.slice(-2));
    expect(h.sleeps).toBe(0);
    await h.deliverLate();
    await h.deliverLate();
    expect(h.events().filter(event => event.event === "prepare-verified").length).toBe(1);
    expect(await h.status()).toContain("installs: 1");
  });
  test("a subagent compaction bypasses the main-session checkpoint", async () => {
    const h = await readyHost();
    const result = await h.compact(transcript(), "auto", undefined, undefined, undefined, "child-agent");
    expect(result.coreCalls).toBe(1);
    expect(h.workerCalls).toBe(2);
    expect(h.events().some(event => event.event === "compact-enter")).toBe(false);
  });
});

describe("retryable history reads", () => {
  test("a startup read failure is visible and a later preparation retries the full history", async () => {
    let unavailable = true;
    const h = host({}, undefined, { workerReply: coveringManifest, historyRead: async messages => {
      if (unavailable) throw new Error("session not bound yet");
      return messages;
    } });
    await h.start();
    expect(await h.status()).toContain("Last issue: retryable:session not bound yet");
    unavailable = false;
    h.setCanonical(transcript());
    await h.measure(160_000);
    expect(h.workerCalls).toBe(2);
    expect((await h.compact(transcript())).coreCalls).toBe(0);
  });
});

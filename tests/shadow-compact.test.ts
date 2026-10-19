import { describe, expect, test } from "claude-code/testing";
import type { EngineInterface, On, SessionMeasureInput, SessionMessage } from "claude-code";
import {
  renderCheckpoint,
  validateCheckpointObject,
  type Checkpoint,
} from "../hooks/checkpoint.js";
import { decideAutoCompactWindow, decideIdleCompaction, describeModel, describeRole, isAtOrAbove, resolveConfig, usesPi, type WindowFacts } from "../hooks/config.js";
import { EvidenceArchive } from "../hooks/evidence.js";
import { redactSecretValue, sanitizeForContext } from "../hooks/normalize.js";
import { BUILDER_SYSTEM_PROMPT, VERIFIER_SYSTEM_PROMPT, prepareCheckpoint, parseSubmission } from "../hooks/prepare.js";
import { checkPi } from "../hooks/pi-backend.js";
import { PI_EVIDENCE_ACCESS, type PiEvidenceFile, type PiRunRequest, type PiRunResult } from "../hooks/pi-protocol.js";
import { register } from "../hooks/register.js";
import { ShadowState, type PublishedCheckpoint } from "../hooks/state.js";
import { buildCandidate, hasOrphanedToolResult, isSkipped } from "../hooks/working-context.js";
import { LiveTranscript } from "../hooks/transcript.js";

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
    const prepared = await prepareCheckpoint(ask, archive, "evidence inline", {
      builder: "inherit",
      verifier: "inherit",
    });
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
      prepareCheckpoint(ask, archive, "evidence inline", { builder: "inherit", verifier: "inherit" }),
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
    const prepared = await prepareCheckpoint(ask, archive, "evidence inline", {
      builder: "inherit",
      verifier: "inherit",
    });
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
    const prepared = await prepareCheckpoint(ask, snapshot, "evidence inline", {
      builder: "inherit",
      verifier: "inherit",
    });
    expect(live.size).toBe(4);
    expect(verifierPrompts[0]).toContain('"rowCount":2');
    expect(verifierPrompts[0]).toContain('"lastRowId":"r2"');
    // A repair citing a row the agents never saw is rejected and retried.
    expect(verifierPrompts[1]).toContain("Unknown evidence reference");
    expect(prepared.coverageEndEntryId).toBe("r2");
  });
});

describe("config", () => {
  test("preparation has one bounded positive deadline", () => {
    expect(resolveConfig({}).prepareTimeoutSeconds).toBe(360);
    expect(resolveConfig({ prepareTimeoutSeconds: 999 }).prepareTimeoutSeconds).toBe(600);
    expect(resolveConfig({ prepareTimeoutSeconds: 0 }).prepareTimeoutSeconds).toBe(360);
  });
  test("token default and custom threshold hold", async () => {
    expect(resolveConfig({}).prepareThresholdTokens).toBe(150_000);
    expect(resolveConfig({ prepareThresholdTokens: 180_000 }).prepareThresholdTokens).toBe(180_000);
  });

  test("builder and verifier default to haiku", async () => {
    const config = resolveConfig({});
    expect(config.builderModel).toBe("haiku");
    expect(config.verifierModel).toBe("haiku");
    const custom = resolveConfig({ builderModel: "sonnet", verifierModel: " inherit " });
    expect(custom.builderModel).toBe("sonnet");
    expect(custom.verifierModel).toBe("inherit");
    expect(resolveConfig({ builderModel: "" }).builderModel).toBe("haiku");
    expect(describeModel("haiku")).toBe("claude:haiku");
    expect(describeModel("sonnet")).toBe("claude:sonnet");
  });

  test("invalid token settings use the default", async () => {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "bad", "", true, false]) {
      expect(resolveConfig({ prepareThresholdTokens: invalid }).prepareThresholdTokens).toBe(150_000);
    }
    expect(resolveConfig({ prepareThresholdTokens: "200000" }).prepareThresholdTokens).toBe(200_000);
  });

  test("only absolute token usage triggers thresholds, including the exact boundary", async () => {
    expect(isAtOrAbove({ tokens: 159_999, percent: 99 }, 160_000)).toBe(false);
    expect(isAtOrAbove({ tokens: 160_000, percent: 16 }, 160_000)).toBe(true);
    for (const tokens of [undefined, null, NaN, Infinity]) {
      expect(isAtOrAbove({ tokens, percent: 100 }, 160_000)).toBe(false);
    }
    const legacy = resolveConfig({ prepareThresholdPercent: 1, hardThresholdTokens: 2 });
    expect(legacy.prepareThresholdTokens).toBe(150_000);
  });

  test("auto-compact window defaults to 190k and is on", async () => {
    const config = resolveConfig({});
    expect(config.autoCompactWindowTokens).toBe(190_000);
    expect(config.configureAutoCompactWindow).toBe(true);
    expect(resolveConfig({ configureAutoCompactWindow: false }).configureAutoCompactWindow).toBe(false);
    expect(resolveConfig({ autoCompactWindowTokens: -5 }).autoCompactWindowTokens).toBe(190_000);
  });

  test("idle-compaction floor defaults to 100k, on, and never goes below 100k", async () => {
    const config = resolveConfig({});
    expect(config.idleCompactMinTokens).toBe(100_000);
    expect(config.configureIdleCompaction).toBe(true);
    expect(resolveConfig({ idleCompactMinTokens: 50_000 }).idleCompactMinTokens).toBe(100_000);
    expect(resolveConfig({ idleCompactMinTokens: 120_000 }).idleCompactMinTokens).toBe(120_000);
    expect(resolveConfig({ configureIdleCompaction: false }).configureIdleCompaction).toBe(false);
  });
});

describe("idle-compaction floor decision", () => {
  const config = resolveConfig({});

  test("applies when nothing chose a floor", async () => {
    expect(decideIdleCompaction(config, { envValue: undefined, settings: {} })).toEqual({ apply: true });
  });

  test("keeps a person's floor, respects idleCompaction false and the toggle", async () => {
    expect(decideIdleCompaction(config, { envValue: "150000", settings: {} })).toEqual({ apply: false, reason: "kept-env 150000" });
    expect(decideIdleCompaction(config, { envValue: undefined, settings: { idleCompaction: false } })).toEqual({ apply: false, reason: "off-settings" });
    const off = resolveConfig({ configureIdleCompaction: false });
    expect(decideIdleCompaction(off, { envValue: undefined, settings: {} })).toEqual({ apply: false, reason: "disabled" });
  });
});

describe("auto-compact window decision", () => {
  const facts = (overrides: Partial<WindowFacts> = {}): WindowFacts => ({
    model: "claude-opus-5-5",
    modelWindow: 1_000_000,
    source: "model-default",
    settings: {},
    decidedBefore: false,
    ...overrides,
  });
  const config = resolveConfig({});

  test("applies on a model's first session with no chosen window", async () => {
    expect(decideAutoCompactWindow(config, facts())).toEqual({ apply: true });
  });

  test("never overrides an env, settings or explicit auto window", async () => {
    expect(decideAutoCompactWindow(config, facts({ source: "env" }))).toMatchObject({ apply: false, reason: "kept-env", final: true });
    expect(decideAutoCompactWindow(config, facts({ source: "settings" }))).toMatchObject({ reason: "kept-settings" });
    // `/autocompact auto` reports model-default, so settings are read too.
    const explicitAuto = { modelSettings: { "claude-opus-5-5": { autoCompactWindow: "auto" } } };
    expect(decideAutoCompactWindow(config, facts({ settings: explicitAuto }))).toMatchObject({ reason: "kept-settings" });
    expect(decideAutoCompactWindow(config, facts({ settings: { autoCompactWindow: 300_000 } }))).toMatchObject({ reason: "kept-settings" });
    // Another model's choice does not count for this one.
    const other = { modelSettings: { "claude-sonnet-5-5": { autoCompactWindow: 300_000 } } };
    expect(decideAutoCompactWindow(config, facts({ settings: other }))).toEqual({ apply: true });
  });

  test("decides once per model and skips windows that cannot work", async () => {
    expect(decideAutoCompactWindow(config, facts({ decidedBefore: true }))).toMatchObject({ reason: "decided-before" });
    expect(decideAutoCompactWindow(resolveConfig({ configureAutoCompactWindow: false }), facts())).toMatchObject({ reason: "disabled", final: false });
    expect(decideAutoCompactWindow(config, facts({ modelWindow: 190_000 }))).toMatchObject({ reason: "model-window-smaller", final: false });
    const inverted = resolveConfig({ prepareThresholdTokens: 200_000 });
    expect(decideAutoCompactWindow(inverted, facts())).toMatchObject({ reason: "window-below-prepare-threshold" });
  });
});

describe("auto-compact window setup", () => {
  function startHost(options: Record<string, number | string | boolean>, initial: { source: string; raw: number }, settings = {}, env: Record<string, string> = {}) {
    const store = new Map<string, unknown>();
    const runs: Array<{ command: string; args: string }> = [];
    let effective = { ...initial };
    const handlers = new Map<string, any>();
    const on = ((event: string, ...args: unknown[]) => {
      if (args.length === 1) handlers.set(event, args[0]);
    }) as On;
    const $ = {
      plugin: { root: "/plugin" },
      session: {
        cwd: async () => "/repo",
        id: async () => "window-test",
        messages: async () => [],
        usage: async () => ({
          context: {
            window: 1_000_000,
            breakdown: { model: "claude-opus-5-5", rawMaxTokens: effective.raw, autocompactSource: effective.source },
          },
        }),
      },
      agent: { register: async () => ({}) },
      command: {
        register: async () => ({}),
        run: async (input: { command: string; args: string }) => {
          runs.push(input);
          effective = { source: "settings", raw: Number(input.args) };
          return { text: "set" };
        },
      },
      settings: { read: async () => settings },
      env: {
        get: async (name: string) => env[name],
        set: async (name: string, value: string | undefined) => {
          if (value === undefined) delete env[name];
          else env[name] = value;
        },
      },
      store: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } },
      fs: { write: async () => undefined },
      ui: { log: () => undefined },
    } as unknown as EngineInterface;
    register(on, options);
    return {
      runs,
      store,
      env,
      start: () => handlers.get("session.start")!($, { cwd: "/repo" }, async (e: { cwd: string }) => ({ cwd: e.cwd })),
    };
  }

  test("sets the window once through /autocompact and remembers the model", async () => {
    const h = startHost({}, { source: "model-default", raw: 1_000_000 });
    await h.start();
    expect(h.runs).toEqual([{ command: "autocompact", args: "190000" }]);
    expect(h.store.get("autoCompactWindowDecisions")).toEqual({ "claude-opus-5-5": "applied:190000" });
    await h.start();
    expect(h.runs.length).toBe(1);
  });

  test("leaves an existing window alone and records that", async () => {
    const h = startHost({}, { source: "model-default", raw: 1_000_000 }, { modelSettings: { "claude-opus-5-5": { autoCompactWindow: "auto" } } });
    await h.start();
    expect(h.runs.length).toBe(0);
    expect(h.store.get("autoCompactWindowDecisions")).toEqual({ "claude-opus-5-5": "kept-settings" });
  });

  test("disabled does nothing and remembers nothing", async () => {
    const h = startHost({ configureAutoCompactWindow: false }, { source: "model-default", raw: 1_000_000 });
    await h.start();
    expect(h.runs.length).toBe(0);
    expect(h.store.size).toBe(0);
  });

  test("lowers the idle-compaction floor unless the person set one", async () => {
    const h = startHost({}, { source: "model-default", raw: 1_000_000 });
    await h.start();
    expect(h.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS).toBe("100000");
    const kept = startHost({}, { source: "model-default", raw: 1_000_000 }, {}, { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: "180000" });
    await kept.start();
    expect(kept.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS).toBe("180000");
  });
});

// Drive the registered hooks with a small host so preparation and
// compaction are deterministic and never invoke real models or core.
type Reply = (request: { system: string; prompt: string }) => string;

/** What the fake Pi worker does with one run request. */
type PiWorker = (request: PiRunRequest) => PiRunResult | "crash";

interface HostFakes {
  /** Answers private agent spawns through `turn.complete`; absent, spawns fail. */
  agentReply?: Reply;
  /** Agent answers land only after this many host sleeps (a slow pipeline). */
  agentDelaySleeps?: number;
  piWorker?: PiWorker;
  /** Host `sleep` fails, as on a host without it or Node. */
  noSleep?: boolean;
  piRunTimeMs?: number;
}

function host(options: Record<string, number | string> = {}, reply?: Reply, fakes: HostFakes = {}) {
  type Handler = ($: EngineInterface, e: any, next: (e: any) => Promise<any>) => any;
  const handlers = new Map<string, Handler>();
  const scheduled: Array<{ at: number; callback: () => void }> = [];
  const stoppedAgents: string[] = [];
  const logs: string[] = [];
  let canonical: SessionMessage[] = [];
  let spawns = 0;
  let selfCompactions = 0;
  const files = new Map<string, string>();
  const piRuns: PiRunRequest[] = [];
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
  }) as On;
  const $ = {
    plugin: { root: "/plugin" },
    session: {
      cwd: async () => "/repo",
      id: async () => "host-test",
      messages: async () => canonical,
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
    command: { run: async () => { throw new Error("Shadow must not run commands"); } },
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
          sleeps += 1;
          now += Number(argv[1] ?? 1) * 1000 || 1000;
          fireTimers();
          for (const due of delayed.filter((entry) => entry.at <= sleeps)) {
            delayed.splice(delayed.indexOf(due), 1);
            await due.deliver();
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (!fakes.piWorker) throw new Error("Shadow must not start processes");
        expect(argv[1]).toBe("/plugin/dist/pi-checkpoint-worker.mjs");
        const request = JSON.parse(init.stdin!) as PiRunRequest;
        piRuns.push(request);
        now += fakes.piRunTimeMs ?? 0;
        fireTimers();
        const result = fakes.piWorker(request);
        if (result === "crash") return { exitCode: 1, stdout: "", stderr: "node: bad bundle" };
        files.set(request.outputPath, JSON.stringify(result));
        return { exitCode: 0, stdout: '{"ok":true}', stderr: "" };
      },
    },
    agent: { spawn: async (request: { subagentType: string; prompt: string }) => {
      spawns += 1;
      if (!fakes.agentReply) throw new Error("Agents unavailable in test");
      const agentId = `agent-${spawns}`;
      const system = request.subagentType.endsWith("builder") ? BUILDER_SYSTEM_PROMPT : VERIFIER_SYSTEM_PROMPT;
      const answer = fakes.agentReply({ system, prompt: request.prompt });
      const deliver = async () => {
        await handlers.get("turn.complete")!($, { agentId, answer }, async () => ({}));
      };
      if (fakes.agentDelaySleeps !== undefined) {
        delayed.push({ at: sleeps + fakes.agentDelaySleeps, deliver });
        return { agentId };
      }
      // The answer lands after Shadow has started waiting for it.
      void (async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
        await deliver();
      })();
      return { agentId };
    } },
    model: { complete: async (request: { system: string; prompt: string }) => {
      if (!reply) throw new Error("Models unavailable in test");
      return reply(request);
    } },
    ui: { log: (text: string) => { logs.push(text); } },
    tool: { call: async (input: { tool: string; task_id: string }) => {
      expect(input.tool).toBe("TaskStop");
      stoppedAgents.push(input.task_id);
      return { text: "stopped" };
    } },
  } as unknown as EngineInterface;
  register(on, options);
  const settle = async () => {
    for (let i = 0; i < 200; i += 1) await Promise.resolve();
  };
  return {
    logs,
    get spawns() { return spawns; },
    files,
    piRuns,
    stoppedAgents,
    get selfCompactions() { return selfCompactions; },
    get sleeps() { return sleeps; },
    /** Delivers every held agent answer, as a slow pipeline finishing late. */
    deliverLate: async () => {
      for (const due of delayed.splice(0)) await due.deliver();
      await settle();
    },
    setCanonical: (messages: SessionMessage[]) => { canonical = messages; },
    appendRow: (uuid: string, row: { type: string; role?: string; content: unknown; isMeta?: boolean }, door = "attachment") =>
      handlers.get("session.append")!($, { uuid, door, origin: { kind: "model" }, message: row }, async () => ({ uuid, message: row })),
    append: (uuid: string, role: "user" | "assistant", text: string, door = role === "user" ? "prompt" : "response") =>
      handlers.get("session.append")!(
        $,
        { uuid, door, origin: { kind: "composer" }, message: { type: role, role, content: [{ type: "text", text }] } },
        async (e) => ({ uuid: e.uuid, message: e.message }),
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
    ) => {
      let coreCalls = 0;
      const next = Object.assign(
        async () => {
          coreCalls += 1;
          return { messages: core };
        },
        signal ? { signal } : {},
      );
      const result = await handlers.get("session.compact")!($, { trigger, messages }, next);
      return { result: result as { messages?: SessionMessage[]; skip?: string }, coreCalls };
    },
    flush: async () => {
      now += 50;
      fireTimers();
      await settle();
    },
  };
}

const longText = (label: string) => `${label} ${"detail ".repeat(200)}`;
const turns: Array<[string, "user" | "assistant", string]> = [
  ["u1", "user", longText("task")],
  ["a1", "assistant", longText("answer")],
  ["u2", "user", longText("second ask")],
  ["a2", "assistant", longText("second answer")],
  ["u3", "user", "latest ask"],
  ["a3", "assistant", "latest answer"],
];
const transcript = (rows = turns): SessionMessage[] =>
  rows.map(([id, role, text]) => ({ ...message(role, text), handle: id }));

/** Builder covers through `coverage`; the verifier accepts. */
const covering = (coverage: string): Reply => (request) =>
  request.system.includes("create evidence-grounded")
    ? JSON.stringify({ checkpoint: checkpointJson("E0001"), coverageEndEntryId: coverage })
    : JSON.stringify({ verdict: "accept", reason: "grounded" });

async function readyHost(coverage = "a2") {
  const h = host({ recentTurns: 1 }, covering(coverage));
  for (const [id, role, text] of turns) await h.append(id, role, text);
  await h.measure(160_000);
  return h;
}

describe("token threshold", () => {
  test("checkpoint preparation starts at the token boundary without percentage usage", async () => {
    const h = host();
    await h.append("u1", "user", "task");
    await h.append("a1", "assistant", "answer");
    await h.measure(149_999, 99);
    expect(h.spawns).toBe(0);
    await h.measure(150_000);
    expect(h.spawns).toBe(1);
  });

  test("Shadow never starts a compaction itself, at any context size", async () => {
    const h = await readyHost();
    expect(await h.status()).toContain("phase=ready");
    await h.measure(400_000);
    await h.complete();
    await h.flush();
    expect(h.selfCompactions).toBe(0);
    const reply = await h.runCommand("shadow-compact");
    expect(reply.text).toContain("run /compact to install");
  });

  test("a completed turn above the idle floor prepares for idle compaction, refreshed once at the threshold", async () => {
    const h = host();
    await h.append("u1", "user", "task");
    await h.append("a1", "assistant", "answer");
    await h.measure(99_999);
    await h.complete();
    expect(h.spawns).toBe(0);
    await h.measure(120_000);
    expect(h.spawns).toBe(0);
    await h.complete();
    expect(h.spawns).toBe(1);
    await h.flush();
    await h.complete();
    expect(h.spawns).toBe(1);
    await h.measure(150_000);
    expect(h.spawns).toBe(2);
    await h.measure(160_000);
    expect(h.spawns).toBe(2);
  });

  test("idle preparation stays off when the toggle is off", async () => {
    const h = host({ configureIdleCompaction: false } as unknown as Record<string, number | string>);
    await h.append("u1", "user", "task");
    await h.append("a1", "assistant", "answer");
    await h.measure(120_000);
    await h.complete();
    expect(h.spawns).toBe(0);
  });

  test("a failed preparation is not retried while context stays high", async () => {
    const h = host();
    await h.append("u1", "user", "task");
    await h.append("a1", "assistant", "answer");
    await h.measure(160_000);
    await h.measure(170_000);
    expect(h.spawns).toBe(1);
    expect(await h.status()).toContain("then failed:");
  });
});

describe("compaction install", () => {
  test("inline fallback refuses a large archive instead of silently omitting later evidence", async () => {
    const h = host({}, covering("a2"));
    for (const [id, role, text] of turns) await h.append(id, role, text);
    for (let i = 0; i < 40; i++) await h.append(`large-${i}`, "assistant", `row ${i} ${"x".repeat(3900)}`);
    await h.measure(160_000);
    expect(await h.status()).toContain("refusing truncated fallback");
    expect(await h.status()).toContain("checkpoint=none");
  });
  test("real attachment, cancelled-row and role-less assistant shapes do not block a ready checkpoint", async () => {
    const h = host({ recentTurns: 1 }, covering("a2"));
    for (const [id, role, text] of turns) await h.append(id, role, text);
    for (let i = 0; i < 35; i++) {
      await h.appendRow(`attachment-${i}`, { type: "attachment", role: "user", content: [{ type: "text", text: "environment reminder" }] });
    }
    await h.append("cancelled-result", "user", "not in active history", "tool-result");
    await h.appendRow("virtual", { type: "user", content: [{ type: "text", text: "not on the wire" }] }, "delivery");
    await h.appendRow("limit", { type: "assistant", content: [{ type: "text", text: "Session limit reached" }] }, "response");
    await h.measure(160_000);
    const live = [transcript()[0]!, message("assistant", "Session limit reached", { handle: "limit" }), ...transcript().slice(1)];
    const result = await h.compact(live);
    expect(result.coreCalls).toBe(0);
    expect(result.result.messages?.slice(1).map(row => row.handle)).toEqual(["u3", "a3"]);
    const events = [...h.files.entries()].filter(([path]) => path.includes("/events/")).map(([, text]) => JSON.parse(text));
    expect(events.some(event => event.event === "compact-shadow")).toBe(true);
    expect(events.find(event => event.event === "compact-enter").unknownHandles).toBe(0);
  });

  test("equal text under an unknown handle cannot re-anchor coverage", async () => {
    const h = await readyHost();
    const live = transcript().map(row => row.handle === "a2" ? { ...row, handle: "another-row" } : row);
    expect((await h.compact(live)).coreCalls).toBe(1);
    expect(await h.status()).toContain("native:coverage-unproven");
  });

  test("a confirmed full prefix permits host UUID cloning and a second Shadow install", async () => {
    let boundary = "a2";
    const h = host({ recentTurns: 1 }, request => covering(boundary)(request));
    for (const [id, role, text] of turns) await h.append(id, role, text);
    await h.measure(160_000);
    const first = await h.compact(transcript());
    expect(first.coreCalls).toBe(0);
    h.setCanonical(first.result.messages!);
    await h.measure(20_000);
    boundary = "u4";
    await h.append("u4", "user", longText("next task"));
    await h.append("a4", "assistant", "latest answer");
    await h.measure(160_000);
    const cloned = first.result.messages!.map((row, i) => ({ ...row, handle: `cloned-${i}` }));
    const second = await h.compact([...cloned, message("user", longText("next task"), { handle: "u4" }), message("assistant", "latest answer", { handle: "a4" })]);
    expect(second.coreCalls).toBe(0);
    expect(second.result.messages?.[0]?.text).toContain("entry u4");
  });

  test("retained prefix rebinding includes tool arguments and refuses changed history", () => {
    const index = new LiveTranscript();
    const old = [message("assistant", "", { toolUses: [{ tool_use_id: "t", tool: "Read", input: { file_path: "old" } }] })];
    index.remember(old, ["original"]);
    expect(index.resolve([{ ...old[0]!, handle: "clone" }])).toEqual(["original"]);
    const changed = message("assistant", "", { handle: "clone", toolUses: [{ tool_use_id: "t", tool: "Read", input: { file_path: "new" } }] });
    expect(index.resolve([changed])).toEqual(["unknown-0"]);
  });

  test("an engine compaction installs checkpoint + exact handle tail without core", async () => {
    const h = await readyHost();
    const { result, coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(0);
    expect(result.messages?.[0]?.text).toContain("Covers the session through entry a2");
    expect(result.messages?.slice(1).map((entry) => entry.handle)).toEqual(["u3", "a3"]);
    // Handed back is not installed: canonical history must show it.
    expect(await h.status()).toContain("phase=installing");
    h.setCanonical(result.messages!.map(({ handle: _handle, ...rest }) => rest));
    await h.measure(20_000);
    const status = await h.status();
    expect(status).toContain("phase=installed");
    expect(status).toContain("installs=1");
    expect(status).toContain("lastCompact=trigger=auto shadow:");
  });

  test("the index stays aligned after install and a stale checkpoint never re-anchors", async () => {
    const h = await readyHost();
    const { result } = await h.compact(transcript());
    // The engine appends the checkpoint row, then the session continues.
    await h.append("cp", "user", result.messages![0]!.text, "compaction");
    await h.append("u4", "user", "next ask");
    await h.append("a4", "assistant", "next answer");
    const after = [
      { ...message("user", result.messages![0]!.text), handle: "cp" },
      ...transcript(turns.slice(4)),
      { ...message("user", "next ask"), handle: "u4" },
      { ...message("assistant", "next answer"), handle: "a4" },
    ];
    // Same length as the index, but a2 is gone: coverage is unproven.
    const second = await h.compact(after);
    expect(second.coreCalls).toBe(1);
    expect(await h.status()).toContain("lastCompact=trigger=auto native:coverage-unproven");
  });

  test("coverage ending mid-turn never drops the uncovered reply", async () => {
    const h = await readyHost("u2");
    const { result } = await h.compact(transcript());
    expect(result.messages?.slice(1).map((entry) => entry.handle)).toEqual(["u2", "a2", "u3", "a3"]);
  });

  test("duplicate appends do not misalign the index", async () => {
    const h = await readyHost();
    await h.append("a3", "assistant", "latest answer");
    const { coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(0);
  });

  test("precompute is skipped and never reaches core", async () => {
    const h = await readyHost();
    const { result, coreCalls } = await h.compact(transcript(), "precompute");
    expect(coreCalls).toBe(0);
    expect(result.skip).toContain("live compaction");
  });

  test("a compaction Shadow never saw drops the checkpoint", async () => {
    const h = await readyHost();
    await h.append("ns", "user", "native summary", "compaction");
    expect(await h.status()).toContain("checkpoint=none");
    const { coreCalls } = await h.compact([message("user", "native summary")]);
    expect(coreCalls).toBe(1);
  });

  test("native compaction realigns kept handles so a later checkpoint can install", async () => {
    const h = host({ recentTurns: 1 }, covering("u5"));
    for (const [id, role, text] of turns) await h.append(id, role, text);
    // No checkpoint yet: core summarizes and keeps the last turn by handle.
    const summary = longText("native summary");
    const kept = transcript(turns.slice(4));
    const first = await h.compact(transcript(), "auto", [message("user", summary), ...kept]);
    expect(first.coreCalls).toBe(1);
    await h.append("ns", "user", summary, "compaction");
    await h.append("u5", "user", "follow-up ask");
    await h.append("a5", "assistant", "follow-up answer");
    await h.measure(160_000);
    const later = [
      { ...message("user", summary), handle: "ns" },
      ...kept,
      { ...message("user", "follow-up ask"), handle: "u5" },
      { ...message("assistant", "follow-up answer"), handle: "a5" },
    ];
    const second = await h.compact(later);
    expect(second.coreCalls).toBe(0);
    expect(second.result.messages?.slice(1).map((entry) => entry.handle)).toEqual(["u5", "a5"]);
  });

  test("compact-native runs core compaction through the session API", async () => {
    const h = await readyHost();
    const reply = await h.runCommand("compact-native");
    expect(reply.text).toContain("native compaction");
    await h.flush();
    expect(h.selfCompactions).toBe(1);
    expect(await h.status()).toContain("checkpoint=none");
  });

  test("manual shadow-compact is honest with fewer than 2 rows", async () => {
    const h = host();
    const idle = await h.runCommand("shadow-compact");
    expect(idle.text).toContain("need at least 2 archived rows");
    expect(idle.text).toContain("archive rows=0");
  });

  test("agent spawn failure is recorded and fails closed without a checkpoint", async () => {
    const h = host();
    await h.append("u1", "user", "task");
    await h.append("a1", "assistant", "answer");
    await h.measure(160_000);
    expect(h.spawns).toBe(1);
    const status = await h.status();
    expect(status).toContain("checkpoint=none");
    expect(status).toContain("lastFallback=agents:Agents unavailable in test then failed:Models unavailable in test");
    expect(status).toContain("builder=claude:haiku");
    expect(status).toContain("verifier=claude:haiku");
  });
});

describe("checkpoint-first compaction gate", () => {
  test("native compaction cancels in-flight preparation even when native keeps its coverage row", async () => {
    const h = await preparingHost(1000, { compactWaitSeconds: 0 });
    const kept = transcript(turns.slice(2));
    await h.compact(transcript(), "auto", [message("user", longText("native summary")), ...kept]);
    // Coverage a2 survives in the kept tail, but the snapshot predates the
    // native summary: publishing it would displace that summary later.
    expect(h.stoppedAgents).toEqual(["agent-1"]);
    await h.deliverLate();
    await h.deliverLate();
    expect(await h.status()).toContain("checkpoint=none");
    const again = await h.compact([message("user", longText("native summary"), { handle: "cloned-summary" }), ...kept]);
    expect(again.coreCalls).toBe(1);
  });

  test("appends crossing the threshold start preparation mid-turn, without a measure", async () => {
    const h = host({ prepareThresholdTokens: 500 }, undefined, { agentReply: covering("a2"), agentDelaySleeps: 1000 });
    for (const [id, role, text] of turns) await h.append(id, role, text);
    // No measure() call: the append stream itself crossed the estimate.
    expect(h.spawns).toBe(1);
    expect(await h.status()).toContain("phase=preparing");
  });

  test("a just-in-time attempt started by the compaction is waited out to its preparation deadline", async () => {
    const h = host({ recentTurns: 1, compactWaitSeconds: 1 }, undefined, { agentReply: covering("a2"), agentDelaySleeps: 3 });
    for (const [id, role, text] of turns) await h.append(id, role, text);
    expect(h.spawns).toBe(0);
    const { result, coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(0);
    expect(result.messages?.[0]?.text).toContain("Covers the session through entry a2");
    expect(h.sleeps).toBeGreaterThan(1);
    expect(await h.status()).toContain(":done");
  });

  test("a mostly-unknown transcript gets no just-in-time preparation and no wait", async () => {
    const h = host({ recentTurns: 1 }, undefined, { agentReply: covering("a2"), agentDelaySleeps: 2 });
    for (const [id, role, text] of turns) await h.append(id, role, text);
    const live = transcript().map((row, index) => ({ ...row, handle: `bogus-${index}` }));
    const { coreCalls } = await h.compact(live);
    expect(coreCalls).toBe(1);
    expect(h.spawns).toBe(0);
    expect(h.sleeps).toBe(0);
    expect(await h.status()).toContain("native:history-unproven");
  });
  test("one preparation deadline stops agents and prevents later verifier or fallback calls", async () => {
    const h = await preparingHost(1_000, { prepareTimeoutSeconds: 2, compactWaitSeconds: 10 });
    await h.advance(2_000);
    expect(h.stoppedAgents).toEqual(["agent-1"]);
    expect(h.spawns).toBe(1);
    expect(await h.status()).toContain("preparation deadline reached");
    await h.deliverLate();
    expect(h.spawns).toBe(1);
    expect(await h.status()).toContain("checkpoint=none");
  });

  test("a native fallback cancels obsolete preparation without waiting for its late answer", async () => {
    const h = await preparingHost(1_000, { compactWaitSeconds: 1 });
    expect((await h.compact(transcript())).coreCalls).toBe(1);
    expect(h.stoppedAgents).toEqual(["agent-1"]);
    expect([...h.files.keys()].some(path => path.endsWith("/cancel"))).toBe(true);
    await h.deliverLate();
    expect(h.spawns).toBe(1);
  });
  /** Rows archived and preparation started, with agent answers held back. */
  async function preparingHost(delaySleeps: number, options: Record<string, number | string> = {}) {
    const h = host({ recentTurns: 1, ...options }, undefined, { agentReply: covering("a2"), agentDelaySleeps: delaySleeps });
    for (const [id, role, text] of turns) await h.append(id, role, text);
    await h.measure(160_000);
    expect(await h.status()).toContain("phase=preparing");
    return h;
  }

  test("a compaction during preparation waits for the checkpoint and installs it without core", async () => {
    // The builder answers after 3 host sleeps, the verifier 3 after that.
    const h = await preparingHost(3);
    const { result, coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(0);
    expect(result.messages?.[0]?.text).toContain("Covers the session through entry a2");
    expect(result.messages?.slice(1).map((entry) => entry.handle)).toEqual(["u3", "a3"]);
    const status = await h.status();
    expect(status).toContain("lastCompact=trigger=auto shadow:");
    expect(status).toContain(":done");
    expect(h.sleeps).toBeGreaterThan(0);
  });

  test("a preparation outliving the wait falls back to native once and never publishes stale", async () => {
    const h = await preparingHost(1_000, { compactWaitSeconds: 5 });
    const { coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(1);
    expect(h.sleeps).toBe(5);
    expect(await h.status()).toContain("native:no-checkpoint waited=5s:timeout");
    // The slow pipeline finishes after native summarized a2 away.
    await h.append("ns", "user", "native summary", "compaction");
    await h.deliverLate();
    await h.deliverLate();
    const status = await h.status();
    expect(status).toContain("checkpoint=none");
    expect(status).toContain("stale:native compaction replaced history");
  });

  test("with nothing preparing, the compaction starts one just-in-time attempt", async () => {
    const h = host({ recentTurns: 1 }, undefined, { agentReply: covering("a2"), agentDelaySleeps: 2 });
    for (const [id, role, text] of turns) await h.append(id, role, text);
    expect(h.spawns).toBe(0);
    const { result, coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(0);
    expect(h.spawns).toBe(2);
    expect(result.messages?.[0]?.text).toContain("Covers the session through entry a2");
  });

  test("a failed preparation is not retried at compaction", async () => {
    const h = host();
    await h.append("u1", "user", "task");
    await h.append("a1", "assistant", "answer");
    await h.measure(160_000);
    expect(h.spawns).toBe(1);
    const { coreCalls } = await h.compact(transcript(turns.slice(0, 2)));
    expect(coreCalls).toBe(1);
    expect(h.spawns).toBe(1);
    expect(h.sleeps).toBe(0);
  });

  test("compactWaitSeconds 0 keeps the immediate native fallback", async () => {
    const h = await preparingHost(3, { compactWaitSeconds: 0 });
    const { coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(1);
    expect(h.sleeps).toBe(0);
    expect(await h.status()).toMatch(/native:no-checkpoint$/);
  });

  test("a host that cannot sleep stops waiting instead of spinning", async () => {
    const h = host({ recentTurns: 1 }, undefined, { agentReply: covering("a2"), agentDelaySleeps: 3, noSleep: true });
    for (const [id, role, text] of turns) await h.append(id, role, text);
    await h.measure(160_000);
    const { coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(1);
    expect(await h.status()).toContain(":no-pause");
  });

  test("an interrupted held compaction leaves the conversation as it is", async () => {
    const h = await preparingHost(1_000);
    const controller = new AbortController();
    controller.abort();
    const { result, coreCalls } = await h.compact(transcript(), "auto", undefined, controller.signal);
    expect(coreCalls).toBe(0);
    expect(result.skip).toContain("interrupted");
  });
});

const PI_BOTH = {
  builderBackend: "pi",
  verifierBackend: "pi",
  piBuilderProvider: "openrouter",
  piBuilderModel: "builder-model",
  piVerifierProvider: "openrouter",
  piVerifierModel: "verifier-model",
};

const usage = { totalTokens: 1_000, cost: 0.01 };

/** A Pi worker answering like `covering`, echoing each request's nonce. */
const piCovering = (coverage: string): PiWorker => (request) => ({
  nonce: request.nonce,
  ok: true,
  answer: covering(coverage)({ system: request.system, prompt: request.prompt }),
  usage,
  toolRounds: 3,
  durationMs: 10,
});

async function fill(h: ReturnType<typeof host>) {
  for (const [id, role, text] of turns) await h.append(id, role, text);
  await h.measure(160_000);
}

describe("pi backend", () => {
  test("Pi and Claude fallbacks share one deadline and retain per-call artifacts", async () => {
    const failure: PiWorker = request => ({ nonce: request.nonce, ok: false, error: "invalid submission", usage: { totalTokens: 123, cost: 0 }, durationMs: 1500 });
    const h = host({ ...PI_BOTH, recentTurns: 1, prepareTimeoutSeconds: 2 }, undefined, { piWorker: failure, piRunTimeMs: 1500, agentReply: covering("a2"), agentDelaySleeps: 1000 });
    for (const [id, role, text] of turns) await h.append(id, role, text);
    await h.measure(160_000);
    expect(h.piRuns.length).toBe(1);
    expect(h.spawns).toBe(1);
    expect(h.piRuns[0]!.outputPath).toContain(h.piRuns[0]!.nonce);
    expect(h.piRuns[0]!.cancelPath).toContain("/prepare-");
    await h.advance(500);
    expect(h.stoppedAgents).toEqual(["agent-1"]);
    await h.deliverLate();
    expect(h.spawns).toBe(1);
    expect(await h.status()).toContain("preparation deadline reached");
  });
  test("Pi stays off by default and Claude never starts a process", async () => {
    const config = resolveConfig({});
    expect(usesPi(config)).toBe(false);
    expect(describeRole(config, "builder")).toBe("claude:haiku");
    const h = await readyHost();
    expect(await h.status()).toContain("pi=off");
    expect(await h.status()).not.toContain("piUsage");
  });

  test("config resolves per-role backends and needs both provider and model", async () => {
    const config = resolveConfig({ builderBackend: "pi", piBuilderProvider: "openrouter", verifierBackend: "bogus" });
    expect(config.verifierBackend).toBe("claude");
    expect(config.piBuilder).toBe(null);
    expect(describeRole(config, "builder")).toBe("pi:unconfigured");
    expect(describeRole(resolveConfig(PI_BOTH), "verifier")).toBe("pi:openrouter/verifier-model@low");
    expect(resolveConfig(PI_BOTH).piNodePath).toBe("node");
    // Thinking defaults to low; an unknown level falls back to it.
    expect(resolveConfig(PI_BOTH).piBuilder?.thinking).toBe("low");
    const tuned = resolveConfig({ ...PI_BOTH, piBuilderThinking: "high", piVerifierThinking: "loud" });
    expect(describeRole(tuned, "builder")).toBe("pi:openrouter/builder-model@high");
    expect(tuned.piVerifier?.thinking).toBe("low");
  });

  test("Pi answers both roles in separate worker runs and the checkpoint publishes", async () => {
    const h = host({ ...PI_BOTH, recentTurns: 1 }, undefined, { piWorker: piCovering("a2") });
    await fill(h);
    expect(h.spawns).toBe(0);
    expect(h.piRuns.map((run) => `${run.role}:${run.target.model}`)).toEqual([
      "builder:builder-model",
      "verifier:verifier-model",
    ]);
    // Each run gets its own nonce; both read one frozen snapshot.
    expect(new Set(h.piRuns.map((run) => run.nonce)).size).toBe(2);
    expect(h.piRuns[0]!.prompt).toContain(PI_EVIDENCE_ACCESS);
    const evidence = JSON.parse(h.files.get(h.piRuns[0]!.evidencePath)!) as PiEvidenceFile;
    expect(evidence.rows.map((row) => row.id)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
    const status = await h.status();
    expect(status).toContain("checkpoint=shadow-");
    expect(status).toContain("builder=pi:openrouter/builder-model");
    expect(status).toContain("piUsage calls=2 failures=0 tokens=2000 cost=$0.0200");
    expect(status).toContain("lastPrepare=pi ");
    expect(status).toContain("lastFallback=none");
    const { coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(0);
  });

  test("a failed Pi preparation is redone with the Claude models", async () => {
    const failing: PiWorker = (request) => ({ nonce: request.nonce, ok: false, error: "provider 429", usage, durationMs: 5 });
    const h = host({ ...PI_BOTH, recentTurns: 1 }, covering("a2"), { piWorker: failing });
    await fill(h);
    const status = await h.status();
    expect(status).toContain("checkpoint=shadow-");
    expect(status).toContain("lastFallback=pi:pi builder (openrouter/builder-model): provider 429 then agents:");
    expect(status).toContain("lastPrepare=claude-complete ");
    expect(status).toContain("piUsage calls=1 failures=1");
    // Ordinary model failures leave Pi enabled for the next preparation.
    expect(status).toContain("pi=unchecked");
  });

  test("a failed Pi verifier reuses the Pi builder draft with only the Claude verifier", async () => {
    const verifierDown: PiWorker = (request) =>
      request.role === "builder"
        ? piCovering("a2")(request)
        : { nonce: request.nonce, ok: false, error: "submit_verdict rejected 3 times: Checkpoint must be a JSON object", usage, durationMs: 5 };
    const h = host({ ...PI_BOTH, recentTurns: 1 }, covering("a2"), { piWorker: verifierDown, agentReply: covering("a2") });
    await fill(h);
    // Two Pi runs (builder + failed verifier), then ONE Claude spawn: the verifier only.
    expect(h.piRuns.map((run) => run.role)).toEqual(["builder", "verifier"]);
    expect(h.spawns).toBe(1);
    const status = await h.status();
    expect(status).toContain("checkpoint=shadow-");
    expect(status).toContain("pi:pi verifier");
    const { coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(0);
  });

  test("an unusable Pi verdict also falls back to Claude", async () => {
    const unusable: PiWorker = (request) =>
      request.role === "builder"
        ? piCovering("a2")(request)
        : { nonce: request.nonce, ok: true, answer: JSON.stringify({ verdict: "unusable", reason: "ungrounded" }), usage, toolRounds: 1, durationMs: 5 };
    const h = host({ ...PI_BOTH, recentTurns: 1 }, covering("a2"), { piWorker: unusable });
    await fill(h);
    const status = await h.status();
    expect(status).toContain("checkpoint=shadow-");
    expect(status).toContain("lastFallback=pi:Verifier rejected the checkpoint as unusable: ungrounded");
  });

  test("a stale result file from another run is never trusted", async () => {
    const stale: PiWorker = (request) => ({ ...(piCovering("a2")(request) as PiRunResult), nonce: "old-run" });
    const h = host({ ...PI_BOTH, recentTurns: 1 }, covering("a2"), { piWorker: stale });
    await fill(h);
    const status = await h.status();
    expect(status).toContain("checkpoint=shadow-");
    expect(status).toContain("lastPrepare=claude-complete ");
    expect(status).toContain("pi=failed:pi builder worker exited 0");
  });

  test("a worker that cannot run disables Pi for the session instead of relaunching", async () => {
    const h = host({ ...PI_BOTH, recentTurns: 1 }, covering("a2"), { piWorker: () => "crash" });
    await fill(h);
    expect(h.piRuns.length).toBe(1);
    expect(await h.status()).toContain("pi=failed:pi builder worker exited 1: node: bad bundle");
    await h.runCommand("compact-native");
    await h.flush();
    await h.measure(160_000);
    // The second preparation skips Pi entirely.
    expect(h.piRuns.length).toBe(1);
    expect(await h.status()).toContain("lastFallback=pi-unavailable:");
    // Native compaction removed a2, so a checkpoint covering it is born stale.
    expect(await h.status()).toContain("stale:coverage a2 compacted away");
    expect(await h.status()).toContain("checkpoint=none");
  });

  test("mixed mode runs the Pi builder with the Claude agent verifier", async () => {
    const config = { builderBackend: "pi", piBuilderProvider: "openrouter", piBuilderModel: "builder-model", recentTurns: 1 };
    const h = host(config, undefined, { piWorker: piCovering("a2"), agentReply: covering("a2") });
    await fill(h);
    expect(h.piRuns.map((run) => run.role)).toEqual(["builder"]);
    expect(h.spawns).toBe(1);
    const status = await h.status();
    expect(status).toContain("checkpoint=shadow-");
    expect(status).toContain("verifier=claude:haiku");
    expect(status).toContain("lastPrepare=mixed ");
  });

  test("the availability check reports a missing model or credential without inference", async () => {
    const config = resolveConfig(PI_BOTH);
    const fake = (stdout: string, exitCode = 0) =>
      ({ plugin: { root: "/plugin" }, process: { run: async () => ({ exitCode, stdout, stderr: "boom" }) } }) as unknown as EngineInterface;
    const ok = JSON.stringify({ ok: true, targets: [{ role: "builder", ok: true }, { role: "verifier", ok: true }] });
    expect(await checkPi(fake(ok), config)).toBe("ok");
    const noAuth = JSON.stringify({ ok: false, targets: [{ role: "builder", ok: true }, { role: "verifier", ok: false, error: "no auth for openrouter" }] });
    expect(await checkPi(fake(noAuth), config)).toBe("failed:verifier: no auth for openrouter");
    expect(await checkPi(fake("", 127), config)).toBe("failed:worker exited 127: boom");
    expect(await checkPi(fake(ok), resolveConfig({ builderBackend: "pi" }))).toContain("failed:builder needs piBuilderProvider");
  });
});

describe("engine integration", () => {
  test("shadow-status command answers through the engine", async ($, on) => {
    on("session.start", (_$, e) => ({ cwd: e.cwd }));
    await $.session.start({ cwd: "/repo", surface: "terminal", isInteractive: true });
    const result = await $.command.run({
      command: "shadow-status",
      args: "",
      origin: { kind: "composer" },
      presentation: { isFullscreen: false, columns: 80 },
    });
    expect(result.text).toContain("shadow-compact: v");
    expect(result.text).toContain("phase=");
    expect(result.text).toContain("prepare=150000 tokens");
    expect(result.text).toContain("autoCompactWindow=");
    expect(result.text).toContain("builder=claude:haiku");
    expect(result.text).toContain("verifier=claude:haiku");
    expect(result.text).toContain("lastFallback=none");
    expect(result.text).toContain("lastCompact=unseen");
    expect(result.text).toContain("v0.4.7");
  });

  test("compact with no checkpoint defers without inventing messages", async ($, on) => {
    // The test's own hooks sit beneath every plugin and answer as core:
    // a native compaction that keeps the transcript as-is.
    on("session.compact", (_$, e) => ({ messages: e.messages }));
    const result = await $.session.compact({
      trigger: "manual",
      messages: [
        { role: "user", text: "hello", toolUses: [] },
        { role: "assistant", text: "hi there", toolUses: [] },
      ],
    });
    // Either core compacts/skips on an empty test transcript, or a hook
    // vetoed: what must never happen is a fabricated checkpoint message.
    const texts = (result.messages ?? []).map((entry) => entry.text);
    expect(texts.some((text) => text.includes("Continuation Checkpoint"))).toBe(false);
  });
});

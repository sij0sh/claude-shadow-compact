import { describe, expect, test } from "claude-code/testing";
import type { EngineInterface, On, SessionMeasureInput, SessionMessage } from "claude-code";
import {
  renderCheckpoint,
  validateCheckpointObject,
  type Checkpoint,
} from "../hooks/checkpoint.js";
import { decideAutoCompactWindow, decideIdleCompaction, describeModel, isAtOrAbove, resolveConfig, type WindowFacts } from "../hooks/config.js";
import { EvidenceArchive } from "../hooks/evidence.js";
import { redactSecretValue, sanitizeForContext } from "../hooks/normalize.js";
import { prepareCheckpoint } from "../hooks/prepare.js";
import { register } from "../hooks/register.js";
import { ShadowState, type PublishedCheckpoint } from "../hooks/state.js";
import { buildCandidate, hasOrphanedToolResult, isSkipped } from "../hooks/working-context.js";

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

function host(options: Record<string, number | string> = {}, reply?: Reply) {
  type Handler = ($: EngineInterface, e: any, next: (e: any) => Promise<any>) => any;
  const handlers = new Map<string, Handler>();
  const scheduled: Array<() => void> = [];
  const logs: string[] = [];
  let canonical: SessionMessage[] = [];
  let spawns = 0;
  let selfCompactions = 0;
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
      after: (_delay: number, callback: () => void) => scheduled.push(callback),
      sleep: () => new Promise(() => undefined),
    },
    command: { run: async () => { throw new Error("Shadow must not run commands"); } },
    fs: { write: async () => undefined },
    agent: { spawn: async () => {
      spawns += 1;
      throw new Error("Agents unavailable in test");
    } },
    model: { complete: async (request: { system: string; prompt: string }) => {
      if (!reply) throw new Error("Models unavailable in test");
      return reply(request);
    } },
    ui: { log: (text: string) => { logs.push(text); } },
  } as unknown as EngineInterface;
  register(on, options);
  const settle = async () => {
    for (let i = 0; i < 200; i += 1) await Promise.resolve();
  };
  return {
    logs,
    get spawns() { return spawns; },
    get selfCompactions() { return selfCompactions; },
    setCanonical: (messages: SessionMessage[]) => { canonical = messages; },
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
    complete: () => handlers.get("turn.complete")!($, {}, async () => ({})),
    /** A compaction the engine starts; core answers with a one-message summary. */
    compact: async (
      messages: SessionMessage[],
      trigger = "auto",
      core: SessionMessage[] = [message("user", "native summary")],
    ) => {
      let coreCalls = 0;
      const result = await handlers.get("session.compact")!(
        $, { trigger, messages }, async () => {
          coreCalls += 1;
          return { messages: core };
        },
      );
      return { result: result as { messages?: SessionMessage[]; skip?: string }, coreCalls };
    },
    flush: async () => {
      for (const callback of scheduled.splice(0)) callback();
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
  rows.map(([id, role, text]) => ({ ...message(role, text), handle: `h-${id}` }));

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
    expect(await h.status()).toContain("lastFallback=failed:");
  });
});

describe("compaction install", () => {
  test("an engine compaction installs checkpoint + exact handle tail without core", async () => {
    const h = await readyHost();
    const { result, coreCalls } = await h.compact(transcript());
    expect(coreCalls).toBe(0);
    expect(result.messages?.[0]?.text).toContain("Covers the session through entry a2");
    expect(result.messages?.slice(1).map((entry) => entry.handle)).toEqual(["h-u3", "h-a3"]);
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
      { ...message("user", result.messages![0]!.text), handle: "h-cp" },
      ...transcript(turns.slice(4)),
      { ...message("user", "next ask"), handle: "h-u4" },
      { ...message("assistant", "next answer"), handle: "h-a4" },
    ];
    // Same length as the index, but a2 is gone: coverage is unproven.
    const second = await h.compact(after);
    expect(second.coreCalls).toBe(1);
    expect(await h.status()).toContain("lastCompact=trigger=auto native:coverage-unproven");
  });

  test("coverage ending mid-turn never drops the uncovered reply", async () => {
    const h = await readyHost("u2");
    const { result } = await h.compact(transcript());
    expect(result.messages?.slice(1).map((entry) => entry.handle)).toEqual(["h-u2", "h-a2", "h-u3", "h-a3"]);
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
      { ...message("user", summary), handle: "h-ns" },
      ...kept,
      { ...message("user", "follow-up ask"), handle: "h-u5" },
      { ...message("assistant", "follow-up answer"), handle: "h-a5" },
    ];
    const second = await h.compact(later);
    expect(second.coreCalls).toBe(0);
    expect(second.result.messages?.slice(1).map((entry) => entry.handle)).toEqual(["h-u5", "h-a5"]);
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
    expect(status).toContain("lastFallback=failed:Models unavailable in test");
    expect(status).toContain("builder=claude:haiku");
    expect(status).toContain("verifier=claude:haiku");
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
    expect(result.text).toContain("v0.4.2");
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

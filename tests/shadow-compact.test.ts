import { describe, expect, test } from "claude-code/testing";
import type { EngineInterface, On, SessionMeasureInput, SessionMessage } from "claude-code";
import {
  renderCheckpoint,
  validateCheckpointObject,
  type Checkpoint,
} from "../hooks/checkpoint.js";
import { describeBackend, isAtOrAbove, resolveConfig } from "../hooks/config.js";
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
    const rendered = renderCheckpoint(checkpoint);
    expect(rendered).toContain("# Continuation Checkpoint");
    expect(rendered).toContain("Port shadow compact");
    expect(rendered).toContain("[unverified] Nothing verified yet");
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
  test("manifest flags required turns and search finds rows", async () => {
    const archive = archiveWith([
      ["r1", "user", "build the thing"],
      ["r2", "assistant", "working on it"],
      ["r3", "user", "no, use the other API instead"],
      ["r4", "assistant", "switched to other API"],
    ]);
    const manifest = archive.manifest();
    expect(manifest.turnCount).toBe(2);
    expect(manifest.requiredTurnIds).toContain("turn-1");
    expect(archive.search("other API")[0]?.evidenceId).toBe("E0003");
    expect(archive.knownRefs().has("E0004")).toBe(true);
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

  test("candidate keeps checkpoint plus exact tail with handles", async () => {
    const built = buildCandidate(messages, 1, 2, "# Continuation Checkpoint\n\n- state");
    expect(isSkipped(built)).toBe(false);
    if (!isSkipped(built) && built.messages) {
      expect(built.messages[0]?.text).toContain("Continuation Checkpoint");
      expect(built.messages[0]?.handle).toBe(undefined);
      // Tail starts at a turn boundary, never splitting the tool pair.
      expect(built.tailStart).toBeGreaterThanOrEqual(2);
      expect(hasOrphanedToolResult(built.messages.slice(1))).toBe(false);
    }
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
    sessionId: "s1",
    structured: validateCheckpointObject(checkpointJson("E0001"), new Set(["E0001"])),
    rendered: "# Continuation Checkpoint",
    coverage: {
      sourceStartEntryId: null,
      coverageEndEntryId: "r1",
      preparedAtLeafId: "r1",
      publishedAtLeafId: "r1",
    },
    generatedAt: 1,
    prompts: { summaryPromptVersion: 3, verifierPromptVersion: 3 },
    coverageMessageIndex: 0,
  });

  test("generations gate stale publishes and rearm needs install", async () => {
    const state = new ShadowState();
    const first = state.startPreparing();
    expect(first?.generation).toBe(1);
    expect(state.startPreparing()).toBe(undefined);
    state.abortPreparing();
    // A stale completion from the aborted generation cannot publish.
    expect(state.publish(1, published("a"))).toBe(false);
    const second = state.startPreparing();
    expect(state.publish(second!.generation, published("b"))).toBe(true);
    expect(state.refreshArmed).toBe(false);
    expect(state.rearm()).toBe(true);
  });

  test("failure with nothing serving queues native fallback", async () => {
    const state = new ShadowState();
    const attempt = state.startPreparing();
    expect(state.fail(attempt!.generation)).toBe(true);
    expect(state.pendingNativeFallback).toBe(true);
    expect(state.consumeNativeBypass()).toBe(false);
    state.armNativeBypass();
    expect(state.consumeNativeBypass()).toBe(true);
    expect(state.consumeNativeBypass()).toBe(false);
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
});

describe("config", () => {
  test("token defaults and custom threshold ordering hold", async () => {
    const config = resolveConfig({});
    expect(config.prepareThresholdTokens).toBe(160_000);
    expect(config.hardThresholdTokens).toBe(250_000);
    const custom = resolveConfig({ prepareThresholdTokens: 180_000, hardThresholdTokens: 300_000 });
    expect(custom.prepareThresholdTokens).toBe(180_000);
    expect(custom.hardThresholdTokens).toBe(300_000);
    for (const hard of [100_000, 180_000]) {
      const clamped = resolveConfig({ prepareThresholdTokens: 180_000, hardThresholdTokens: hard });
      expect(clamped.hardThresholdTokens).toBe(180_001);
    }
  });

  test("pi backends default to claude with blank pairs", async () => {
    const config = resolveConfig({});
    expect(config.builderBackend).toBe("claude");
    expect(config.verifierBackend).toBe("claude");
    expect(config.builderPi).toEqual({ provider: "", id: "" });
    expect(config.verifierPi).toEqual({ provider: "", id: "" });
    expect(config.piBinary).toBe("pi");
    expect(config.piTimeoutMs).toBe(540_000);
  });

  test("pi pairs require both fields and verifier inherits builder", async () => {
    const half = resolveConfig({ builderBackend: "pi", builderProvider: "openai" });
    expect(half.builderPi).toEqual({ provider: "", id: "" });
    const full = resolveConfig({
      builderBackend: "pi",
      builderProvider: "openai",
      builderId: "gpt-5-mini",
    });
    expect(full.builderBackend).toBe("pi");
    expect(full.builderPi).toEqual({ provider: "openai", id: "gpt-5-mini" });
    expect(full.verifierBackend).toBe("claude");
    expect(full.verifierPi).toEqual({ provider: "openai", id: "gpt-5-mini" });
    const own = resolveConfig({
      builderBackend: "pi",
      builderProvider: "openai",
      builderId: "gpt-5-mini",
      verifierBackend: "pi",
      verifierProvider: "google",
      verifierId: "gemini-3",
    });
    expect(own.verifierPi).toEqual({ provider: "google", id: "gemini-3" });
    expect(resolveConfig({ builderBackend: "PI" }).builderBackend).toBe("pi");
    expect(resolveConfig({ builderBackend: "bogus" }).builderBackend).toBe("claude");
  });

  test("pi thinking levels parse and verifier inherits builder", async () => {
    expect(resolveConfig({}).builderThinking).toBe("");
    expect(resolveConfig({}).verifierThinking).toBe("");
    const full = resolveConfig({ builderThinking: "HIGH", verifierThinking: "XHigh" });
    expect(full.builderThinking).toBe("high");
    expect(full.verifierThinking).toBe("xhigh");
    expect(resolveConfig({ builderThinking: "high" }).verifierThinking).toBe("high");
    expect(resolveConfig({ builderThinking: "turbo" }).builderThinking).toBe("");
    expect(describeBackend("pi", "inherit", { provider: "meta", id: "muse-spark-1.3-contributor" }, "high"))
      .toBe("pi:meta/muse-spark-1.3-contributor:high");
    expect(describeBackend("pi", "inherit", { provider: "", id: "" }, ""))
      .toBe("pi:default");
    expect(describeBackend("claude", "sonnet", { provider: "", id: "" }, ""))
      .toBe("claude:sonnet");
  });

  test("pi binary and timeout fall back and clamp", async () => {
    expect(resolveConfig({ piBinary: "" }).piBinary).toBe("pi");
    expect(resolveConfig({ piBinary: " /usr/bin/pi " }).piBinary).toBe("/usr/bin/pi");
    expect(resolveConfig({ piTimeoutMs: 0 }).piTimeoutMs).toBe(540_000);
    expect(resolveConfig({ piTimeoutMs: "bad" }).piTimeoutMs).toBe(540_000);
    expect(resolveConfig({ piTimeoutMs: 999_999 }).piTimeoutMs).toBe(600_000);
    expect(resolveConfig({ piTimeoutMs: 60_000 }).piTimeoutMs).toBe(60_000);
  });

  test("invalid token settings use defaults and always leave room for ordering", async () => {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "bad", "", true, false]) {
      const config = resolveConfig({ prepareThresholdTokens: invalid, hardThresholdTokens: invalid });
      expect(config.prepareThresholdTokens).toBe(160_000);
      expect(config.hardThresholdTokens).toBe(250_000);
    }
    const max = resolveConfig({ prepareThresholdTokens: Number.MAX_SAFE_INTEGER });
    expect(max.prepareThresholdTokens).toBe(160_000);
    expect(max.hardThresholdTokens).toBeGreaterThan(max.prepareThresholdTokens);
    expect(resolveConfig({ prepareThresholdTokens: "200000" }).prepareThresholdTokens).toBe(200_000);
  });

  test("only absolute token usage triggers thresholds, including the exact boundary", async () => {
    expect(isAtOrAbove({ tokens: 159_999, percent: 99 }, 160_000)).toBe(false);
    expect(isAtOrAbove({ tokens: 160_000, percent: 16 }, 160_000)).toBe(true);
    expect(isAtOrAbove({ tokens: 250_001 }, 250_000)).toBe(true);
    for (const tokens of [undefined, null, NaN, Infinity]) {
      expect(isAtOrAbove({ tokens, percent: 100 }, 160_000)).toBe(false);
    }
    const legacy = resolveConfig({ prepareThresholdPercent: 1, swapThresholdPercent: 2, nativeFallbackThresholdPercent: 3 });
    expect(legacy.prepareThresholdTokens).toBe(160_000);
    expect(legacy.hardThresholdTokens).toBe(250_000);
  });
});

// Drive the registered hooks with a small host so threshold scheduling is
// deterministic and never invokes real model calls or native compaction.
function thresholdHost(
  options: Record<string, number | string> = {},
  messages: SessionMessage[] = [],
  processImpl?: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
) {
  type Handler = ($: EngineInterface, e: any, next: (e: any) => Promise<any>) => any;
  const handlers = new Map<string, Handler>();
  const scheduled: Array<() => void> = [];
  const commands: string[] = [];
  const processCalls: string[][] = [];
  const stored: unknown[] = [];
  let busy = false;
  let preparations = 0;
  const on = ((event: string, ...args: unknown[]) => {
    handlers.set(event, args[args.length - 1] as Handler);
  }) as On;
  const $ = {
    plugin: { root: "/plugin" },
    session: {
      cwd: async () => "/repo",
      id: async () => "threshold-test",
      messages: async () => messages,
    },
    store: {
      get: async () => undefined,
      set: async (_key: string, value: unknown) => { stored.push(value); },
    },
    process: { run: async (argv: readonly string[]) => {
      processCalls.push([...argv]);
      if (!processImpl) throw new Error("pi not installed");
      return processImpl(argv);
    } },
    clock: { after: (_delay: number, callback: () => void) => scheduled.push(callback) },
    command: { run: async ({ command }: { command: string }) => {
      commands.push(command);
      if (busy) throw new Error("A turn is running");
    } },
    fs: { write: async () => undefined },
    agent: { spawn: async () => {
      preparations += 1;
      throw new Error("Agents unavailable in test");
    } },
    model: { complete: async () => { throw new Error("Models unavailable in test"); } },
    ui: { log: () => undefined },
  } as unknown as EngineInterface;
  register(on, options);
  return {
    commands,
    scheduled,
    processCalls,
    stored,
    get preparations() { return preparations; },
    setBusy: (value: boolean) => { busy = value; },
    measure: (tokens?: number, percent = 0) => handlers.get("session.measure")!(
      $, { context: { window: 1_000_000, ...(tokens !== undefined ? { tokens } : {}), percent }, changed: ["context"], rateLimits: [] } as SessionMeasureInput,
      async (e) => ({ changed: e.changed }),
    ),
    complete: () => handlers.get("turn.complete")!($, {}, async () => ({})),
    nativeCompact: () => handlers.get("session.compact")!(
      $, { trigger: "auto", messages: [] }, async () => ({ messages: [] }),
    ),
    flush: async () => {
      for (const callback of scheduled.splice(0)) callback();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
  };
}

describe("token threshold scheduling", () => {
  test("checkpoint preparation starts at the token boundary without percentage usage", async () => {
    const host = thresholdHost({}, [message("user", "task"), message("assistant", "answer")]);
    await host.measure(159_999, 99);
    await host.flush();
    expect(host.preparations).toBe(0);
    await host.measure(160_000);
    await host.flush();
    expect(host.preparations).toBe(1);
    expect(host.commands.length).toBe(0);
  });

  test("a lower measurement cancels a queued hard-limit compaction", async () => {
    const host = thresholdHost();
    await host.measure(250_000);
    await host.measure(150_000);
    await host.flush();
    expect(host.commands.length).toBe(0);
  });

  test("hard limit requests compaction without a checkpoint or native auto trigger", async () => {
    const host = thresholdHost();
    await host.measure(249_999, 99);
    expect(host.scheduled.length).toBe(0);
    host.setBusy(true);
    await host.measure(250_000, 25);
    await host.measure(260_000, 26);
    expect(host.scheduled.length).toBe(1);
    await host.flush();
    expect(host.commands).toEqual(["compact"]);
    // A busy-turn refusal must allow another attempt at turn completion.
    host.setBusy(false);
    await host.complete();
    await host.flush();
    expect(host.commands).toEqual(["compact", "compact"]);
    await host.nativeCompact();
    await host.complete();
    expect(host.scheduled.length).toBe(0);
  });

  test("custom hard limits use tokens even without a percentage", async () => {
    const host = thresholdHost({ prepareThresholdTokens: 200_000, hardThresholdTokens: 300_000 });
    await host.measure(250_000);
    expect(host.scheduled.length).toBe(0);
    await host.measure(300_000);
    await host.flush();
    expect(host.commands).toEqual(["compact"]);
  });

  test("missing token usage cannot trigger compaction from percent alone", async () => {
    const host = thresholdHost();
    await host.measure(undefined, 100);
    await host.complete();
    expect(host.scheduled.length).toBe(0);
  });
});

describe("pi bridge backend", () => {
  const twoRows = [message("user", "task"), message("assistant", "answer")];
  const piOptions = {
    builderBackend: "pi",
    builderProvider: "openai",
    builderId: "gpt-5-mini",
    builderThinking: "high",
    verifierBackend: "pi",
    verifierThinking: "xhigh",
  };

  function piReplies(argv: readonly string[]) {
    const system = argv[argv.indexOf("--system-prompt") + 1] ?? "";
    if (system.includes("create evidence-grounded")) {
      return JSON.stringify({ checkpoint: checkpointJson("E0001"), coverageEndEntryId: "bootstrap-1" });
    }
    return JSON.stringify({ verdict: "accept", reason: "grounded" });
  }

  test("pi backend publishes without touching Claude agents", async () => {
    const host = thresholdHost(piOptions, twoRows, async (argv) => ({
      exitCode: 0,
      stdout: piReplies(argv),
      stderr: "",
    }));
    await host.measure(160_000);
    await host.flush();
    expect(host.preparations).toBe(0);
    expect(host.processCalls.length).toBe(2);
    const builderArgv = host.processCalls[0] ?? [];
    expect(builderArgv[0]).toBe("pi");
    expect(builderArgv).toContain("--no-tools");
    expect(builderArgv).toContain("--no-session");
    expect(builderArgv).toContain("--model");
    expect(builderArgv).toContain("gpt-5-mini");
    expect(builderArgv).toContain("--provider");
    expect(builderArgv).toContain("openai");
    expect(builderArgv).toContain("--thinking");
    expect(builderArgv).toContain("high");
    const verifierArgv = host.processCalls[1] ?? [];
    expect(verifierArgv).toContain("xhigh");
    expect(host.stored.length).toBe(1);
  });

  test("bad bridge output falls back to the Claude agent", async () => {
    const host = thresholdHost(piOptions, twoRows, async () => ({
      exitCode: 0,
      stdout: "no json here",
      stderr: "",
    }));
    await host.measure(160_000);
    await host.flush();
    expect(host.processCalls.length).toBe(1);
    // The Claude agent spawn was tried after the bridge answer failed validation.
    expect(host.preparations).toBe(1);
    expect(host.stored.length).toBe(0);
  });

  test("bridge exit failure falls back to the Claude agent", async () => {
    const host = thresholdHost(piOptions, twoRows, async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    }));
    await host.measure(160_000);
    await host.flush();
    expect(host.processCalls.length).toBe(1);
    expect(host.preparations).toBe(1);
    expect(host.stored.length).toBe(0);
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
    expect(result.text).toContain("shadow-compact: phase=");
    expect(result.text).toContain("prepare=160000 tokens hard=250000 tokens");
    expect(result.text).toContain("builder=claude:inherit");
    expect(result.text).toContain("verifier=claude:inherit");
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

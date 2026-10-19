// Small compatibility adapter for running the same hook tests under Node.
// This is test-only; Claude Code continues using its own testing module.
import assert from "node:assert/strict";
import { isDeepStrictEqual, inspect } from "node:util";
import { test as nodeTest } from "node:test";
export { describe } from "node:test";

export function test(name, run) {
  // Engine fixtures ($, on) are supplied only by the actual Claude host.
  if (run.length) return nodeTest(name, { skip: "requires the Claude Code engine fixture" }, () => {});
  return nodeTest(name, run);
}

function partial(actual, expected) {
  if (!expected || typeof expected !== "object") return isDeepStrictEqual(actual, expected);
  return actual !== null && typeof actual === "object" &&
    Object.entries(expected).every(([key, value]) => partial(actual[key], value));
}

function errorMatches(error, expected) {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  return expected instanceof RegExp ? expected.test(message) : message.includes(String(expected));
}

export function expect(actual, negated = false) {
  const check = (condition, label, expected) => assert.ok(negated ? !condition : condition,
    `Expected ${inspect(actual)} ${negated ? "not " : ""}${label} ${inspect(expected)}`);
  return {
    get not() { return expect(actual, !negated); },
    toBe: expected => check(Object.is(actual, expected), "to be", expected),
    toEqual: expected => check(isDeepStrictEqual(actual, expected), "to equal", expected),
    toMatchObject: expected => check(partial(actual, expected), "to match object", expected),
    toMatch: expected => check(expected.test(actual), "to match", expected),
    toContain: expected => check(actual.includes(expected), "to contain", expected),
    toBeGreaterThan: expected => check(actual > expected, "to exceed", expected),
    toBeGreaterThanOrEqual: expected => check(actual >= expected, "to be at least", expected),
    toThrow(expected) {
      let thrown = false;
      let error;
      try { actual(); } catch (caught) { thrown = true; error = caught; }
      check(thrown && errorMatches(error, expected), `to throw (received ${inspect(error)})`, expected);
    },
    get rejects() {
      return { async toThrow(expected) {
        let thrown = false;
        let error;
        try { await actual; } catch (caught) { thrown = true; error = caught; }
        check(thrown && errorMatches(error, expected), `to reject (received ${inspect(error)})`, expected);
      } };
    },
  };
}

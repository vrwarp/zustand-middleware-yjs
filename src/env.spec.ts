/*
 * `isDevEnvironment` gates the scopedDiff divergence tripwire and the
 * syncedKeys misconfiguration checks, so getting it wrong either disables
 * those guards in development or runs them in production. It had no direct
 * test — mutation testing reported every branch of it as surviving or
 * uncovered.
 */
import { isDevEnvironment } from "./env";

describe("isDevEnvironment", () => {
  const globals = globalThis as { process?: { env?: Record<string, string | undefined> } };
  let original: { env?: Record<string, string | undefined> } | undefined;

  beforeEach(() => {
    original = globals.process;
  });

  afterEach(() => {
    globals.process = original;
  });

  it("is false in production", () => {
    globals.process = { "env": { "NODE_ENV": "production" } };

    expect(isDevEnvironment()).toBe(false);
  });

  it("is true in development", () => {
    globals.process = { "env": { "NODE_ENV": "development" } };

    expect(isDevEnvironment()).toBe(true);
  });

  it("is true under test", () => {
    globals.process = { "env": { "NODE_ENV": "test" } };

    expect(isDevEnvironment()).toBe(true);
  });

  it("is true for any other non-production value", () => {
    globals.process = { "env": { "NODE_ENV": "staging" } };

    expect(isDevEnvironment()).toBe(true);
  });

  /*
   * The browser case: no `process` at all. This must be false, not true —
   * a bundled production app would otherwise pay the tripwire's full-tree
   * diff. Covers both optional-chaining links.
   */
  it("is false when there is no process global (browser bundle)", () => {
    delete globals.process;

    expect(isDevEnvironment()).toBe(false);
  });

  it("is false when process exists but has no env", () => {
    globals.process = {};

    expect(isDevEnvironment()).toBe(false);
  });

  it("is false when NODE_ENV is unset", () => {
    globals.process = { "env": {} };

    expect(isDevEnvironment()).toBe(false);
  });

  it("is false when NODE_ENV is not a string", () => {
    globals.process = { "env": { "NODE_ENV": undefined } };

    expect(isDevEnvironment()).toBe(false);
  });
});

/**
 * Dev-environment detection without depending on `@types/node` or any
 * bundler-specific globals.
 *
 * The loud dev-mode failures of the fork surgeries — the `syncedKeys`
 * misconfiguration errors at store creation and the `scopedDiff` divergence
 * sampling assert — run only when this returns `true`. Resolution order:
 * first `process.env.NODE_ENV !== "production"` on Node-ish or bundled hosts
 * (webpack/rollup/vite statically replace this expression, so the dev-only
 * branches tree-shake out of production builds); otherwise NOT dev (fail safe
 * — never throw in an unknown production host).
 *
 * `process` is read off `globalThis` rather than referenced directly so the
 * library type-checks without `@types/node` and stays safe in the browser.
 */
export const isDevEnvironment = (): boolean => {
  const nodeEnv = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env?.NODE_ENV;

  if (typeof nodeEnv === "string") {
    return nodeEnv !== "production";
  }

  return false;
};

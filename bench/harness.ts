/*
 * Minimal benchmark harness: warmup + repeated timed runs, reporting median /
 * p95 / mean. Deterministic PRNG so every run exercises identical data.
 */
import { performance } from "node:perf_hooks";

export interface BenchResult {
  name: string;
  runs: number;
  medianMs: number;
  meanMs: number;
  p95Ms: number;
  minMs: number;
  /** Optional scenario-specific metadata (doc sizes, op counts...). */
  meta?: Record<string, string | number>;
}

export interface BenchOptions {
  runs?: number;
  warmupRuns?: number;
  /** Fresh fixture per run (excluded from timing). */
  setup?: () => unknown;
}

const summarize = (name: string, runs: number, samples: number[]): BenchResult => {
  samples.sort((left, right) => left - right);

  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;

  return {
    name,
    runs,
    medianMs: samples[Math.floor(samples.length / 2)],
    meanMs: mean,
    p95Ms: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)],
    minMs: samples[0],
  };
};

export const bench = (
  name: string,
  fn: (fixture: unknown) => void,
  { runs = 20, warmupRuns = 3, setup }: BenchOptions = {}
): BenchResult => {
  for (let index = 0; index < warmupRuns; index = index + 1) {
    fn(setup?.());
  }

  const samples: number[] = [];

  for (let index = 0; index < runs; index = index + 1) {
    const fixture = setup?.();
    const start = performance.now();

    fn(fixture);
    samples.push(performance.now() - start);
  }

  return summarize(name, runs, samples);
};

export interface AsyncBenchOptions extends BenchOptions {
  /**
   * Untimed hook awaited after every run (warmups included). Use it to drain
   * the microtask a run scheduled (the middleware batches inbound patches on
   * one), so that work neither leaks into the next sample nor keeps every
   * fixture alive until the synchronous suite ends.
   */
  afterRun?: (fixture: unknown) => Promise<void> | void;
}

/**
 * Same as `bench`, for scenarios whose timed part is synchronous but whose
 * fixtures leave asynchronous work behind.
 *
 * @param name - Row label.
 * @param fn - The timed (synchronous) body.
 * @param options - Runs, warmups, per-run setup and the untimed afterRun hook.
 * @returns A promise for the summarized samples.
 */
export const benchAsync = async (
  name: string,
  fn: (fixture: unknown) => void,
  { runs = 20, warmupRuns = 3, setup, afterRun }: AsyncBenchOptions = {}
): Promise<BenchResult> => {
  for (let index = 0; index < warmupRuns; index = index + 1) {
    const fixture = setup?.();

    fn(fixture);
    await afterRun?.(fixture);
  }

  const samples: number[] = [];

  for (let index = 0; index < runs; index = index + 1) {
    const fixture = setup?.();
    const start = performance.now();

    fn(fixture);
    samples.push(performance.now() - start);
    await afterRun?.(fixture);
  }

  return summarize(name, runs, samples);
};

/** Deterministic PRNG (mulberry32) so fixtures are identical across runs. */
export const makeRandom = (seed: number): (() => number) => {
  let state = seed;

  return () => {
    state = state | 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ.,\n";

export const randomText = (length: number, random: () => number): string => {
  let text = "";

  for (let index = 0; index < length; index = index + 1) {
    text = text + ALPHABET[Math.floor(random() * ALPHABET.length)];
  }

  return text;
};

export const formatTable = (results: BenchResult[]): string => {
  const header = "| benchmark | median (ms) | mean (ms) | p95 (ms) | min (ms) | notes |";
  const divider = "|---|---:|---:|---:|---:|---|";
  const rows = results.map((result) => {
    const meta = result.meta
      ? Object.entries(result.meta).map(([key, value]) => `${key}=${String(value)}`)
        .join(", ")
      : "";

    return `| ${result.name} | ${result.medianMs.toFixed(3)} | ` +
      `${result.meanMs.toFixed(3)} | ${result.p95Ms.toFixed(3)} | ` +
      `${result.minMs.toFixed(3)} | ${meta} |`;
  });

  return [header, divider, ...rows].join("\n");
};

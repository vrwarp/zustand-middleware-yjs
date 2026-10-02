/*
 * Runs only the cold-start representation scenario from bench/versicle.ts
 * (json-leaf-records-for-cold-start), which `npm run bench` also runs.
 *
 * Usage: npx ts-node -T -P bench/tsconfig.json bench/cold-start.ts [agedBooks]
 */
import { __scopedDiffDevSampling } from "../src";
import { runColdStartRepresentationBench } from "./versicle";

// Deterministic perf runs: the DEV tripwire serializes the whole map at random.
__scopedDiffDevSampling.rate = 0;

const agedBooksArgument = Number(process.argv[2]);

// eslint-disable-next-line no-console
console.log(`\n${runColdStartRepresentationBench(
  Number.isInteger(agedBooksArgument) && agedBooksArgument > 0 ? { "agedBooks": agedBooksArgument } : {}
)}`);

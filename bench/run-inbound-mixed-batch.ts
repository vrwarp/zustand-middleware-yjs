/* eslint-disable unicorn/prefer-top-level-await -- ts-node runs benches as CommonJS (no top-level await) */
/*
 * Runs only the inbound mixed-batch scenario (bench/inbound-mixed-batch.ts),
 * which `npm run bench` also includes:
 *
 *   npx ts-node -T -P bench/tsconfig.json bench/run-inbound-mixed-batch.ts
 */
import { runInboundMixedBatchBench } from "./inbound-mixed-batch";

runInboundMixedBatchBench()
  .then((report) => {
    // eslint-disable-next-line no-console
    console.log(`\n${report}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

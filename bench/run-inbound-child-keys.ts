/* eslint-disable unicorn/prefer-top-level-await -- ts-node runs benches as CommonJS (no top-level await) */
/*
 * Runs only the inbound child-key add / delete scenario
 * (bench/inbound-child-keys.ts), which `npm run bench` also includes:
 *
 *   npx ts-node -T -P bench/tsconfig.json bench/run-inbound-child-keys.ts
 */
import { runInboundChildKeyBench } from "./inbound-child-keys";

runInboundChildKeyBench()
  .then((report) => {
    // eslint-disable-next-line no-console
    console.log(`\n${report}`);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

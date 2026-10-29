// Mutation testing, nightly — never a gate (measured-console phase 15).
//
// `npm run test:mutation` (scripts/nightly-mutation.mjs) mutates the server and
// shared modules a diff touched (`--mutate`, computed from `git diff <base>`)
// and runs the node tests that name them against each mutant; `--incremental`
// keeps `.cache/stryker-incremental.json`, so a night re-tests only what moved.
// A surviving mutant is a line no test can tell apart from its opposite: a
// finding for the module's owner, never a red.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: { command: process.env.STRYKER_TEST_COMMAND ?? 'npm test' },
  incremental: true,
  incrementalFile: '.cache/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: '.cache/stryker-report.json' },
  tempDirName: '.cache/stryker-tmp',
  concurrency: 2,
  timeoutMS: 120_000,
  thresholds: { high: 80, low: 60, break: null },
};

/**
 * The suite ledger, for the suites' own command lines — `npm test`
 * (`viewer/package.json`) and `scripts/gates.sh` name it as
 * `./test/suite-ledger.mjs`. The reporter itself lives in
 * `server/runner/suite-ledger.mjs`, because the console ships it and injects it
 * into every §Verification node line (measured-console phase 7).
 */
export { default, ledgerGaps } from '../server/runner/suite-ledger.mjs';

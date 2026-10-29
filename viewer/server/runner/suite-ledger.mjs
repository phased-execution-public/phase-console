/**
 * The suite ledger — a `node --test` reporter that writes, per test file, how
 * many top-level tests the file ENQUEUED and how many FINISHED (passed, failed,
 * skipped or todo), one TSV line each:
 *
 *   <file, relative to the cwd>\t<enqueued>\t<finished>
 *
 * Why it exists (#339): `node --test` reports a file whose process stops part
 * way — a `process.exit`, a crash the runner reads as a clean exit — as green,
 * and the run ends `fail 0` with the file's later tests simply never named. A
 * file that ran to its end finishes every test it enqueued; one that stopped
 * does not, and one that stopped before it reported anything shows only the
 * runner's own stand-in for the file (a test named after the file's path),
 * which counts as nothing here.
 *
 * So the reporter does not only write: when the stream ends it names every file
 * with a gap on stderr (`suite gap: …`, the words `scripts/gates.sh`'s own
 * check prints) and sets the run's exit code to 1, so a file that stops part way
 * never reads green — in `npm test` (`viewer/package.json`), in every
 * `node --test` the release gate runs, and in every §Verification node line the
 * console runs, where it arrives through `NODE_OPTIONS` (measured-console phase
 * 7, the audit's C6; `runner/verify.ts` `ledgerNodeOptions`). The gate's
 * server-suite stage still compares the ledger with the files it PLANNED, the
 * one gap a reporter cannot see: a file that never started at all.
 *
 * It lives under `server/` because the console ships it — the packages carry no
 * `test/` — and `test/suite-ledger.mjs` re-exports it for the suites' own use.
 *
 * Used beside the spec reporter: `--test-reporter=spec
 * --test-reporter-destination=stdout --test-reporter=<this file>
 * --test-reporter-destination=<ledger>`.
 */
import { relative } from 'node:path';

/** The runner's stand-in for a whole file is named after the file's own path. */
const standsForFile = (data) =>
  Boolean(data.file) && (data.name === data.file || data.file.endsWith(`/${data.name}`));

/** One line per file that did not report in full, in the gate's own words. */
export function ledgerGaps(rows) {
  const gaps = [];
  for (const [file, row] of rows) {
    if (row.enqueued === 0) gaps.push(`suite gap: ${file} reported none of its own tests — it stopped before it began`);
    else if (row.finished < row.enqueued) {
      gaps.push(`suite gap: ${file} stopped part way — ${row.finished} of ${row.enqueued} tests reported`);
    }
  }
  return gaps;
}

export default async function* suiteLedger(source) {
  /** @type {Map<string, { enqueued: number, finished: number }>} */
  const files = new Map();
  const of = (file) => {
    const key = relative(process.cwd(), file);
    if (!files.has(key)) files.set(key, { enqueued: 0, finished: 0 });
    return files.get(key);
  };
  for await (const event of source) {
    const data = event.data;
    if (!data?.file || data.nesting !== 0) continue;
    const row = of(data.file);
    if (standsForFile(data)) continue;
    if (event.type === 'test:enqueue') row.enqueued += 1;
    else if (event.type === 'test:pass' || event.type === 'test:fail') row.finished += 1;
  }
  const rows = [...files].sort(([a], [b]) => a.localeCompare(b));
  for (const [file, row] of rows) yield `${file}\t${row.enqueued}\t${row.finished}\n`;
  const gaps = ledgerGaps(rows);
  if (gaps.length) {
    process.stderr.write(`${gaps.join('\n')}\n${gaps.length} file(s) did not report in full: the suite is NOT green\n`);
    process.exitCode = 1;
  }
}

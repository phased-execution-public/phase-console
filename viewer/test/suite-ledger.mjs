/**
 * The server suite's ledger — a `node --test` reporter that writes, per test
 * file, how many top-level tests the file ENQUEUED and how many FINISHED
 * (passed, failed, skipped or todo), one TSV line each:
 *
 *   <file, relative to the cwd>\t<enqueued>\t<finished>
 *
 * Why it exists (#339): `node --test` reports a file whose process stops part
 * way — a `process.exit`, a crash the runner reads as a clean exit — as green,
 * and the run ends `fail 0` with the file's later tests simply never named. A
 * file that ran to its end finishes every test it enqueued; one that stopped
 * does not, and one that stopped before it reported anything shows only the
 * runner's own stand-in for the file (a test named after the file's path),
 * which counts as nothing here. `scripts/gates.sh`'s server-suite stage reads
 * this ledger against the files it planned and fails on any gap.
 *
 * Used beside the spec reporter: `--test-reporter=spec
 * --test-reporter-destination=stdout --test-reporter=./test/suite-ledger.mjs
 * --test-reporter-destination=<ledger>`.
 */
import { relative } from 'node:path';

/** The runner's stand-in for a whole file is named after the file's own path. */
const standsForFile = (data) =>
  Boolean(data.file) && (data.name === data.file || data.file.endsWith(`/${data.name}`));

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
  for (const [file, row] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    yield `${file}\t${row.enqueued}\t${row.finished}\n`;
  }
}

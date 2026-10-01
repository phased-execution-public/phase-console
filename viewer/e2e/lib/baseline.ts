/**
 * The ratchet: `e2e/baseline.json` holds every finding the tour is allowed to
 * make, per viewport, per stop, per class, as a count per key. It moves ONE way
 * at a time, and both ways are enforced:
 *
 *   - a finding the baseline does not hold (or more of it than it holds) fails
 *     — a regression, whatever page it is on;
 *   - a baselined finding that no longer happens ALSO fails, until it is
 *     removed — so a fix is banked the moment it lands and the count can only
 *     go down. A baseline that is allowed to hold stale rows is a baseline a
 *     regression can hide inside.
 *
 * `npm run test:e2e:baseline` rewrites it from what the register measures
 * (`PHASE_CONSOLE_E2E_BASELINE=write`): every register test leaves its own
 * findings under `e2e/.results/baseline/`, and `baselineTeardown` below — the
 * config's `globalTeardown` in that mode — folds them in, keeping the stops and
 * viewports this run did not measure. Accepting a NEW finding that way is a
 * decision, and belongs in the commit that makes it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FINDING_CLASSES, type Finding } from './probes.ts';
import { STOPS, VIEWPORTS } from './shots.ts';

export const BASELINE_FILE = fileURLToPath(new URL('../baseline.json', import.meta.url));
const FRAGMENTS = fileURLToPath(new URL('../.results/baseline', import.meta.url));

/** class → key → count, for one stop in one viewport. */
export type Tally = Record<string, Record<string, number>>;
type Baseline = { note: string; stops: Record<string, Record<string, Tally>> };

export const writing = (): boolean => process.env.PHASE_CONSOLE_E2E_BASELINE === 'write';

export function tally(found: Finding[]): Tally {
  const out: Tally = {};
  for (const f of found) {
    const byKey = (out[f.cls] ??= {});
    byKey[f.key] = (byKey[f.key] ?? 0) + 1;
  }
  return sortTally(out);
}

function sortTally(t: Tally): Tally {
  const out: Tally = {};
  for (const cls of FINDING_CLASSES) {
    const byKey = t[cls];
    if (!byKey || !Object.keys(byKey).length) continue;
    out[cls] = Object.fromEntries(Object.entries(byKey).sort(([a], [b]) => a.localeCompare(b)));
  }
  return out;
}

/**
 * The file, read. Since 6.0 (control-tower phase 31) it is `[]` — the EMPTY
 * register: no finding is tolerated anywhere, so every finding fails as NEW.
 * The object shape is what a write produces while findings remain; it is still
 * read, for the day a phase has to bank one on purpose and say why.
 */
export function readBaseline(): Baseline {
  if (!existsSync(BASELINE_FILE)) return { note: '', stops: {} };
  const raw = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline | unknown[];
  if (Array.isArray(raw)) {
    if (raw.length)
      throw new Error(`${BASELINE_FILE}: an array baseline must be empty — \`[]\` is the empty register`);
    return { note: '', stops: {} };
  }
  return raw;
}

/** What the register found against what the baseline allows: new above, fixed below. */
export function compare(allowed: Tally, found: Tally): { added: string[]; fixed: string[] } {
  const added: string[] = [];
  const fixed: string[] = [];
  for (const cls of FINDING_CLASSES) {
    const a = allowed[cls] ?? {};
    const f = found[cls] ?? {};
    for (const key of new Set([...Object.keys(a), ...Object.keys(f)])) {
      const was = a[key] ?? 0;
      const now = f[key] ?? 0;
      if (now > was) added.push(`${cls}  ${key}${now - was > 1 ? `  ×${now - was}` : ''}`);
      if (now < was) fixed.push(`${cls}  ${key}${was - now > 1 ? `  ×${was - now}` : ''}`);
    }
  }
  return { added, fixed };
}

/** In write mode: leave this stop's findings for the teardown to fold in. */
export function leaveFragment(project: string, stop: string, found: Tally): void {
  mkdirSync(FRAGMENTS, { recursive: true });
  writeFileSync(join(FRAGMENTS, `${project}__${stop}.json`), JSON.stringify({ project, stop, found }));
}

/** Counts by class, over a whole baseline or one viewport of it — what a handoff quotes. */
export function totals(stops: Baseline['stops'], project?: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [p, byStop] of Object.entries(stops)) {
    if (project && p !== project) continue;
    for (const t of Object.values(byStop)) {
      for (const [cls, byKey] of Object.entries(t)) {
        out[cls] = (out[cls] ?? 0) + Object.values(byKey).reduce((n, c) => n + c, 0);
      }
    }
  }
  return out;
}

export default async function baselineTeardown(): Promise<void> {
  if (!existsSync(FRAGMENTS)) return;
  const base = readBaseline();
  for (const file of readdirSync(FRAGMENTS).filter((f) => f.endsWith('.json'))) {
    const { project, stop, found } = JSON.parse(readFileSync(join(FRAGMENTS, file), 'utf8')) as {
      project: string;
      stop: string;
      found: Tally;
    };
    (base.stops[project] ??= {})[stop] = found;
  }
  // Only the viewports and stops the tour still has, in the tour's own order —
  // a destination that left `route-meta.js` takes its rows with it.
  const stops: Baseline['stops'] = {};
  for (const v of VIEWPORTS) {
    const byStop = base.stops[v.name];
    if (!byStop) continue;
    const kept: Record<string, Tally> = {};
    for (const s of STOPS) {
      const t = byStop[s.name];
      if (t && Object.keys(t).length) kept[s.name] = sortTally(t);
    }
    // A viewport with nothing found is no row at all, so an empty tour is an
    // empty object — and the file below is `[]`.
    if (Object.keys(kept).length) stops[v.name] = kept;
  }
  const out: Baseline = {
    note: 'The findings the e2e tour may make, per viewport, stop and class — a two-way ratchet: a finding not here fails, and so does one here that stopped happening. Regenerate with `npm run test:e2e:baseline` (viewer/); never edit counts by hand.',
    stops,
  };
  // Nothing found anywhere is the empty register, `[]` — the file 6.0 ships.
  writeFileSync(BASELINE_FILE, Object.keys(stops).length ? `${JSON.stringify(out, null, 2)}\n` : '[]\n');
  const all = totals(stops);
  process.stdout.write(
    `e2e baseline: ${
      Object.entries(all)
        .map(([c, n]) => `${c} ${n}`)
        .join(', ') || 'no findings'
    }\n`,
  );
}

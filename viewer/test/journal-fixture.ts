/**
 * The journal fixture — a bounded, redacted slice of the hub console's own
 * run corpus, for the gates whose numbers were measured on it.
 *
 * `viewer/test/fixtures/journals/README.md` says what is in it, how it was
 * scrubbed, and which acceptance gate reads which file. This module is the
 * one reader: a test that wants "every journal line" or "every run file" asks
 * here, so the layout can change in one place.
 *
 * Nothing here imports `../server/`, so it needs no sandbox of its own; a test
 * that LOADS a run file through `loadRun` still imports `./state-sandbox.ts`
 * first, as every test does.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/journals/', import.meta.url));

export type FixtureRun = { slug: string; runId: string; file: string; state: Record<string, unknown> };
export type FixtureJournal = { slug: string; runId: string; file: string; lines: Record<string, unknown>[] };

/** The plan directories the fixture holds, sorted. */
export function fixtureSlugs(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => statSync(join(FIXTURE_DIR, name)).isDirectory())
    .sort();
}

/** Every `run-<id>.json` state file, parsed — the shape `loadRun` reads. */
export function fixtureRuns(): FixtureRun[] {
  const out: FixtureRun[] = [];
  for (const slug of fixtureSlugs()) {
    for (const name of readdirSync(join(FIXTURE_DIR, slug)).sort()) {
      const id = /^run-([0-9a-f]{8,32})\.json$/.exec(name)?.[1];
      if (!id) continue;
      const file = join(FIXTURE_DIR, slug, name);
      out.push({ slug, runId: id, file, state: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> });
    }
  }
  return out;
}

/** Every `run-<id>.jsonl` journal, one parsed object per line. */
export function fixtureJournals(): FixtureJournal[] {
  const out: FixtureJournal[] = [];
  for (const slug of fixtureSlugs()) {
    for (const name of readdirSync(join(FIXTURE_DIR, slug)).sort()) {
      const id = /^run-([0-9a-f]{8,32})\.jsonl$/.exec(name)?.[1];
      if (!id) continue;
      const file = join(FIXTURE_DIR, slug, name);
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      out.push({ slug, runId: id, file, lines });
    }
  }
  return out;
}

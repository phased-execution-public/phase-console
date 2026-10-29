/**
 * Where a run's files live — the leaf `state.ts` and `journal.ts` share.
 *
 * These four helpers were `state.ts`'s until phase 6 of `zero-touch-console`
 * needed the run journal from INSIDE the state module: a `waiting` record
 * whose clock died is settled on load (`settleWaitingRecords`), and a
 * settlement that changes a record without a journal line is the audit's
 * WAI-6 all over again. `journal.ts` imported `journalFile` from `state.ts`,
 * so `state.ts` importing `Journal` back would have been a cycle; the paths
 * moved down here instead, and both modules import them from the leaf.
 * `state.ts` re-exports them, so every existing importer keeps its spelling.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { instanceId } from '../../shared/instances.mjs';
import { STATE_DIR } from '../config.ts';

/**
 * One directory per (source directory, plan). The hash keeps two checkouts of
 * the same repo apart; the basename keeps the path readable for a human who
 * goes looking, which they will the first time a run halts.
 *
 * The key is `instanceId()` — the same function that names a console instance,
 * imported rather than reimplemented. It was computed here first and the
 * instance registry adopted it, so the import direction looks backwards; it is
 * the right way round anyway, because the two must never drift and only one of
 * them can be the definition. `runs/` stays under the SHARED `STATE_DIR` rather
 * than moving into a per-instance directory: it is already keyed by root, so
 * two consoles cannot collide here, and moving it would orphan every run
 * journal on the machine to buy nothing.
 */
export function runDir(root: string, slug: string): string {
  return join(STATE_DIR, 'runs', instanceId(root), slug);
}

/**
 * The state directory shared by every plan in ONE console checkout.
 *
 * `runDir` is exactly this plus the plan's slug — the two are written next to
 * each other so they cannot drift — and this is the right scope for anything
 * console-wide rather than plan-wide. The staging worktree of `pe/integration`
 * is the first such thing: git allows a branch one working tree, so a staging
 * directory under a plan's own `runDir` would mean the second plan to settle
 * that way found the branch already checked out.
 */
export function consoleRunsDir(root: string): string {
  return join(STATE_DIR, 'runs', instanceId(root));
}

export function runFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.json`);
}

/**
 * The run record's delta log (measured-console phase 17, B5, `persistModel` 2):
 * the records a save changed, one generation per line, folded over the base on read.
 */
export function runDeltaFile(target: string): string {
  return `${target}.delta`;
}

export function journalFile(root: string, slug: string, id: string): string {
  return join(runDir(root, slug), `run-${id}.jsonl`);
}

/**
 * The journal's chain (measured-console phase 17, B5): a journal that reached
 * its cap was renamed to `run-<id>.jsonl.<n>` (n from 1, oldest first) and a
 * fresh live file begun; `run-<id>.jsonl.index` records each segment's
 * `{n, file, firstSeq, lastSeq, bytes, offset}` — `offset` the byte at which
 * the segment starts in the run's whole journal.
 */
export type JournalSegment = { n: number; file: string; firstSeq: number; lastSeq: number; bytes: number; offset: number };
export type JournalIndex = { version: 1; segments: JournalSegment[] };

/** The live file's numbered segment `n`. */
export function journalSegmentFile(live: string, n: number): string {
  return `${live}.${n}`;
}

/** The live file's chain index. */
export function journalIndexFile(live: string): string {
  return `${live}.index`;
}

/**
 * The chain's index — read from its file, else rebuilt from the numbered files
 * on disk (a console that died between the rename and the index write).
 */
export function journalIndexOf(live: string): JournalIndex {
  try {
    const parsed = JSON.parse(readFileSync(journalIndexFile(live), 'utf8')) as Partial<JournalIndex>;
    if (parsed?.version === 1 && Array.isArray(parsed.segments)) {
      return { version: 1, segments: parsed.segments.filter((s) => Number.isInteger(s?.n)).sort((a, b) => a.n - b.n) };
    }
  } catch { /* absent or torn: rebuilt below */ }
  const stem = basename(live);
  let names: string[] = [];
  try { names = readdirSync(dirname(live)); } catch { names = []; }
  const segments: JournalSegment[] = [];
  for (const name of names) {
    const middle = name.startsWith(`${stem}.`) ? name.slice(stem.length + 1) : '';
    if (/^\d+$/.test(middle)) segments.push({ n: Number(middle), file: name, firstSeq: 0, lastSeq: 0, bytes: 0, offset: 0 });
  }
  return { version: 1, segments: segments.sort((a, b) => a.n - b.n) };
}

/** Every file of a journal, oldest first — its segments, then the live file. What every reader follows. */
export function journalChainOf(live: string): string[] {
  return [...journalIndexOf(live).segments.map((segment) => join(dirname(live), segment.file)), live];
}

/**
 * The session replay's file: one per PHASE, plus the run's own for a line that
 * names no phase (control-tower phase 94, #133).
 *
 * It was one file per run, `run-<id>.log.jsonl`, with a 16 MB hard stop — so a
 * long run crossed it within days and every later phase replayed nothing. The
 * run's own name is kept for the lines with no phase, and it is also where a
 * run written before the split still has every line it wrote.
 */
export function transcriptFile(root: string, slug: string, id: string, phase?: number): string {
  return join(runDir(root, slug), phase == null ? `run-${id}.log.jsonl` : `run-${id}.p${phase}.log.jsonl`);
}

/**
 * Which replay a file name is: a phase's number, `null` for the run's own, and
 * `undefined` for anything else — another run, another sidecar, an ARCHIVE.
 * An archive (`.old`, `.full-<stamp>`) is kept evidence a writer must never
 * append to and a reader must never mistake for the live replay.
 */
export function transcriptPhase(name: string, id: string): number | null | undefined {
  if (name === `run-${id}.log.jsonl`) return null;
  const prefix = `run-${id}.p`;
  if (!name.startsWith(prefix) || !name.endsWith('.log.jsonl')) return undefined;
  const digits = name.slice(prefix.length, -'.log.jsonl'.length);
  return /^\d+$/.test(digits) ? Number(digits) : undefined;
}

/**
 * Everything a run leaves beside its record, after `run-<id>`: the journal,
 * the replays (the run's and each phase's) and their archives, the folded git
 * trace, and each phase's task ledger and outcome.
 *
 * ONE pattern, read by retention's inventory, `pruneRuns` and the debug bundle —
 * the journal's chain (`.jsonl.<n>`, `.jsonl.index`) and the record's delta log (`.json.delta`,
 * measured-console phase 17) among them — suffixes no `.json$` or `.jsonl$` scan takes for a record or a journal.
 * Each used to spell its own, and none knew the archived names the 2026-09-25
 * workaround left when it moved full replays aside — so those were counted by
 * nobody and outlived their runs for ever.
 */
const SIDECAR_TAIL = String.raw`(?:\.jsonl|\.json\.delta|\.jsonl\.\d+|\.jsonl\.index|(?:\.p\d+)?\.log\.jsonl(?:\.old|\.full-[0-9A-Za-z:._-]+)?|\.git\.ndjson|-p\d+-(?:tasks\.ndjson|outcome\.json))`;
const SIDECAR = new RegExp(`^run-([0-9a-f]{8,32})${SIDECAR_TAIL}$`);

/** The run id a sidecar's name belongs to, or `null` when it is not one. */
export function runSidecarId(name: string): string | null {
  return SIDECAR.exec(name)?.[1] ?? null;
}

/**
 * Whether `name` is one of run `id`'s sidecars — the id matched EXACTLY. Run
 * ids are 8–32 hex, so a prefix match on `run-aaaaaaaa` takes the files of
 * `run-aaaaaaaabbbb`, a different run.
 */
export function isRunSidecar(name: string, id: string): boolean {
  return name.startsWith(`run-${id}`) && new RegExp(`^${SIDECAR_TAIL}$`).test(name.slice(`run-${id}`.length));
}

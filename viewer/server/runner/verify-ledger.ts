/**
 * What every run of a plan's §Verification lines measured, and what it says
 * about the next one (control-tower phase 83, #95 #103).
 *
 * One append-only NDJSON file per PLAN, beside `proofs.ndjson` — per plan and
 * not per run, because both of its readers need what earlier runs saw:
 *
 *  - **the limit** (#95). A §Verification command got one fixed half hour, and
 *    control-tower's `bash tests/run-tests.sh` — 14 min on a quiet machine, 34
 *    min under the autopilot's own load — was killed at 2043 s and recorded as
 *    a red, green again at 850 s on the same head. The limit is now the plan's
 *    to state (`Verify timeout:`) and otherwise scales with the line's OWN
 *    measured runs: `VERIFY_HISTORY_FACTOR` × the longest of its last
 *    `VERIFY_HISTORY_WINDOW` runs, never under the default, never past the
 *    ceiling. A run its clock cut is not a measurement — it says only "longer
 *    than the limit" — and counting it would ratchet the limit on every cut.
 *  - **the baseline** (#103). A phase compares its reds with what its lines
 *    read on the tree it boarded on; the last run of a line on that very tree
 *    stands in for measuring it again, and every run is ledgered with the
 *    failing tests it named and which of them its phase was charged with — so
 *    a red a later phase inherits can name the phase that owns it.
 *
 * Pure but for the file: the runner reads it, decides, and appends; git is
 * asked nothing here (the commit reads are `worktree.ts`'s).
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { consoleRunsDir, runDir } from './run-paths.ts';
import type { VerifyBaseline, VerifyLimitSource, VerifyRun } from './state.ts';
import { foldCommand, VERIFY_TIMEOUT_CEILING_MS, VERIFY_TIMEOUT_MS } from './verify.ts';

export { VERIFY_TIMEOUT_CEILING_MS };

/** A line with measured runs is given this multiple of its longest recent one. */
export const VERIFY_HISTORY_FACTOR = 3;

/** How many of a line's most recent runs its limit is scaled from. */
export const VERIFY_HISTORY_WINDOW = 10;

/** The failure identity of a red whose output named no test: the whole command. */
export const WHOLE_COMMAND = '*';

/** The plan's verification ledger — per PLAN, beside `proofs.ndjson`. */
export function verificationsFile(root: string, slug: string): string {
  return join(runDir(root, slug), 'verifications.ndjson');
}

/** One command's run, as the ledger keeps it. */
export type LedgerRow = {
  type: 'verification';
  slug: string;
  phase: number;
  run: string;
  at: string;
  /** The phase's verdict, or its baseline at boarding. */
  kind: 'verify' | 'baseline';
  /** Folded (`foldCommand`), so a reflowed line is the same line. */
  command: string;
  /** A member of this `&&` chain (folded), run alone because the chain was red. */
  chain?: string;
  code: number;
  ms: number;
  ok: boolean;
  timedOut?: boolean;
  /** The working tree the command ran against — a git tree object — and its HEAD. */
  tree?: string | null;
  head?: string | null;
  /**
   * The environment it ran under (`verifyEnvDigest`) and the directory of its
   * repository it ran in (`''` at the top) — with the tree and the command,
   * the key a baseline reuses a measurement by (control-tower phase 105). A
   * row written before then names neither, and is never reused.
   */
  env?: string;
  dir?: string;
  /** The failing tests its output named (`verify.ts` `failureIds`). */
  failures?: string[];
  /**
   * A red row's output tail (`outputTail`, control-tower phase 106, #195): what
   * the line SAID, for a baseline as for a verdict. The ledger used to hold a
   * red's code alone, and finding why a baseline was red meant re-running the
   * suite by hand.
   */
  tail?: string;
  /** Why it could not be judged on this machine (`verify.ts` `environmentOf`) — not a red. */
  environment?: string;
  /**
   * A verdict row only: the failures its phase was CHARGED with — its own reds,
   * `*` for a whole command whose output named none. What names the owner of a
   * red a later phase inherits.
   */
  own?: string[];
};

const strings = (value: unknown): string[] | undefined =>
  (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined);

/**
 * The ledger's rows for one plan, oldest first. Append-only and written by
 * more than one console over time, so a line that does not parse, names
 * another plan or lacks a field is skipped rather than trusted.
 */
export function readLedger(file: string, slug: string): LedgerRow[] {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out: LedgerRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row?.type !== 'verification' || row.slug !== slug) continue;
    if (typeof row.command !== 'string' || typeof row.code !== 'number' || typeof row.ms !== 'number') continue;
    if (typeof row.phase !== 'number' || (row.kind !== 'verify' && row.kind !== 'baseline')) continue;
    const failures = strings(row.failures);
    const own = strings(row.own);
    out.push({
      type: 'verification', slug, phase: row.phase, run: typeof row.run === 'string' ? row.run : '',
      at: typeof row.at === 'string' ? row.at : '', kind: row.kind, command: foldCommand(row.command),
      ...(typeof row.chain === 'string' && row.chain ? { chain: foldCommand(row.chain) } : {}),
      code: row.code, ms: row.ms, ok: row.ok === true,
      ...(row.timedOut === true ? { timedOut: true } : {}),
      ...(typeof row.tree === 'string' ? { tree: row.tree } : {}),
      ...(typeof row.head === 'string' ? { head: row.head } : {}),
      ...(typeof row.env === 'string' && row.env ? { env: row.env } : {}),
      ...(typeof row.dir === 'string' ? { dir: row.dir } : {}),
      ...(failures ? { failures } : {}),
      ...(typeof row.tail === 'string' && row.tail ? { tail: row.tail } : {}),
      ...(typeof row.environment === 'string' && row.environment ? { environment: row.environment } : {}),
      ...(own ? { own } : {}),
    });
  }
  return out;
}

/**
 * How much of a red line's output the record, the ledger and the session's
 * note keep (control-tower phase 106, #195): the end of it, where a suite
 * prints its failures and its summary. A tail, never the log — the row rides a
 * run record and an append-only ledger.
 */
export const OUTPUT_TAIL_CHARS = 2_000;

/** The last `OUTPUT_TAIL_CHARS` of an output, cut at a line boundary when one is near. */
export function outputTail(output: string | undefined): string {
  const text = (output ?? '').trim();
  if (text.length <= OUTPUT_TAIL_CHARS) return text;
  const cut = text.slice(-OUTPUT_TAIL_CHARS);
  const newline = cut.indexOf('\n');
  return newline >= 0 && newline < 200 ? cut.slice(newline + 1) : cut;
}

/** Append rows — one line each, so two writers can only ever interleave whole lines. */
export function appendLedger(file: string, rows: readonly LedgerRow[]): void {
  if (!rows.length) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
}

/* ------------------------------------------------------------------ *
 * The limit (#95)
 * ------------------------------------------------------------------ */

/**
 * One command's limit: the plan's word when it gave one, else the line's own
 * measured history, else the default. `samples` says how many runs history
 * read — present whenever it read any, even when the default still won.
 */
export function resolveVerifyLimit(opts: {
  command: string;
  rows: readonly LedgerRow[];
  directive?: { minutes: number; source: 'phase' | 'plan' };
}): { ms: number; source: VerifyLimitSource; samples?: number } {
  if (opts.directive) return { ms: opts.directive.minutes * 60_000, source: opts.directive.source };
  const folded = foldCommand(opts.command);
  const samples = opts.rows
    .filter((row) => row.command === folded && !row.timedOut && Number.isFinite(row.ms) && row.ms > 0)
    .slice(-VERIFY_HISTORY_WINDOW);
  if (!samples.length) return { ms: VERIFY_TIMEOUT_MS, source: 'default' };
  const scaled = Math.min(VERIFY_HISTORY_FACTOR * Math.max(...samples.map((row) => row.ms)), VERIFY_TIMEOUT_CEILING_MS);
  if (scaled <= VERIFY_TIMEOUT_MS) return { ms: VERIFY_TIMEOUT_MS, source: 'default', samples: samples.length };
  return { ms: scaled, source: 'history', samples: samples.length };
}

/* ------------------------------------------------------------------ *
 * The wrap-up's fast gate (control-tower phase 89, #127)
 * ------------------------------------------------------------------ */

/** A §Verification line is FAST when its measured runs never took longer than this. */
export const FAST_LINE_MS = 5 * 60_000;
/** And a fast gate is at most this much measured time, lines taken in plan order. */
export const FAST_GATE_BUDGET_MS = 10 * 60_000;

/**
 * The plan's FAST gate for a phase: the lines of its own §Verification whose
 * measured runs (the ledger's last `VERIFY_HISTORY_WINDOW` un-cut runs of the
 * line, anyone's) never took longer than `FAST_LINE_MS`, in plan order, while
 * their summed worst case stays inside `FAST_GATE_BUDGET_MS`. What the console
 * runs on a wrap-up's committed WIP before siblings build on it (#127). A line
 * never measured is left out — its cost is unknown, and a wrap-up gate that
 * might run for an hour is not a fast one. `estimateMs` is the gate's summed
 * worst case, each line's `limitMs` twice its worst run (at least a minute).
 */
export function fastGateLines(
  commands: readonly string[], rows: readonly LedgerRow[],
): { lines: string[]; estimateMs: number; limitMs: Record<string, number> } {
  const lines: string[] = [];
  const limitMs: Record<string, number> = {};
  let estimateMs = 0;
  for (const command of commands) {
    const folded = foldCommand(command);
    const samples = rows
      .filter((row) => row.command === folded && !row.chain && !row.timedOut && Number.isFinite(row.ms) && row.ms > 0)
      .slice(-VERIFY_HISTORY_WINDOW);
    if (!samples.length) continue;
    const worst = Math.max(...samples.map((row) => row.ms));
    if (worst > FAST_LINE_MS || estimateMs + worst > FAST_GATE_BUDGET_MS) continue;
    lines.push(command);
    limitMs[folded] = Math.max(60_000, 2 * worst);
    estimateMs += worst;
  }
  return { lines, estimateMs, limitMs };
}

/* ------------------------------------------------------------------ *
 * The baseline (#103)
 * ------------------------------------------------------------------ */

/**
 * How old a measurement may be and still stand in for a baseline line
 * (control-tower phase 105, #190 ask 3). The tree, the command, the
 * environment and the directory are the same, but what the tree does not hold
 * drifts — an installed dependency, a container image, a service a suite
 * reaches — so a day is the bound.
 */
export const BASELINE_REUSE_MAX_AGE_MS = 24 * 60 * 60_000;

/** The priority a baseline's commands run at beside a working session (`nice -n`). */
export const BASELINE_NICE = 10;

/**
 * Every verification ledger of this CONSOLE — each plan's, read with its own
 * slug, oldest first by `at`. What a baseline reuses from (control-tower phase
 * 105): a line measured on the same tree by any plan's phase is the same
 * measurement, and on the hub console every tb phase of ai-builder-v7 measured
 * tb `main`'s `task verify:local` again because each plan read only its own.
 */
export function readConsoleLedgers(root: string): LedgerRow[] {
  const dir = consoleRunsDir(root);
  if (!existsSync(dir)) return [];
  const rows: LedgerRow[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  for (const slug of names) {
    const file = join(dir, slug, 'verifications.ndjson');
    if (existsSync(file)) rows.push(...readLedger(file, slug));
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The measurement a baseline line may reuse: the newest run of the same
 * command, on the same tree, under the same environment digest, in the same
 * directory of its repository, younger than `BASELINE_REUSE_MAX_AGE_MS` — by
 * any phase or run (control-tower phase 105, BL-2). A run its clock cut says
 * only "longer than the limit" and is never one; a row that names no
 * environment cannot vouch for this one.
 */
export function reusableRun(rows: readonly LedgerRow[], key: {
  command: string; tree: string; env: string; dir: string; now?: number; maxAgeMs?: number;
}): LedgerRow | undefined {
  const folded = foldCommand(key.command);
  const now = key.now ?? Date.now();
  const maxAge = key.maxAgeMs ?? BASELINE_REUSE_MAX_AGE_MS;
  let best: LedgerRow | undefined;
  for (const row of rows) {
    if (row.command !== folded || row.tree !== key.tree || row.timedOut) continue;
    if (!row.env || row.env !== key.env || (row.dir ?? null) !== key.dir) continue;
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || now - at > maxAge || at - now > 60_000) continue;
    if (!best || row.at >= best.at) best = row;
  }
  return best;
}

/** An age as a person reads it: `40 s`, `12 min`, `2h`, `3h 5m`. */
function ageWords(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ''}`;
}

/**
 * One baseline line, in the words the session's note, the journal and a
 * person read (control-tower phase 105): a measured red is `red once (not
 * retried)` — a baseline is never a verdict, and its red is not run twice —
 * and a reused line names where it came from and how old it is.
 */
export function baselineLineWords(line: VerifyBaseline['commands'][number]): string {
  // A line the MACHINE stopped (control-tower phase 106, #185) is not a red the
  // session inherits: it says why it could not run, and what to do about it.
  const outcome = line.ok ? 'green'
    : line.environment ? `could not run here — ${line.environment}`
      : line.once ? 'red once (not retried)' : 'red';
  if (line.from !== 'reused' || !line.by) return outcome;
  const where = `${line.by.slug ? `${line.by.slug} ` : ''}run ${line.by.run || '?'}`;
  const age = line.by.ageMs != null ? `, ${ageWords(line.by.ageMs)} ago` : '';
  return `reused from ${where} (phase ${line.by.phase}${age}) — ${outcome}`;
}

/** The last run of a line on this very tree — what stands in for measuring it at boarding. */
export function lastRunOn(rows: readonly LedgerRow[], command: string, tree: string): LedgerRow | undefined {
  const folded = foldCommand(command);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.command === folded && row.tree === tree && !row.timedOut) return row;
  }
  return undefined;
}

type BaselineLine = Pick<VerifyBaseline['commands'][number], 'command' | 'ok' | 'code' | 'failures' | 'chain'>;

/**
 * A red command's share of the phase's reds: its own, or inherited. `chain`
 * when the command is a member of a red `&&` chain, run alone (#103).
 */
export type RedShare = { command: string; chain?: string; failures: string[] };

/** A red to split: a verdict row, or a chain's member run alone (`chain` set). */
export type RedRow = Pick<VerifyRun, 'command' | 'failures'> & { chain?: string };

/**
 * Which of a verification's reds are the phase's OWN and which it INHERITED.
 *
 * Per command, against that line's baseline: a line green (or never measured)
 * on the base tree owns every red it has now; a line red there too gives the
 * failing tests it named then to the inheritance and keeps the rest. When
 * either side named no test — a crash, a compiler error, output nothing can
 * itemise — the whole command is compared instead: red on the base tree, red
 * now, inherited. A chain's MEMBER is compared with that member's own line
 * when the baseline broke the chain down too, else with the chain's: green
 * there, every member was green.
 */
export function splitReds(
  broke: readonly RedRow[], baseline: readonly BaselineLine[] | undefined,
): { own: RedShare[]; inherited: RedShare[] } {
  const own: RedShare[] = [];
  const inherited: RedShare[] = [];
  for (const row of broke) {
    const failures = row.failures ?? [];
    const share = (ids: string[]): RedShare => ({ command: row.command, ...(row.chain ? { chain: row.chain } : {}), failures: ids });
    const base = baseline?.find((line) => line.command === foldCommand(row.command))
      ?? (row.chain ? baseline?.find((line) => !line.chain && line.command === foldCommand(row.chain!)) : undefined);
    if (!base || base.ok) { own.push(share(failures)); continue; }
    const before = base.failures ?? [];
    if (!failures.length || !before.length) { inherited.push(share(failures)); continue; }
    const mine = failures.filter((id) => !before.includes(id));
    const theirs = failures.filter((id) => before.includes(id));
    if (mine.length) own.push(share(mine));
    if (theirs.length) inherited.push(share(theirs));
  }
  return { own, inherited };
}

/** Was this red NOT failing on this run of its line? A cut run, or a red that named nothing, cannot say. */
function cleanFor(row: LedgerRow, id: string): boolean {
  if (row.timedOut) return false;
  if (row.ok) return true;
  return id !== WHOLE_COMMAND && Boolean(row.failures?.length) && !row.failures!.includes(id);
}

/**
 * The phase charged with this red before: the latest verdict row, of another
 * phase, that counted it among its own. A phase that was failed for a red owns
 * it — unless a LATER run of the line was clean of it (control-tower phase 83,
 * fifth amendment): then it was fixed, and a red now is a new one that phase
 * cannot be charged with.
 */
export function ownerFromLedger(
  rows: readonly LedgerRow[], command: string, id: string, self: number,
): number | undefined {
  const folded = foldCommand(command);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.command !== folded) continue;
    if (cleanFor(row, id)) return undefined;
    if (row.kind !== 'verify' || row.phase === self) continue;
    if (row.own?.includes(id)) return row.phase;
  }
  return undefined;
}

/**
 * The trees this line was clean of this red on, latest first — each a place
 * the red was NOT, for comparison with the tree it is on now (the `wip` rule).
 */
export function cleanTrees(rows: readonly LedgerRow[], command: string, id: string, limit = 3): string[] {
  const folded = foldCommand(command);
  const out: string[] = [];
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const row = rows[i];
    if (row.command !== folded || !row.tree || !cleanFor(row, id) || out.includes(row.tree)) continue;
    out.push(row.tree);
  }
  return out;
}

/**
 * The HEAD of the latest run of this line on which this red was NOT failing —
 * the far end of the range its introducing commit lies in. A green run
 * qualifies; so does a red one that named its failures and not this one. A
 * cut run, or a red that named nothing, says nothing about it.
 */
export function lastCleanHead(rows: readonly LedgerRow[], command: string, id: string): string | undefined {
  const folded = foldCommand(command);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row.command !== folded || !row.head) continue;
    if (cleanFor(row, id)) return row.head;
  }
  return undefined;
}

/** A phase's session windows, as the run records them (`attemptWindows`). */
export type SessionWindow = { phase: number; startedAt: string; endedAt?: string };

/**
 * The phases whose session windows hold this instant — none for a moment no
 * session of the run was open. A window opens on the SECOND: git dates a commit
 * to the second, so one made in its session's first second would otherwise
 * read as made before it.
 */
function sessionsAt(at: number, windows: readonly SessionWindow[]): Set<number> {
  const out = new Set<number>();
  if (!Number.isFinite(at)) return out;
  for (const window of windows) {
    const from = Math.floor(Date.parse(window.startedAt) / 1000) * 1000;
    // …and closes at the END of its last millisecond: a file's mtime carries
    // fractions of one, and a write in the session's final millisecond read as
    // after it (control-tower phase 89 — its export rule then set the phase's
    // own file aside as nobody's).
    const to = window.endedAt ? Date.parse(window.endedAt) + 1 : Number.POSITIVE_INFINITY;
    if (Number.isFinite(from) && at >= from && at <= to) out.add(window.phase);
  }
  return out;
}

/** Every phase whose sessions made a commit in the range — the phase itself included. */
export function committers(
  commits: readonly { sha: string; at: string }[], windows: readonly SessionWindow[],
): number[] {
  const owners = new Set<number>();
  for (const commit of commits) for (const phase of sessionsAt(Date.parse(commit.at), windows)) owners.add(phase);
  return [...owners].sort((a, b) => a - b);
}

/**
 * The phase whose SESSIONS made the commits in a range — the owner of a red
 * that appeared there. Exactly one other phase: its owner. Several: every one
 * is named and none is guessed, because only a bisection could say which, and
 * that costs a suite run per commit. A commit no session of the run made
 * (a hand commit, another run's) has no owner here, and neither is the phase
 * itself ever its own inheritance.
 */
export function ownerByCommits(
  commits: readonly { sha: string; at: string }[], windows: readonly SessionWindow[], self: number,
): { owner?: number; candidates?: number[] } {
  const list = committers(commits, windows).filter((phase) => phase !== self);
  if (list.length === 1) return { owner: list[0] };
  return list.length ? { candidates: list } : {};
}

/* ------------------------------------------------------------------ *
 * Uncommitted work (#103's 2026-09-25 comment, the fifth amendment)
 * ------------------------------------------------------------------ */

/** Whose uncommitted path this is: a phase of the run, the verifying phase itself, or nobody sure. */
export type WipOwner = number | 'self' | null;

/**
 * Who wrote each uncommitted path — the phase whose session window holds its
 * last write, the same windows a commit's author is read from. The phase's own
 * sessions answer `self`; a write no session of the run was open for, a write
 * two sessions' windows both hold, and a deleted path (no write time) answer
 * nobody: the rule never guesses.
 */
export function wipOwners(
  paths: readonly { path: string; mtimeMs: number | null }[], windows: readonly SessionWindow[], self: number,
): Map<string, WipOwner> {
  const out = new Map<string, WipOwner>();
  for (const { path, mtimeMs } of paths) {
    const phases = mtimeMs === null ? new Set<number>() : sessionsAt(mtimeMs, windows);
    const only = phases.size === 1 ? [...phases][0] : undefined;
    out.set(path, only === undefined ? null : only === self ? 'self' : only);
  }
  return out;
}

/**
 * A red that is only the WIP's. `changed` is what differs between a tree the
 * line was clean of the red on and the tree it is red on now; when every one
 * of those paths is uncommitted and another phase's session wrote it, that
 * WIP is the introducing change and its phase owns the red — one phase the
 * owner, several all named. Anything else — a committed change among them,
 * the phase's own uncommitted work, a path nobody can be sure of, nothing
 * changed at all — is not a WIP red, and null says so.
 */
export function wipAttribution(
  changed: readonly string[], owners: ReadonlyMap<string, WipOwner>,
): { owner?: number; candidates?: number[]; paths: string[] } | null {
  if (!changed.length) return null;
  const phases = new Set<number>();
  for (const path of changed) {
    const owner = owners.get(path);
    if (typeof owner !== 'number') return null;
    phases.add(owner);
  }
  const list = [...phases].sort((a, b) => a - b);
  const paths = [...changed].sort().slice(0, 20);
  return list.length === 1 ? { owner: list[0], paths } : { candidates: list, paths };
}

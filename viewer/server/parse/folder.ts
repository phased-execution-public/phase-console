/**
 * The other three artefacts in a handoff folder: `INDEX.md`, `test-status.md`
 * and `.locks/phase-NN.lock`.
 */

import { tableAfter, plainCell } from './markdown.ts';
import { parseScope } from '../../shared/scope.js';
import { QA_RESULTS, QA_RESULT_WORDS } from '../../shared/plan-vocab.js';

export type IndexRow = { phase: number; title: string; status: string; link?: string };

/**
 * Headings that introduce a phase listing.
 *
 * `parseIndex` used to pass `() => true`, which made every heading take
 * `tableAfter`'s first branch — so `seen` reset at each one and the
 * stop-at-the-next-table guard could never fire. The contract that function
 * documents ("other tables in the document can never be mistaken for the one we
 * want") was therefore unenforced here, and any later pipe table whose first
 * column held a bare number was silently folded into the index.
 *
 * The test is a phrase match rather than the exact `# Handoffs — <slug>` the
 * template writes, because real boards do not all use it: one hub index is
 * `# … — phase status board` and legitimately spreads its phases across
 * `## Credit money-path phases (10–18)` and `## Other phases (…)`. Scoping to
 * the template would have dropped rows that are genuinely part of the index —
 * a worse bug than the one being fixed. Everything else (`## Post-close
 * sittings`, `## Keeping this current`) now ends the scan, which is the guard
 * doing its job.
 */
const INDEX_HEADING = /phase|handoff|index/i;

/** Rows of the INDEX table; `TBD` links (planned phases) come back without one. */
export function parseIndex(text: string): IndexRow[] {
  const rows = tableAfter(text, (title) => INDEX_HEADING.test(title));
  const out: IndexRow[] = [];
  for (const row of rows) {
    const phase = plainCell(row.cells[0] ?? '');
    if (!/^\d+$/.test(phase)) continue;
    const linkCell = row.cells[3] ?? '';
    const link = /\]\(([^)]+)\)/.exec(linkCell)?.[1];
    out.push({
      phase: Number(phase),
      title: plainCell(row.cells[1] ?? ''),
      status: plainCell(row.cells[2] ?? '').toLowerCase(),
      link,
    });
  }
  return out;
}

/**
 * What a `test-status.md` row can read as — the four writable verdicts plus
 * `unknown` for a row that exists and does not parse. Both lists come from
 * `shared/plan-vocab.js`; `unknown` and `off` are different facts and this
 * one has no `off` (a plan with no gate has no rows to read).
 */
export type QaResult = (typeof QA_RESULT_WORDS)[number];
/**
 * One row of the GATING table — the current verdict for a phase.
 *
 * `round` is which review produced it, and is optional because it genuinely is:
 * every table written before rounds existed has three columns, and a row with
 * no fourth cell is a round nobody numbered rather than round 1 asserted by a
 * parser. `qa_result()` in the bash engine reads the same third cell either
 * way, which is what keeps a legacy table gating identically here and there.
 */
export type QaRow = { phase: number; result: QaResult; report?: string; round?: number };

/** One row of the `## QA rounds` ledger — the history behind a verdict. */
export type QaRoundRow = { phase: number; round: number; result: QaResult; report?: string; recorded?: string };

const QA_VALUES: readonly string[] = QA_RESULTS;

/** A report cell: a bare path, a markdown link, or `-` for none. */
function reportCell(raw: string): string | undefined {
  const plain = plainCell(raw);
  if (!plain || plain === '-') return undefined;
  return /\]\(([^)]+)\)/.exec(raw)?.[1] ?? plain;
}

/**
 * The round a row belongs to, when it has no Round cell to say so.
 *
 * Every table written before rounds existed has three columns, and the ONLY
 * record those rows keep of their round is the `-roundN.md` in the report path
 * — the filename convention the sessions invented. Reading them all as round 1
 * is how a reviewer came to be handed the name of a file that already existed,
 * which is the whole defect rounds were added to end.
 *
 * This mirrors `qa_history()` in `scripts/phase-graph.sh` exactly, and it has to:
 * `Service.resolveQa` numbers the interactive launcher's round from what this
 * returns, so a parser that shrugs here and an engine that infers there send two
 * reviewers of the same phase to the same filename (QA round 2, H1).
 */
function roundFromReport(report: string | undefined): number | undefined {
  const match = /-round(\d+)\.md$/.exec(report ?? '');
  const n = match ? Number(match[1]) : 0;
  return n > 0 ? n : undefined;
}

/** Rows of `## QA status` in `test-status.md` — written by `qa-record.sh`. */
export function parseTestStatus(text: string): QaRow[] {
  const rows = tableAfter(text, (t) => /qa status/i.test(t));
  const out: QaRow[] = [];
  for (const row of rows) {
    const phase = plainCell(row.cells[0] ?? '');
    if (!/^\d+$/.test(phase)) continue;
    const value = plainCell(row.cells[1] ?? '').toLowerCase();
    const round = plainCell(row.cells[3] ?? '');
    const report = reportCell(row.cells[2] ?? '');
    // The cell if it has one, else the filename, else nothing.
    //
    // Two rows are roundless whatever else they say. A `pending` row is the
    // absence of a review, so there is no round it could be the Nth of — and
    // `qa-record.sh` refuses `--round` with it, so a Round cell on one is a
    // hand edit and is ignored, as the bash engine ignores it. A `waived` row
    // with NO report and no Round cell is the mid-plan activation backfill —
    // the one `qa-record.sh` writes to mean "this phase finished before QA was
    // on and nobody reviewed it" — so counting it as round 1 would send the
    // next reviewer to `-round2.md` for a phase never reviewed. An explicit
    // Round cell on a verdict row is authoritative in both halves. The rules
    // live in `qa_history()` in the bash engine too; QA round 4 caught them
    // landing in one half only, and `test/qa-round.test.ts` holds the halves
    // equal over every shape.
    // …and only a POSITIVE integer counts: a `0` cell is no round in either half.
    const explicit = value !== 'pending' && /^\d+$/.test(round) && Number(round) >= 1 ? Number(round) : undefined;
    const roundless = value === 'pending' || (value === 'waived' && !report);
    const inferred = explicit ?? (roundless ? undefined : roundFromReport(report));
    out.push({
      phase: Number(phase),
      result: (QA_VALUES as string[]).includes(value) ? (value as QaResult) : 'unknown',
      report,
      ...(inferred ? { round: inferred } : {}),
    });
  }
  return out;
}

/**
 * Rows of `## QA rounds` — every review that happened, oldest first.
 *
 * The split from `parseTestStatus` mirrors the file's own: keeping ONE row per
 * phase in the gating table is what lets every existing reader go on answering
 * identically, so history is additive instead. A file with no ledger yields an
 * empty array, which is the honest answer — not "no QA ran", which is what
 * `parseTestStatus` is for.
 */
export function parseQaRounds(text: string): QaRoundRow[] {
  const rows = tableAfter(text, (t) => /qa rounds/i.test(t));
  const out: QaRoundRow[] = [];
  for (const row of rows) {
    const phase = plainCell(row.cells[0] ?? '');
    const round = plainCell(row.cells[1] ?? '');
    if (!/^\d+$/.test(phase) || !/^\d+$/.test(round)) continue;
    const value = plainCell(row.cells[2] ?? '').toLowerCase();
    const recorded = plainCell(row.cells[4] ?? '');
    out.push({
      phase: Number(phase),
      round: Number(round),
      result: (QA_VALUES as string[]).includes(value) ? (value as QaResult) : 'unknown',
      report: reportCell(row.cells[3] ?? ''),
      ...(recorded && recorded !== '-' ? { recorded } : {}),
    });
  }
  return out.sort((a, b) => a.phase - b.phase || a.round - b.round);
}

export type Lock = {
  slug: string;
  phase: number;
  owner: string;
  host?: string;
  claimedAt?: number;
  leaseUntil?: number;
  /** Lease elapsed — `phase-lock.sh` lets another session take it over. */
  expired: boolean;
  /**
   * The repos this session is working in, from the plan's Repos column.
   *
   * Optional because it is: a lock written before scopes existed, or by a
   * `claim` that named none, has no `scope=` line. Absent means UNKNOWN, and
   * every reader has to treat unknown as colliding with everything — the
   * alternative is admitting a second session into a tree it cannot see.
   */
  scope?: string[];
  /**
   * The working tree this session edits — `worktree=`, from `--worktree` /
   * `$PE_WORKTREE`, or derived by `--here`.
   *
   * 🔴 It does NOT narrow `scope` on its own, and must never be read as
   * though it did — the scope stays the repository. It is HALF of the carve
   * decision: two claims whose scopes intersect are disjoint only when both
   * name a branch AND a tree and both differ. A branch alone proved nothing
   * about two sessions editing one shared checkout; the tree is what tells
   * them apart — and what keeps them together when it is the same directory.
   */
  worktree?: string;
  /**
   * The branch this session's work rides — `branch=`, from `--branch` /
   * `$PE_BRANCH`, or derived by `--here`.
   *
   * The other half of the carve: with `worktree` above, two claims whose
   * `scope`s intersect are nevertheless disjoint when both dimensions are
   * named and both differ, because their commits cannot land on top of each
   * other and their edits cannot touch the same files (`claimsDisjoint` in
   * `shared/scope.js`; `claim_disjoint` in `scripts/scope.sh` — one rule,
   * two languages, one table of cases).
   *
   * Optional, and absent means UNQUALIFIED, which collides with everything —
   * the same fail-safe direction as an absent `scope`. A lock written before
   * this field existed must go on serialising exactly as it did.
   */
  branch?: string;
  /**
   * The Claude session that holds it — `session=`, written by `phase-lock.sh
   * claim` from `--session` / `$PE_SESSION_ID` / `$CLAUDE_CODE_SESSION_ID`.
   * Absent on locks older than the line, or claimed by a session that did not
   * know its id: the reader then falls back to lease rules. Present, it is the
   * key the session registry answers presence for — a lock whose session has
   * ended is debris now, not at lease end.
   */
  session?: string;
  file: string;
};

/**
 * `key=value` lock file written by `phase-lock.sh claim`.
 *
 * FIRST wins on a repeated key, because bash's own reader is `grep -m1` and the
 * two halves of the system must resolve one file the same way. This loop used to
 * overwrite, so a lock carrying two `owner=` lines named one holder to the
 * console and a different one to the scripts — the shape a newline in an owner
 * string produces. `phase-lock.sh` now strips those, but a lock written by an
 * older copy of it outlives the fix, and a disagreement about who holds a lock
 * is how two sessions get onto one working tree.
 */
export function parseLock(text: string, file: string, now = Date.now()): Lock | null {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (m && !(m[1] in values)) values[m[1]] = m[2].trim();
  }
  const phase = Number.parseInt(values.phase ?? '', 10);
  if (!Number.isFinite(phase)) return null;

  const leaseUntil = Number.parseInt(values.lease_until ?? '', 10);
  const claimedAt = Number.parseInt(values.claimed_at ?? '', 10);

  const scope = values.scope ? parseScope(values.scope) : [];

  return {
    slug: values.slug ?? '',
    phase,
    owner: values.owner ?? 'unknown',
    host: values.host,
    claimedAt: Number.isFinite(claimedAt) ? claimedAt * 1000 : undefined,
    leaseUntil: Number.isFinite(leaseUntil) ? leaseUntil * 1000 : undefined,
    expired: Number.isFinite(leaseUntil) ? leaseUntil * 1000 < now : false,
    scope: scope.length ? scope : undefined,
    ...(values.worktree ? { worktree: values.worktree.slice(0, 256) } : {}),
    ...(values.branch ? { branch: values.branch.slice(0, 256) } : {}),
    ...(values.session ? { session: values.session.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 128) || undefined } : {}),
    file,
  };
}

/**
 * Review — a phase's real diff, and the verdict a person gives it.
 *
 * Every comparable tool centres on one loop: read what the machine changed,
 * say yes or say what is wrong, and have "what is wrong" actually hold the
 * work back. The console had the first half of that nowhere. A finished phase
 * offered a handoff (what the session SAYS it did), a QA verdict (a second
 * session's opinion, when QA is on at all) and a boot prompt — and no way to
 * look at the diff itself without leaving for a terminal.
 *
 * Two decisions shape this file.
 *
 * **1. The window comes from the handoffs, not from a guess.** A phase does not
 * record which commits it made. What it certainly does write is its handoff —
 * `docs/handoffs/<slug>/phase-NN-*.md` — so the commits that touched THAT file
 * bracket where the phase landed, and the commits that touched any OTHER
 * handoff in the same plan bracket where the phase before it landed. The window
 * is `previous-plan-handoff-commit .. this-phase's-newest-handoff-commit`, which
 * on a plan whose phases land in order is exactly the phase's own work, code
 * commits included, even though most of them never went near `docs/`.
 *
 * That is a HEURISTIC and the UI says so. Two plans landing into one branch, a
 * phase that committed after writing its handoff, a rebase — each moves the
 * window, and none of them is detectable from here. The honest response is to
 * name the base and the tip on the page and let a reader override them, not to
 * pretend the bracket is a record.
 *
 * **2. The verdict lives beside the run, not in the repository.** `docs/` is
 * the plan's contract, shared through git, and it already carries the two
 * verdicts that gate: the handoff's `status:` and `test-status.md`. A review is
 * this console's operator reading this console's diff; writing it into `docs/`
 * would put a local opinion into every clone, and — because `test-status.md`'s
 * mere existence turns QA gating on for a whole plan — the temptation to reuse
 * that file would silently change a plan's regime. So a review is JSON under
 * `runs/<instance>/<slug>/review/phase-NN.json`, exactly where the run's own
 * state, task lists and outcomes already are.
 *
 * The consequence is stated rather than hidden: **the hold a review produces is
 * the console's, not the engine's.** `scripts/phase-graph.sh` knows nothing
 * about it, a session booted from a terminal will not see it, and a second
 * console on another machine has its own reviews. What it does hold is the
 * thing that reads this file: the runner refuses to board a phase whose
 * dependency has requested changes, the same way it refuses one whose gate is
 * not clear. `reviewHold` below is the whole of that rule.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  commitsInRange, commitsTouching, diffStat, diffText, firstParent, revExists,
  type DiffRange,
} from './git.ts';

/**
 * Bumped to 2 by P14, which added `comments`.
 *
 * No migration, and none is possible in the direction that matters: `get`
 * ignores a file whose version is NEWER than it understands, so a v1 console
 * reading a v2 record sees no verdict rather than half of one — and a v2
 * console reading a v1 record (1 ≤ 2) reads it whole, with no comments, which
 * is exactly what a v1 record means.
 */
export const REVIEW_SCHEMA_VERSION = 2;

/** What a reviewer said. `commented` is a note with no verdict attached. */
export type ReviewVerdict = 'approved' | 'requested-changes' | 'commented';

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['approved', 'requested-changes', 'commented'];

export function isReviewVerdict(value: unknown): value is ReviewVerdict {
  return typeof value === 'string' && (REVIEW_VERDICTS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

/** Which side of the diff a comment is anchored to. */
export type CommentSide = 'old' | 'new';

/**
 * One comment, anchored to a file and (usually) a line.
 *
 * The anchor is `path` + `side` + `line`, which is what the diff already
 * carries on every line (`oldLine`/`newLine` from P13's parser) — NOT a hunk
 * index. A hunk index is a position in a rendering: re-run the diff with a
 * different context width, or against a moved tip, and comment #3 silently
 * points at different code. A file and a line number survive both, and when
 * the line no longer exists the comment is still readable as "this was said
 * about line 120 of that file", which is the honest failure.
 *
 * `hunk` is kept alongside as the header text it was written under, purely so
 * the follow-up prompt can quote the context a reader saw. It is provenance,
 * never the anchor.
 */
export type ReviewComment = {
  /** Stable within a phase's record; the client never invents one. */
  id: string;
  path: string;
  /** Absent on a file-level comment — a remark about the file, not a line. */
  line?: number;
  side?: CommentSide;
  /** The `@@ ... @@` header the comment was written under, for quoting. */
  hunk?: string;
  /** The diff line's own text, snapshotted so the prompt can quote it. */
  code?: string;
  body: string;
  by?: string;
  /** ISO. */
  at: string;
  /**
   * Answered. Kept rather than deleted: a resolved comment is the record of
   * something that WAS wrong, and a follow-up that re-quoted it would ask for
   * work already done — so composition skips resolved comments and the UI
   * keeps showing them.
   */
  resolved?: boolean;
};

/** Per phase. Enough for a real review; bounded so one file cannot grow without limit. */
export const MAX_COMMENTS = 200;
/** Per comment. The follow-up prompt has a budget and N of these have to fit in it. */
export const MAX_COMMENT_BODY = 4_000;

export type ReviewRecord = {
  /** Bumped when the shape changes; an unreadable or newer version is ignored. */
  version: number;
  slug: string;
  phase: number;
  verdict: ReviewVerdict;
  note?: string;
  by?: string;
  /** ISO — when the verdict was given. */
  at: string;
  /**
   * The window the verdict was given ON.
   *
   * Kept so the surface can say "this was reviewed at an older tip" when the
   * phase lands another commit. An approval is about a diff, and a diff that
   * moved is not the diff that was approved — but deciding what to DO about
   * that is the reader's, so this records the fact and never expires anything.
   */
  base?: string;
  tip?: string;
  /**
   * Inline comments, oldest first. Schema v2.
   *
   * A record may exist for comments alone — that is what the `commented`
   * verdict is for (added in P13 precisely so a reviewer can say something
   * without stopping every dependent phase). Keeping `verdict` required is
   * what lets every existing consumer stay correct with no change at all.
   */
  comments?: ReviewComment[];
};

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

/**
 * Reviews on disk, one JSON file per phase.
 *
 * The directory is resolved per call rather than captured at construction:
 * the console can be re-pointed at another source root while it runs, and a
 * store holding the old instance's path would keep answering about the plan
 * the operator just left.
 */
export class ReviewStore {
  private readonly dirFor: (slug: string) => string | null;

  constructor(dirFor: (slug: string) => string | null) {
    this.dirFor = dirFor;
  }

  private fileFor(slug: string, phase: number): string | null {
    const dir = this.dirFor(slug);
    if (!dir) return null;
    return join(dir, `phase-${String(phase).padStart(2, '0')}.json`);
  }

  get(slug: string, phase: number): ReviewRecord | undefined {
    const file = this.fileFor(slug, phase);
    if (!file || !existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as ReviewRecord;
      // A file from a FUTURE version is not readable here and guessing at it is
      // how a forward-compatible format becomes a corrupt one. Absent is the
      // safe answer: no verdict, therefore no hold.
      if (!parsed || parsed.version > REVIEW_SCHEMA_VERSION) return undefined;
      if (!isReviewVerdict(parsed.verdict)) return undefined;
      return { ...parsed, slug, phase };
    } catch {
      return undefined;
    }
  }

  /** Every recorded review for a plan, in phase order. */
  all(slug: string): ReviewRecord[] {
    const dir = this.dirFor(slug);
    if (!dir || !existsSync(dir)) return [];
    const out: ReviewRecord[] = [];
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return []; }
    for (const name of names) {
      const m = /^phase-(\d{2,})\.json$/.exec(name);
      if (!m) continue;
      const record = this.get(slug, Number(m[1]));
      if (record) out.push(record);
    }
    return out.sort((a, b) => a.phase - b.phase);
  }

  set(
    slug: string, phase: number,
    input: { verdict: ReviewVerdict; note?: string; by?: string; base?: string; tip?: string; at?: string },
  ): ReviewRecord {
    const file = this.fileFor(slug, phase);
    if (!file) throw new Error('No source root is open, so there is nowhere to record a review.');
    // Comments outlive the verdict that was standing when they were written.
    // A reviewer who leaves five comments and THEN presses Request changes has
    // not withdrawn the five comments — and before this line, that is exactly
    // what happened: `set` wrote a whole fresh record and the follow-up it was
    // about to compose had nothing to quote.
    const existing = this.get(slug, phase);
    const record: ReviewRecord = {
      version: REVIEW_SCHEMA_VERSION,
      slug,
      phase,
      verdict: input.verdict,
      at: input.at ?? new Date().toISOString(),
      ...(input.note ? { note: input.note.slice(0, 8_000) } : {}),
      ...(input.by ? { by: input.by.slice(0, 200) } : {}),
      ...(input.base ? { base: input.base } : {}),
      ...(input.tip ? { tip: input.tip } : {}),
      ...(existing?.comments?.length ? { comments: existing.comments } : {}),
    };
    mkdirSync(join(file, '..'), { recursive: true });
    // Written through a temp file: a console killed mid-write must not leave a
    // half-JSON verdict, which `get` would drop — silently releasing a hold.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, file);
    return record;
  }

  /**
   * Write the comment list back, keeping the verdict where there is one.
   *
   * A phase with comments and no verdict yet records `commented`: it is the
   * verdict that holds nothing, so the record can exist (and the chip can say
   * somebody has been reading) without parking a single dependent phase.
   */
  private putComments(slug: string, phase: number, comments: ReviewComment[], by?: string): ReviewRecord {
    const file = this.fileFor(slug, phase);
    if (!file) throw new Error('No source root is open, so there is nowhere to record a comment.');
    const existing = this.get(slug, phase);
    const record: ReviewRecord = {
      version: REVIEW_SCHEMA_VERSION,
      slug,
      phase,
      verdict: existing?.verdict ?? 'commented',
      at: existing?.at ?? new Date().toISOString(),
      ...(existing?.note ? { note: existing.note } : {}),
      ...(existing?.by ? { by: existing.by } : by ? { by: by.slice(0, 200) } : {}),
      ...(existing?.base ? { base: existing.base } : {}),
      ...(existing?.tip ? { tip: existing.tip } : {}),
      ...(comments.length ? { comments } : {}),
    };
    mkdirSync(join(file, '..'), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(tmp, file);
    return record;
  }

  /** Add one comment. Returns the record, or null when the phase is at the cap. */
  addComment(
    slug: string, phase: number,
    input: { path: string; line?: number; side?: CommentSide; hunk?: string; code?: string; body: string; by?: string; at?: string; id?: string },
  ): ReviewRecord | null {
    const comments = [...(this.get(slug, phase)?.comments ?? [])];
    if (comments.length >= MAX_COMMENTS) return null;
    const comment: ReviewComment = {
      id: input.id ?? nextCommentId(comments),
      path: input.path,
      ...(Number.isInteger(input.line) ? { line: input.line } : {}),
      ...(input.side ? { side: input.side } : {}),
      ...(input.hunk ? { hunk: input.hunk.slice(0, 400) } : {}),
      ...(input.code ? { code: input.code.slice(0, 400) } : {}),
      body: input.body.slice(0, MAX_COMMENT_BODY),
      ...(input.by ? { by: input.by.slice(0, 200) } : {}),
      at: input.at ?? new Date().toISOString(),
    };
    comments.push(comment);
    return this.putComments(slug, phase, comments, input.by);
  }

  /** Mark a comment answered (or un-answer it). Null when there is no such comment. */
  resolveComment(slug: string, phase: number, id: string, resolved = true): ReviewRecord | null {
    const comments = this.get(slug, phase)?.comments ?? [];
    if (!comments.some((c) => c.id === id)) return null;
    const next = comments.map((c) => {
      if (c.id !== id) return c;
      // `resolved: false` is not written — the flag's absence IS unresolved,
      // and a record carrying both spellings would make two comparisons of the
      // same fact possible.
      const { resolved: _was, ...rest } = c;
      return resolved ? { ...rest, resolved: true } : rest;
    });
    return this.putComments(slug, phase, next);
  }

  /** Delete a comment outright — the reviewer's own typo, not a resolution. */
  removeComment(slug: string, phase: number, id: string): ReviewRecord | null {
    const comments = this.get(slug, phase)?.comments ?? [];
    if (!comments.some((c) => c.id === id)) return null;
    return this.putComments(slug, phase, comments.filter((c) => c.id !== id));
  }

  /** Withdraw a verdict. Returns whether there was one to withdraw. */
  clear(slug: string, phase: number): boolean {
    const file = this.fileFor(slug, phase);
    if (!file || !existsSync(file)) return false;
    // Renamed aside rather than unlinked: a withdrawn verdict is evidence, and
    // one file per phase means the graveyard cannot grow without bound.
    try { renameSync(file, `${file}.withdrawn`); return true; } catch { return false; }
  }
}

/* ------------------------------------------------------------------ *
 * The hold
 * ------------------------------------------------------------------ */

/**
 * Which of a phase's dependencies have requested changes.
 *
 * Direct dependencies only, and deliberately: a transitive hold would park a
 * phase for something two removes away that its own dependency has already
 * dealt with, and the engine's readiness rule — every dependency done — is
 * itself direct. Empty means nothing holds it.
 */
export function reviewHold(
  dependsOn: readonly number[],
  reviews: readonly ReviewRecord[],
): number[] {
  const changed = new Set(
    reviews.filter((r) => r.verdict === 'requested-changes').map((r) => r.phase),
  );
  return dependsOn.filter((phase) => changed.has(phase)).sort((a, b) => a - b);
}

/** The park note a held phase carries — one sentence, and it names the console. */
export function reviewHoldNote(phases: readonly number[]): string {
  const list = phases.map((p) => `P${p}`).join(', ');
  return `review hold: ${list} ${phases.length === 1 ? 'has' : 'have'} requested changes `
    + '(this console\'s review state, not the engine\'s board)';
}

/* ------------------------------------------------------------------ *
 * The diff
 * ------------------------------------------------------------------ */

export type DiffLineKind = 'context' | 'add' | 'del' | 'meta';

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
};

export type DiffHunk = { header: string; lines: DiffLine[] };

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed';

export type DiffFile = {
  path: string;
  /** Set only on a rename — where the file came from. */
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** The file's hunks were cut at the per-file line cap. */
  truncated?: boolean;
};

export type ReviewWindowKind = 'handoff-window' | 'working-tree' | 'explicit' | 'none';

export type ReviewWindow = {
  kind: ReviewWindowKind;
  base?: string;
  tip?: string;
  /** Plain English: how this bracket was chosen, and what it cannot know. */
  note: string;
};

export type PhaseDiff = {
  slug: string;
  phase: number;
  window: ReviewWindow;
  commits: { sha: string; subject?: string; date?: string; author?: string }[];
  files: DiffFile[];
  additions: number;
  deletions: number;
  /** The diff was capped — the file list is complete, some hunks are not. */
  truncated: boolean;
  /** git could not answer at all. `files` is empty and means nothing. */
  failed: boolean;
};

/**
 * The parser and its per-file cap now live in `shared/diff.js`.
 *
 * Phase 9's Repo destination parses a diff in the BROWSER — `GET /api/repo/diff`
 * answers with raw patch text, because a browse surface pages one file at a time
 * — so the choice was one parser in `shared/` or two copies of the same eighty
 * lines drifting apart. `git.ts`'s `\x1f` forgery (P8 QA round 5, M3) is what a
 * second copy of a parser looks like three months later.
 *
 * Re-exported under the names this module has always exported, so every existing
 * importer of `review.ts` is unaffected.
 */
import { MAX_HUNK_LINES, parseUnifiedDiff } from '../shared/diff.js';
export { MAX_HUNK_LINES, parseUnifiedDiff };

/* ------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------ */

export type WindowInput = {
  root: string;
  /** Absolute path to THIS phase's handoff file, when it has one. */
  handoffPath?: string;
  /** Absolute path to `docs/handoffs/<slug>` — the plan's whole handoff spine. */
  handoffDir?: string;
  /** An explicit override from the caller; either half may be given alone. */
  base?: string;
  tip?: string;
};

/**
 * Where a phase's work sits in history.
 *
 * The order of resort matters more than any one branch:
 *
 *   1. an explicit `base`/`tip` — a reader who has corrected the bracket owns it;
 *   2. the handoff window — the heuristic this file's header sets out;
 *   3. the working tree — a phase that has not written a handoff yet has not
 *      landed anything to bracket, and what it HAS changed is uncommitted;
 *   4. nothing.
 */
export async function resolveWindow(input: WindowInput): Promise<ReviewWindow> {
  const { root } = input;

  if (input.base || input.tip) {
    const base = input.base && await revExists(root, input.base) ? input.base : undefined;
    const tip = input.tip && await revExists(root, input.tip) ? input.tip : undefined;
    if (base || tip) {
      return {
        kind: 'explicit',
        ...(base ? { base } : {}),
        ...(tip ? { tip } : {}),
        note: tip
          ? `The range you asked for: ${base ?? 'the start of history'}..${tip}.`
          : `Everything in the working tree since ${base}.`,
      };
    }
  }

  const own = input.handoffPath ? await commitsTouching(root, input.handoffPath, 20) : [];
  if (!own.length) {
    return {
      kind: 'working-tree',
      note: 'This phase has not committed a handoff, so there is no landing to bracket. '
        + 'What is shown is the working tree against HEAD — whatever is uncommitted right now.',
    };
  }

  const tip = own[0].sha;
  const oldest = own[own.length - 1].sha;

  // The plan's whole handoff spine, newest first. The base is the newest
  // landing that is NOT this phase's — i.e. where the phase before it stopped.
  const spine = input.handoffDir ? await commitsTouching(root, input.handoffDir, 500) : [];
  const ownShas = new Set(own.map((c) => c.sha));
  const oldestIndex = spine.findIndex((c) => c.sha === oldest);
  const candidates = oldestIndex >= 0 ? spine.slice(oldestIndex + 1) : [];
  const previous = candidates.find((c) => !ownShas.has(c.sha));

  const base = previous?.sha ?? await firstParent(root, oldest);
  return {
    kind: 'handoff-window',
    ...(base ? { base } : {}),
    tip,
    note: previous
      ? `Bracketed by the handoffs: from ${previous.sha} (the plan's previous handoff landing) `
        + `to ${tip} (this phase's newest). Commits outside that bracket are not shown — a phase that `
        + 'committed after writing its handoff, or two plans landing into one branch, will move it.'
      : base
        ? `This is the plan's first handoff landing, so the bracket starts at its parent (${base}).`
        : 'This is the first commit in the repository, so the bracket starts from an empty tree.',
  };
}

/**
 * A phase's diff: the window, the commits in it, and the files, file by file.
 *
 * The file list comes from `--numstat` and the hunks from the unified diff, so
 * a diff too large to render still produces a complete, honestly-counted file
 * list with `truncated` set — never a short list that reads like a small change.
 */
export async function phaseDiff(input: WindowInput & {
  slug: string; phase: number; maxBytes?: number;
}): Promise<PhaseDiff> {
  const { root, slug, phase } = input;
  const window = await resolveWindow(input);
  const empty: PhaseDiff = {
    slug, phase, window, commits: [], files: [], additions: 0, deletions: 0,
    truncated: false, failed: false,
  };
  if (window.kind === 'none') return empty;

  const range: DiffRange = {
    ...(window.base ? { base: window.base } : {}),
    ...(window.tip ? { tip: window.tip } : {}),
  };

  const [stats, text, commits] = await Promise.all([
    diffStat(root, range),
    diffText(root, range, { maxBytes: input.maxBytes ?? 2 * 1024 * 1024 }),
    window.tip ? commitsInRange(root, window.base, window.tip) : Promise.resolve([]),
  ]);

  const parsed = parseUnifiedDiff(text.text);
  const byPath = new Map(parsed.map((f) => [f.path, f]));

  // `--numstat` is the spine of the list; the parsed diff supplies hunks where
  // it reached that file. A file present in the stat and absent from the parse
  // is exactly the truncation case, and it appears with real counts and no hunks.
  const files: DiffFile[] = stats.map((stat) => {
    const hit = byPath.get(stat.path);
    if (hit) {
      return {
        ...hit,
        // The stat's counts win: the parse's are what was RENDERED, and a file
        // cut at the per-file cap has fewer of those than it really has.
        additions: stat.additions || hit.additions,
        deletions: stat.deletions || hit.deletions,
        binary: stat.binary || hit.binary,
        ...(stat.oldPath && !hit.oldPath ? { oldPath: stat.oldPath } : {}),
      };
    }
    return {
      path: stat.path,
      ...(stat.oldPath ? { oldPath: stat.oldPath, status: 'renamed' as const } : { status: 'modified' as const }),
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
      hunks: [],
      ...(stat.binary ? {} : { truncated: true }),
    };
  });
  // A parsed file the stat never mentioned (a pure mode change) still belongs.
  for (const f of parsed) if (!stats.some((s) => s.path === f.path)) files.push(f);

  return {
    slug,
    phase,
    window,
    commits,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    truncated: text.truncated || files.some((f) => f.truncated),
    failed: text.failed && !stats.length,
  };
}

/* ------------------------------------------------------------------ *
 * Comment ids
 * ------------------------------------------------------------------ */

/**
 * The next id for a phase's comment list: `c1`, `c2`, …
 *
 * Sequential rather than random, and derived from the highest id ALREADY
 * present rather than from the list length — deleting `c2` from `[c1,c2,c3]`
 * leaves a list of length 2 whose next id would be `c3`, colliding with the
 * `c3` still in it. Short ids matter because a person reads them out of the
 * follow-up prompt ("comment 4 is done"), which a uuid makes impossible.
 */
export function nextCommentId(comments: readonly ReviewComment[]): string {
  let max = 0;
  for (const c of comments) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${max + 1}`;
}

/* ------------------------------------------------------------------ *
 * The follow-up
 * ------------------------------------------------------------------ */

/** The situation key a review follow-up boards under — the journal's vocabulary. */
export const FOLLOW_UP_SITUATION = 'review:follow-up';
/**
 * The vehicle name that appears in the rung history beside the ladder's own.
 *
 * Defined in `runner/state.ts` with the rest of the boarding vocabulary —
 * the board reconciler has to recognise it and `state.ts` sits below this
 * module in the import graph — and re-exported here so the review surface
 * still reads as owning the name.
 */
export { FOLLOW_UP_RUNG } from './runner/state.ts';
/** A follow-up prompt is an instruction, not a document: bounded like every other. */
export const MAX_FOLLOW_UP_BYTES = 16 * 1024;

export type FollowUpInput = {
  slug: string;
  phase: number;
  comments: readonly ReviewComment[];
  /** The verdict standing when Send back was pressed, for the opening line. */
  verdict?: ReviewVerdict;
  /** The reviewer's overall note, quoted before the per-line comments. */
  note?: string;
  by?: string;
};

/**
 * Turn a comment set into the words the phase's next session reads.
 *
 * Three properties this has to have, and each one is a thing that goes wrong
 * when it does not:
 *
 * **Every unresolved comment appears.** A follow-up that quotes four of five
 * comments is worse than none: the session fixes four things, writes a handoff
 * saying it addressed the review, and the fifth is now buried under an
 * approval-shaped record. The count is stated in the prompt so the session can
 * check the list it received against the number it was told to expect.
 *
 * **Each comment carries its anchor.** `path:line` and the line's own text, so
 * the session does not have to re-derive which of six similar call sites was
 * meant. Resolved comments are skipped — they are answered, and re-quoting
 * them asks for work already done.
 *
 * **It says what the session is being asked to do.** Not "here are some
 * comments" but: address these, then finish the phase normally — verification,
 * commit, handoff. A session handed a comment list with no instruction writes a
 * reply in prose and stops, which is the one outcome the board cannot read.
 */
export function composeFollowUp(input: FollowUpInput): string {
  const open = input.comments.filter((c) => !c.resolved);
  const lines: string[] = [];

  lines.push(
    `REVIEW FOLLOW-UP on phase ${input.phase} of "${input.slug}".`,
    '',
    `A reviewer read this phase's diff in the console and left ${open.length} `
      + `comment${open.length === 1 ? '' : 's'} on it${input.by ? ` (${input.by})` : ''}. `
      + 'The phase is being re-boarded so you can address them — this is not a restart, '
      + 'and nothing you already landed has been reverted.',
  );

  if (input.note) {
    lines.push('', 'Their overall note:', '', ...quote(input.note));
  }

  if (open.length) {
    lines.push('', `## The ${open.length} comment${open.length === 1 ? '' : 's'}`, '');
    open.forEach((c, i) => {
      const anchor = c.line != null
        ? `${c.path}:${c.line}${c.side === 'old' ? ' (the removed side)' : ''}`
        : `${c.path} (about the file, not a line)`;
      lines.push(`### ${i + 1}. \`${anchor}\`  · id \`${c.id}\``);
      if (c.hunk) lines.push('', `Context: \`${c.hunk.trim()}\``);
      if (c.code) lines.push('', '```', c.code, '```');
      lines.push('', ...quote(c.body), '');
    });
  } else {
    lines.push(
      '',
      'Every comment on this phase is already marked resolved, so there is nothing quoted '
        + 'below. Treat the overall note above as the whole of the ask; if there is no note '
        + 'either, re-read the phase\'s exit criteria and say in your handoff that the '
        + 'follow-up arrived empty rather than guessing at what was wanted.',
    );
  }

  lines.push(
    '## What to do',
    '',
    `1. Address each comment above. Where you disagree with one, say so in the handoff `
      + `by its id (\`${open.map((c) => c.id).slice(0, 3).join('`, `') || 'cN'}\`) and why — `
      + 'a comment you decided not to act on is a decision, and an unexplained one reads as a miss.',
    '2. Then finish the phase the normal way: run the plan\'s §Verification, commit with '
      + 'explicit paths, and write the handoff. The handoff is still the deliverable.',
    '3. Record the judgement calls with `phase-outcome.sh … ruling` as always.',
    '',
    'Do not edit the plan to make a comment go away, and do not mark the phase complete '
      + 'with comments unaddressed and unexplained.',
  );

  const text = lines.join('\n');
  return text.length > MAX_FOLLOW_UP_BYTES
    ? `${text.slice(0, MAX_FOLLOW_UP_BYTES - 200)}\n\n[…the comment list was cut here at 16 KB. `
      + 'Open the phase\'s review in the console for the rest.]'
    : text;
}

/** Markdown block-quote, line by line — a body with newlines must not escape the quote. */
function quote(body: string): string[] {
  return body.split('\n').map((l) => `> ${l}`);
}

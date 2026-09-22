/**
 * Git context for the docs tree: who last touched a plan, and whether its
 * artefacts are committed and pushed. Read-only — nothing here writes to a
 * repository.
 */

import { relative } from 'node:path';

import { shell } from './shell.ts';

export type GitFileInfo = {
  sha?: string;
  subject?: string;
  author?: string;
  date?: string;
  relativeDate?: string;
};

export type GitRepoInfo = {
  available: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** Paths under docs/ with uncommitted changes, relative to the repo root. */
  dirty: string[];
};

/**
 * Field separator inside a `--format`: **NUL**, not the unit separator.
 *
 * 🔴 `\x1f` was a forgery, and `git-browse.ts` said so in a note of its own
 * when it moved (P8 QA round 4) — pointing at THIS file, which never did. A
 * commit subject may legally contain `\x1f`; nothing rejects it; so a crafted
 * message shifted every field after it, and a commit could report an author, an
 * author date and a relative date of its own choosing, with the fabricated date
 * PARSING. NUL is the one byte git’s porcelain will not carry inside a commit
 * message, which is why `log` offers it as a format escape for exactly this.
 *
 * TWO constants, not one, for the reason `git-browse.ts` needs three: the byte
 * may never appear in an ARGV — `execFile` rejects an argument containing NUL
 * outright (`ERR_INVALID_ARG_VALUE`) — so what goes into the argv is git’s own
 * ESCAPE and what the parser splits on is the byte git then emits.
 *
 * The RECORD separator stays the newline, because none of these fields can
 * contain one: `%s` is the subject, which git’s own `format_subject` joins
 * wrapped lines into with spaces, and `%h`, `%an` and the dates are
 * single-line by construction.
 */
const SEP = '\x00';
/** `git log --format` escape for it. Never the literal byte. */
const SEP_LOG = '%x00';

async function git(
  cwd: string, args: string[], timeout = 5000, env?: NodeJS.ProcessEnv,
): Promise<string> {
  // `env` REPLACES the inherited set when a caller passes one. Only
  // `git-browse.ts` does, and for a reason worth naming here: a `GIT_DIR` in
  // the console's own environment makes these reads answer about a different
  // repository, and the browse surface is reachable from a browser. Absent,
  // the child inherits exactly as it always did.
  const run = await shell('git', args, {
    channel: 'git', intent: 'read', cwd, timeout,
    // `head`, not `ends`: every caller of this helper PARSES what it returns.
    capture: { keep: 4 * 1024 * 1024, mode: 'head' },
    ...(env ? { env } : {}),
    // This helper answers `''` for every failure by contract — several callers
    // ask questions whose answer is legitimately "no" (is this a work tree, has
    // this ref an upstream).
    expectFailure: true,
  });
  return run.ok ? run.stdout : '';
}

export async function repoInfo(root: string, docsDir?: string): Promise<GitRepoInfo> {
  const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') return { available: false, dirty: [] };

  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || undefined;

  const tracking = (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim();
  const counts = tracking ? tracking.split(/\s+/).map(Number) : [];

  const scope = docsDir ? [relative(root, docsDir) || '.'] : [];
  const status = await git(root, ['status', '--porcelain', '--', ...scope]);
  const dirty = status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);

  return { available: true, branch, ahead: counts[0], behind: counts[1], dirty };
}

/** Last commit that touched `path`. */
export async function lastCommit(root: string, path: string): Promise<GitFileInfo> {
  const format = ['%h', '%s', '%an', '%aI', '%ar'].join(SEP_LOG);
  const out = await git(root, ['log', '-1', `--format=${format}`, '--', path]);
  const [sha, subject, author, date, relativeDate] = out.trim().split(SEP);
  return sha ? { sha, subject, author, date, relativeDate } : {};
}

/**
 * The commits that touched `path`, newest first.
 *
 * Used to give a QA session somewhere concrete to start reading. A phase's
 * handoff is the one file every phase certainly writes, so the commits that
 * touched it bracket where the phase landed — the reviewer widens from there,
 * because the code itself usually lands in commits that never went near docs/.
 *
 * `path` may be several paths, which is one `git log` over all of them in git's
 * own ordering — the only way to ask "where did this plan FIRST land" when the
 * answer could be either the plan file or a handoff, and comparing two separate
 * newest-first lists by their `--date=short` strings cannot break a same-day tie.
 *
 * The cap on `limit` is 1000, not 20. It was 20, silently, while `resolveWindow`
 * asked for 500: a plan with more than twenty handoff commits had its spine cut
 * short, the phase's own oldest commit fell off the end, and the review window
 * quietly narrowed to that one commit's parent. A landing packet reads the
 * OLDEST entry, so the truncation would have put the base in the middle of the
 * plan and shipped a bundle missing its first phases.
 */
export async function commitsTouching(
  root: string, path: string | string[], limit = 5,
): Promise<{ sha: string; subject?: string; date?: string }[]> {
  const paths = Array.isArray(path) ? path.filter(Boolean) : [path];
  if (!paths.length) return [];
  const format = ['%h', '%s', '%ad'].join(SEP_LOG);
  const out = await git(root, ['log', `-${Math.max(1, Math.min(limit, 1_000))}`, `--format=${format}`,
    '--date=short', '--', ...paths]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, date] = line.split(SEP);
    return { sha, ...(subject ? { subject } : {}), ...(date ? { date } : {}) };
  }).filter((entry) => entry.sha);
}

/** Which of these paths have uncommitted changes. */
export async function uncommitted(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const out = await git(root, ['status', '--porcelain', '--', ...paths]);
  return new Set(out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean));
}

/* ------------------------------------------------------------------ *
 * Diff plumbing — everything the review surface reads.
 *
 * Still read-only: `diff`, `log` and `rev-parse` are the only verbs below, and
 * nothing here takes a lock, checks anything out, or writes an object.
 * ------------------------------------------------------------------ */

/** Does this revision resolve to a commit in this repository? */
export async function revExists(root: string, rev: string): Promise<boolean> {
  if (!rev) return false;
  return Boolean((await git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).trim());
}

/** `<sha>^`, when it has a first parent — a root commit has none. */
export async function firstParent(root: string, sha: string): Promise<string | undefined> {
  const out = (await git(root, ['rev-parse', '--verify', '--quiet', `${sha}^`])).trim();
  return out || undefined;
}

/**
 * The commits in `base..tip`, newest first.
 *
 * `base` absent means "everything up to tip", which is what the very first
 * phase of a plan actually wants: there is no earlier landing to bracket
 * against, and refusing to answer would show an empty review rather than the
 * first phase's work.
 */
export async function commitsInRange(
  root: string, base: string | undefined, tip: string, limit = 200,
): Promise<{ sha: string; subject?: string; date?: string; author?: string }[]> {
  const format = ['%h', '%s', '%ad', '%an'].join(SEP_LOG);
  const range = base ? `${base}..${tip}` : tip;
  const out = await git(root, [
    'log', `-${Math.max(1, Math.min(limit, 500))}`, `--format=${format}`, '--date=short', range,
  ]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, date, author] = line.split(SEP);
    return {
      sha,
      ...(subject ? { subject } : {}),
      ...(date ? { date } : {}),
      ...(author ? { author } : {}),
    };
  }).filter((entry) => entry.sha);
}

export type DiffOutput = {
  text: string;
  /** The diff was larger than the byte budget, so `text` is a prefix of it. */
  truncated: boolean;
  /** git refused, or the buffer blew — `text` is empty and says NOTHING. */
  failed: boolean;
};

/** The range a diff is asked for. Absent `tip` means the working tree. */
export type DiffRange = { base?: string; tip?: string };

/** `git diff` arguments for a range, shared by the text and the stat reads. */
function rangeArgs(range: DiffRange): string[] {
  if (range.base && range.tip) return [`${range.base}..${range.tip}`];
  // A tip with no base is one commit: `^!` is git's own spelling for it, and it
  // is right for a root commit too, where `<sha>^..<sha>` cannot resolve.
  if (range.tip) return [`${range.tip}^!`];
  // A base with no tip compares the working tree against that base — what a
  // phase still in flight has actually changed so far.
  if (range.base) return [range.base];
  return ['HEAD'];
}

/**
 * The unified diff for a range, or for the working tree when `tip` is absent.
 *
 * The byte budget is the point. A phase that touched a lockfile can produce a
 * diff measured in megabytes, and the two dishonest answers are both easy to
 * write by accident: buffer the lot and hand a browser a hundred megabytes, or
 * let `execFile` blow its buffer and return `''`, which renders as "this phase
 * changed nothing". So the output is capped and the cap is REPORTED — a caller
 * that hits it can say the diff was cut instead of that it was empty.
 */
export async function diffText(
  root: string,
  range: DiffRange,
  opts: {
    maxBytes?: number; unified?: number; paths?: string[]; timeout?: number;
    /** Replaces the inherited environment — see `git()` above. */
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<DiffOutput> {
  const maxBytes = Math.max(64 * 1024, opts.maxBytes ?? 2 * 1024 * 1024);
  const args = [
    'diff', '--no-color', '--no-ext-diff', '-M',
    // The prefixes are PINNED rather than left to the reader's git config.
    // `diff.mnemonicPrefix` renames them per operation — `c/` and `w/` for a
    // working-tree diff, `i/` and `w/` for a staged one — so a parser that
    // expects `a/`/`b/` silently mis-reads every path on a machine that has it
    // set. These two flags are the default values, so nothing changes for
    // anyone without that setting. (P8 QA round 2, Low.)
    '--src-prefix=a/', '--dst-prefix=b/',
    `--unified=${Math.max(0, Math.min(opts.unified ?? 3, 20))}`,
    ...rangeArgs(range),
  ];
  if (opts.paths?.length) args.push('--', ...opts.paths);

  // One byte over the budget is how truncation is DETECTED: ask for the budget
  // plus one, and a buffer that came back longer means there was more.
  const raw = await gitRaw(root, args, {
    maxBuffer: maxBytes + 1, timeout: opts.timeout ?? 20_000, ...(opts.env ? { env: opts.env } : {}),
  });
  if (raw === null) return { text: '', truncated: false, failed: true };
  if (raw.length > maxBytes) return { text: raw.slice(0, maxBytes), truncated: true, failed: false };
  return { text: raw, truncated: false, failed: false };
}

export type DiffStatRow = {
  path: string;
  /** Set only on a rename or copy — where the file came from. */
  oldPath?: string;
  additions: number;
  deletions: number;
  binary: boolean;
};

/**
 * Per-file adds/deletes for the same range.
 *
 * Small enough never to be capped, which is what makes it the fallback: a diff
 * too big to render still yields an honest FILE LIST with real counts, so the
 * review says "47 files, hunks not shown" rather than nothing.
 *
 * `-z` is not optional here. Without it git compresses a rename into ONE field
 * with brace syntax — `src/{old.ts => new.ts}` — which is a path that exists
 * nowhere and matches nothing the unified diff calls a file, so every renamed
 * file would appear twice in a review: once from the parse with its hunks, and
 * once from the stat under a name with an arrow in it. With `-z` the two
 * pathnames arrive as their own NUL-terminated fields and say which is which.
 */
export async function diffStat(
  root: string, range: DiffRange, opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<DiffStatRow[]> {
  return (await diffStatDetailed(root, range, opts)).rows;
}

/** Bytes of `--numstat -z` a stat read may produce before it is a truncation. */
const STAT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The same read, able to say **"there was more than I could hold"**.
 *
 * 🔴 `git()` caps stdout at 4 MB and answers `''` on overflow, and `''` parses
 * to ZERO ROWS — so a range touching 26 000 files, whose `--numstat` is tens of
 * megabytes, reached the Changes section as an empty list and rendered as
 * *"nothing changed"* (G-DIFF). The one thing a diff surface must never say
 * about a range that changed everything. A capped answer and a failure are
 * different facts, and so is a capped answer and an empty one: this returns
 * whatever rows it could parse AND says the list stops short, which is what the
 * caller needs to write "diff too large to list" instead of a lie.
 */
export async function diffStatDetailed(
  root: string, range: DiffRange, opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ rows: DiffStatRow[]; overflow: boolean }> {
  // One byte over the budget is how truncation is DETECTED — `diffText`'s own
  // trick, and the reason this cannot go through the swallowing `git()`.
  const raw = await gitRaw(root, [
    'diff', '--no-color', '--no-ext-diff', '-M', '--numstat', '-z', ...rangeArgs(range),
  ], { maxBuffer: STAT_MAX_BYTES + 1, timeout: 15_000, ...(opts.env ? { env: opts.env } : {}) });
  // A read that FAILED is not an overflow and not an empty diff — it is a
  // question that could not be put. `[]` with `overflow: false` is what every
  // caller has always got for it.
  if (raw === null) return { rows: [], overflow: false };
  const overflow = raw.length > STAT_MAX_BYTES;
  // The final record of a truncated stream is a fragment, so it is dropped
  // rather than parsed into a row with half a pathname in it.
  const out = overflow ? raw.slice(0, raw.lastIndexOf('\0') + 1) : raw;
  const fields = out.split('\0');
  const rows: DiffStatRow[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const head = fields[i];
    if (!head) continue;
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(head);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const counts = {
      additions: binary ? 0 : Number(m[1]) || 0,
      deletions: binary ? 0 : Number(m[2]) || 0,
      binary,
    };
    // An empty third group is git saying "the two pathnames follow".
    if (m[3]) {
      rows.push({ path: m[3], ...counts });
      continue;
    }
    const oldPath = fields[i + 1];
    const newPath = fields[i + 2];
    if (!newPath) continue;
    i += 2;
    rows.push({ path: newPath, ...(oldPath ? { oldPath } : {}), ...counts });
  }
  return { rows, overflow };
}

/**
 * `git`, but able to say "that failed" rather than answering with an empty
 * string. Only the diff reads above need the distinction, so the swallowing
 * helper every other function here uses stays exactly as it was.
 */
async function gitRaw(
  cwd: string, args: string[],
  opts: { maxBuffer: number; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const run = await shell('git', args, {
    channel: 'git', intent: 'read-raw', cwd, timeout: opts.timeout,
    // The old `maxBuffer` truncated from the front and delivered the prefix;
    // `head` is that behaviour exactly, and it is what a parser needs.
    capture: { keep: opts.maxBuffer, mode: 'head' },
    ...(opts.env ? { env: opts.env } : {}),
    expectFailure: true,
  });
  // A capped answer is still an answer — that was true of `maxBuffer` too. No
  // output at all is a real failure.
  if (!run.ok && !run.stdout) return null;
  return run.stdout;
}

/* ------------------------------------------------------------------ *
 * Landing plumbing — exporting a branch's work without touching a remote.
 *
 * `bundle create` and `format-patch` are the only two verbs in this file that
 * produce a FILE, and neither one writes to the repository: no ref moves, no
 * object is added, no index or working tree is touched, and nothing is
 * transmitted anywhere. They are `git log` with a different output format.
 *
 * That distinction is the whole point of the landing packet. The console's
 * standing invariant is that it never pushes and never passes `--git` to a
 * script (`viewer/test/never-push.test.ts` pins both, and `engine.ts` +
 * `writes.ts` refuse `--git` at runtime), so the way it hands work over is to
 * write the work to disk and let a PERSON decide where it goes.
 * ------------------------------------------------------------------ */

/** What a git write-to-disk did, or why it did not. */
export type GitExport = {
  ok: boolean;
  /** git's own words when it refused — the empty-range refusal is the common one. */
  error?: string;
};

export type BranchState = {
  available: boolean;
  /** The checked-out branch, absent on a detached HEAD. */
  branch?: string;
  head?: string;
  /** `origin/<branch>`, or absent — an unpushed plan branch has no upstream and that is not an error. */
  upstream?: string;
  ahead?: number;
  behind?: number;
  /** Every uncommitted path in the whole tree, capped — the landing must say what it does NOT carry. */
  dirty: string[];
  /** True when `dirty` was cut to the cap. */
  dirtyTruncated: boolean;
};

const DIRTY_CAP = 50;

/**
 * The branch a landing would be cut from, with the two facts that decide
 * whether the packet is the whole story: is there an upstream, and is the tree
 * clean?
 *
 * Deliberately NOT `repoInfo`. That one scopes its dirty list to `docs/`,
 * because its question is "are the plan's artefacts committed". This one asks
 * "is anything at all uncommitted", because a bundle carries commits and an
 * operator handed one while a source file is still dirty has been handed a
 * packet that silently omits their work.
 */
export async function branchState(root: string): Promise<BranchState> {
  const inside = (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (inside !== 'true') return { available: false, dirty: [], dirtyTruncated: false };

  const named = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const branch = named && named !== 'HEAD' ? named : undefined;
  const head = (await git(root, ['rev-parse', 'HEAD'])).trim() || undefined;
  const upstream = (await git(root, [
    'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
  ])).trim() || undefined;

  const tracking = upstream
    ? (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim()
    : '';
  const counts = tracking ? tracking.split(/\s+/).map(Number) : [];

  const status = await git(root, ['status', '--porcelain']);
  const all = status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);

  return {
    available: true,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    ...(upstream ? { upstream } : {}),
    ...(counts.length ? { ahead: counts[0], behind: counts[1] } : {}),
    dirty: all.slice(0, DIRTY_CAP),
    dirtyTruncated: all.length > DIRTY_CAP,
  };
}

/**
 * `git bundle create` for a range — a single file carrying real commits.
 *
 * `ref` is what the bundle will be fetchable AS, so a branch name is worth
 * passing when there is one: the receiving repo gets `refs/heads/<branch>`
 * rather than a bare `HEAD`, and landing becomes one `git fetch`.
 *
 * An EMPTY range is the failure worth naming. git refuses it — *"Refusing to
 * create empty bundle"* — and writes no file at all, so a composer that
 * ignored the exit status would advertise a download that 404s.
 */
export async function bundleCreate(
  root: string, outFile: string, range: { base?: string; ref: string },
): Promise<GitExport> {
  const spec = range.base ? `${range.base}..${range.ref}` : range.ref;
  return gitWrite(root, ['bundle', 'create', outFile, spec], 120_000);
}

/**
 * `git bundle verify` — what the receiving repository must already have.
 *
 * The prerequisite list is the useful half: a bundle cut from `base..tip` can
 * only be fetched into a repo that already contains `base`, and an operator
 * who is told which commit that is can check before trying.
 */
export async function bundleVerify(
  root: string, file: string,
): Promise<{ ok: boolean; prerequisites: string[]; detail: string }> {
  const out = await gitBoth(root, ['bundle', 'verify', file], 60_000);
  const text = `${out.stdout}\n${out.stderr}`;

  // `verify` prints the refs the bundle CONTAINS and the refs it REQUIRES in
  // the same `<sha> <name>` shape, under two English headings. Keying off the
  // headings would make this a translation away from reporting the bundle's own
  // tip as a prerequisite — which is exactly what the first cut did, so a
  // bundle needing nothing claimed to need itself.
  //
  // `list-heads` prints only the contents, so the difference is the
  // requirement, in any locale.
  const contents = new Set(shasIn(
    (await gitBoth(root, ['bundle', 'list-heads', file], 30_000)).stdout,
  ));
  const prerequisites = shasIn(text).filter((sha) => !contents.has(sha));

  return { ok: out.ok, prerequisites, detail: text.trim().slice(0, 2_000) };
}

/** Every line that STARTS with an object name, in order, de-duplicated. */
function shasIn(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const sha = /^([0-9a-f]{7,40})\b/.exec(line.trim())?.[1];
    if (sha) seen.add(sha);
  }
  return [...seen];
}

/**
 * `git format-patch` into a directory — the same commits as a mail series.
 *
 * Written beside the bundle rather than instead of it because they answer
 * different questions: a bundle is the exact history (merges, authorship,
 * parents), a patch series is what a person can read, edit and apply one at a
 * time. `-o` creates the directory, and the file list comes back in git's own
 * order, which is the order they must be applied in.
 */
export async function formatPatch(
  root: string, outDir: string, range: { base?: string; ref: string }, limit = 500,
): Promise<GitExport & { files: string[] }> {
  const spec = range.base ? `${range.base}..${range.ref}` : range.ref;
  const out = await gitBoth(root, [
    'format-patch', '--no-color', `-${Math.max(1, Math.min(limit, 1_000))}`, '-o', outDir, spec,
  ], 120_000);
  const files = out.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!out.ok) return { ok: false, files: [], error: out.stderr.trim().slice(0, 500) || 'git format-patch failed' };
  return { ok: true, files };
}

/**
 * A git verb that writes a file: judged by its exit status, not its stdout.
 *
 * Every other helper in this file resolves `''` on failure, which is right for
 * a read — an unanswerable question and an empty answer are the same thing to
 * a display. It is exactly wrong for an export: "the bundle is empty" and "no
 * bundle was written" must not look alike.
 */
async function gitWrite(cwd: string, args: string[], timeout: number): Promise<GitExport> {
  const run = await shell('git', args, {
    channel: 'git', intent: 'export', cwd, timeout,
    capture: { keep: 4 * 1024 * 1024, mode: 'head' },
  });
  if (run.ok) return { ok: true };
  return { ok: false, error: run.stderr.trim().slice(0, 500) || run.error?.message || `exit ${run.code}` };
}

/** Both streams and the exit status — for the verbs whose stderr is the answer. */
async function gitBoth(
  cwd: string, args: string[], timeout: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const run = await shell('git', args, {
    channel: 'git', intent: 'export-verify', cwd, timeout,
    capture: { keep: 8 * 1024 * 1024, mode: 'head' },
    // A translated git is still a correct git; a parser that reads its prose
    // is not. Nothing here depends on the wording any more (see
    // `bundleVerify`), and pinning the locale keeps it that way.
    env: { ...process.env, LC_ALL: 'C', NO_COLOR: '1', TERM: 'dumb' },
    // `bundleVerify` asks a yes/no question; a `no` is its answer.
    expectFailure: true,
  });
  return { ok: run.ok, stdout: run.stdout, stderr: run.stderr };
}

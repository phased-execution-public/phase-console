/**
 * The repository browse surface — read-only git facts for the Repo destination.
 *
 * Everything the console already knew about a repository was wired to one
 * narrow consumer: `review.ts` reads one phase's window, `service-runs.ts`
 * caches one live run's `RunGitView`, `landing.ts` exports one finished plan.
 * A person looking at the repository asks a different question — what does the
 * history look like, which branches exist, who is holding a checkout, what
 * changed, where did the work land — and asks it about runs that have STOPPED,
 * which is precisely the case the cached view answers `null` for.
 *
 * So this module recomposes the existing readers rather than growing new ones:
 * `git.ts`'s byte-capped `diffText` and rename-aware `diffStat`, and
 * `runner/worktree.ts`'s `checkouts()` porcelain parse. What is new here is the
 * repository-wide framing, the run join that survives a stopped run, and the
 * safety envelope every one of these endpoints has to sit inside.
 *
 * ## Why this is a new file rather than more of `git.ts`
 *
 * `git.ts` answers two settled questions — "is this plan's paperwork committed"
 * and "what would a landing packet carry" — with caps chosen for those. This
 * one is a browse surface reachable from a URL, so it needs a different
 * envelope: an allowlist of directories, validation of every caller-supplied
 * string, and a truncation marker on every list. Mixing the two would mean the
 * landing plumbing quietly inherited an HTTP threat model.
 *
 * ## The safety envelope (all five surfaces)
 *
 *  1. **Nothing the caller sends becomes a directory.** A repository is chosen
 *     from `repoTargets()` — the console root, the checkouts git itself has
 *     registered, and the mirror mounts a run recorded — BY KEY. An unknown key
 *     is a refusal, not a path.
 *  2. **Nothing the caller sends becomes a flag.** Every ref is validated
 *     (`safeRev`) and, where it names a branch, must appear in the repository's
 *     own ref list; every path is validated (`safePath`) and always passed
 *     after `--`. A leading `-` is rejected everywhere, which is the whole
 *     `--upload-pack=` class.
 *  3. **argv arrays only** — `execFile`, never a shell, so quoting and `;` and
 *     `$(…)` are not a category that exists here.
 *  4. **The environment is BUILT, not inherited.** `gitEnv()` hands the child
 *     `PATH`/`HOME` and the locale + no-prompt pins and nothing else, so a
 *     token in the console's environment cannot reach a subprocess that a
 *     browser can cause to run.
 *  5. **Every answer is bounded and says so.** A list that stops silently is a
 *     lie about the repository; every one of these carries its own
 *     `…Truncated` flag beside it.
 *
 * ## The wall this file lives behind
 *
 * `viewer/test/never-push.test.ts` scans every argv literal under `server/`.
 * The verbs used here — `log`, `for-each-ref`, `rev-list`, `rev-parse`, `diff`
 * — are on its console-wide allow-list; the repository-mutating verbs are not,
 * and `worktree list` is exempted for `runner/worktree.ts` ALONE, which is why
 * the checkout registry is imported from there instead of re-parsed here.
 *
 * 🔴 A consequence worth knowing before editing: that gate also asserts that
 * two particular verbs appear in an array literal in exactly ONE file. An
 * innocent vocabulary array here — the three checkout states, or a pair of
 * lifecycle words — turns the gate red from a file that runs no git at all.
 * Hence `linked` in `RepoTargetKind`, and an object rather than a list for
 * `SETTLE_EVENTS`.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { diffStatDetailed, diffText, type DiffOutput, type DiffStatRow } from './git.ts';
import {
  checkouts, parseGitmodulesPaths, realish, stagingNames, type CheckoutEntry,
} from './runner/worktree.ts';
import type { JournalEntry } from './runner/journal.ts';
import type { RunState } from './runner/state.ts';
import { detachedRef, type SettleStrategy } from '../shared/worktree-model.js';
import { shell } from './shell.ts';

/* ------------------------------------------------------------------ *
 * Caps. Every one of them is reported when it bites.
 * ------------------------------------------------------------------ */

/** Commits per graph page. */
export const GRAPH_LIMIT_DEFAULT = 120;
export const GRAPH_LIMIT_MAX = 500;

/** Branches listed. A repository with more has other problems. */
export const BRANCH_CAP = 300;

/**
 * Branches we compute ahead/behind for when git cannot do it in one process.
 *
 * The fallback is one `rev-list` per branch, so this is a subprocess budget
 * rather than a display choice: 60 forks at ~5 ms is a tenth of a second, 300
 * would be half of it on every poll. Branches past the cap report no
 * divergence at all rather than a guess, and `divergenceTruncated` says so.
 */
export const DIVERGENCE_CAP = 60;

/** Files named by a diff before the list is cut. */
export const DIFF_FILE_CAP = 500;

/** Bytes of unified patch. `git.ts` owns the same idea for the review window. */
export const PATCH_BYTES_DEFAULT = 256 * 1024;
export const PATCH_BYTES_MAX = 2 * 1024 * 1024;

/** Settle rows returned, newest first. */
export const SETTLE_CAP = 200;

/** How long any one git read may take before it is abandoned. */
const READ_TIMEOUT_MS = 15_000;

/** Bytes of stdout a git read may produce. */
const READ_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Field separator inside a `--format`: **NUL**, not the unit separator.
 *
 * 🔴 `git.ts` uses `\x1f` and this module copied it, which was wrong the moment
 * the fields came from repository CONTENT rather than from git's own metadata.
 * A commit subject may legally contain `\x1f` — nothing rejects it — so a
 * crafted message shifted every field after it: measured (P8 QA round 4), a
 * commit could report an author and an author date of its own choosing, and the
 * fabricated date PARSED. The ref reader shifted identically, fabricating an
 * upstream on every branch and erasing the `current` marker from all of them.
 *
 * NUL is the one byte git's own porcelain will not carry inside a commit
 * message or a ref name, which is why `git log` and `for-each-ref` both offer
 * it as a format escape for exactly this purpose.
 *
 * 🔴 Three constants and not one, because the byte may never appear in an
 * ARGV: `execFile` rejects an argument containing NUL outright
 * (`ERR_INVALID_ARG_VALUE`), so a format string built with the literal byte
 * throws before git is reached. What goes into the argv is git's own ESCAPE —
 * spelled differently by the two commands — and what the parsers split on is
 * the byte git then emits.
 */
/** The byte the parsers split on. Never appears in an argv. */
const SEP = '\x00';
/** `git log --format` escape for it. */
const SEP_LOG = '%x00';
/** `for-each-ref --format` escape for it — a different spelling, same byte. */
const SEP_REF = '%00';

/* ------------------------------------------------------------------ *
 * The git door
 * ------------------------------------------------------------------ */

/**
 * The environment a browse subprocess gets — constructed, never inherited.
 *
 * The console's own environment holds a run's bearer token, an account's
 * credentials and whatever the operator's shell exported. None of it is any
 * business of a `git log` that a browser asked for, and "we only run read
 * verbs" is a promise about today's code rather than a property of the
 * process. So the child gets the variables git actually needs and the pins
 * that make its output parseable:
 *
 *  - `PATH`/`HOME` — git must be findable, and must find the user's config
 *    (a missing `HOME` makes git read a different identity, not none).
 *  - `LC_ALL`/`NO_COLOR`/`TERM` — a translated git is still a correct git; a
 *    parser reading its prose is not. `git.ts` §`gitBoth` pins these for the
 *    same reason.
 *  - `GIT_OPTIONAL_LOCKS=0` — asks git not to take `index.lock` for a read, so
 *    a browse read does not collide with a session committing in the same
 *    tree. ⚠️ A REQUEST, not a guarantee: it covers the opportunistic index
 *    refresh and not every code path, and two reviewers measured the
 *    working-tree `diff` case differently on the same git 2.53.0 (P8 QA rounds
 *    1 and 2). Treat it as narrowing the window, not closing it — the
 *    working-tree diff (`base` with no `tip`) is the only surface here that
 *    writes anything at all, and it is the one to look at first if a session
 *    ever reports a locked index.
 *  - `GIT_TERMINAL_PROMPT=0` — nothing here talks to a remote, and if a future
 *    edit made it, it must fail rather than hang on a credential prompt.
 */
export function gitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH ?? '/usr/bin:/bin:/usr/local/bin',
    HOME: source.HOME ?? '',
    LC_ALL: 'C',
    NO_COLOR: '1',
    TERM: 'dumb',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

type GitRead = { ok: boolean; stdout: string };

/**
 * One bounded, read-only git call.
 *
 * `ok` is kept — unlike `git.ts`'s swallowing helper — because several parsers
 * below have to distinguish "this branch has no upstream" from "we could not
 * ask", and answering both with `''` is how a display ends up asserting a fact
 * it never measured.
 */
async function git(cwd: string, args: string[], timeout = READ_TIMEOUT_MS): Promise<GitRead> {
  const run = await shell('git', args, {
    channel: 'git', intent: 'browse', cwd, timeout,
    capture: { keep: READ_MAX_BUFFER, mode: 'head' },
    env: gitEnv(),
    // Every read here is speculative — does this branch have an upstream, does
    // this ref exist — and `ok:false` is the answer the parsers below read.
    expectFailure: true,
  });
  return { ok: run.ok, stdout: run.stdout };
}

/* ------------------------------------------------------------------ *
 * Validation — the second half of the safety envelope
 * ------------------------------------------------------------------ */

/**
 * Is this string safe to hand git as a revision?
 *
 * Three separate refusals, because they fail differently:
 *
 *  - **A leading `-`** would be read as an OPTION. That is the whole injection
 *    class worth naming here: `--upload-pack=…`, `--output=…`, `-c` — none of
 *    them needs a shell, a semicolon or a quote, only a caller who believed
 *    "it is just an argument".
 *  - **`..` and `...`** would silently turn one argument into a RANGE. Every
 *    caller below composes its own range from validated halves; a base that
 *    smuggled `..` into it would produce a diff of something nobody asked for.
 *  - **Anything outside the charset**, which keeps NUL, whitespace, globs,
 *    `:` (git's path-in-rev syntax) and `\` out without having to reason about
 *    each one.
 *
 * The charset admits `,` and `+` because git admits them in a ref name and
 * neither can become a flag, a range, a pathspec or a glob — a branch called
 * `feat,with-a-comma` is legal and was refused. The rule for widening it: a
 * character is admitted when git allows it in a ref AND it cannot turn the
 * argument into one of those four things. `*`, `?`, `[` stay out because
 * `for-each-ref` reads its argument as a PATTERN; `:` because of `rev:path`;
 * whitespace and control bytes because they end an argument's identity.
 *
 * Deliberately NOT a claim that the ref EXISTS. That is a second question, and
 * the callers that need it ask git (`revExists`, or membership in the ref
 * list) rather than trusting a regular expression to have thought of
 * everything.
 */
export function safeRev(value: unknown): string | null {
  const rev = typeof value === 'string' ? value.trim() : '';
  if (!rev || rev.length > 200) return null;
  if (rev.startsWith('-')) return null;
  if (rev.includes('..')) return null;
  // 🔴 A DENYLIST, because the allowlist refused names git is perfectly happy
  // to create and this module perfectly happy to LIST (G-REF): an apostrophe,
  // a `#`, parentheses, `=`, `!`, `%`, anything non-ASCII. The branches section
  // linked each row to `graph?ref=<name>` and the graph then refused it — and
  // the refusal is deliberately indistinguishable from "that revision is not
  // here", so a legal branch simply could not be opened, with no way to tell
  // why. What is actually being defended against is an argument read as an
  // OPTION or as a RANGE (both above), and a value git could take for a
  // pathspec; everything else the callers settle by ASKING git (`revExists`,
  // membership in the ref list), which is what the header already says this
  // function leaves to them.
  //
  // The rule is GIT'S OWN, from `check-ref-format`: a ref name may not contain
  // a control byte, whitespace, `:`, `?`, `*`, `[` or `\\`. Everything it does
  // permit — `!`, `#`, `$`, `%`, `&`, `'`, `(`, `)`, `;`, `<`, `=`, `>`, `|`,
  // `,`, and every non-ASCII byte — is accepted here, and the four rev-syntax
  // characters the old allowlist carried (`~ ^ { } @`) stay. `:` and `\\` are
  // kept out on top of that: `\\` git forbids anyway, and `HEAD:file` names a
  // BLOB, which no surface here has a reason to take.
  //
  // The shell metacharacters this used to refuse are not a category that exists
  // on this surface, and this module's own header says so in as many words —
  // *"argv arrays only — `execFile`, never a shell, so quoting and `;` and
  // `$(…)` are not a category that exists here"*. Refusing them bought nothing
  // and cost a branch its page.
  if (/[\u0000-\u0020\u007f:?*[\\]/.test(rev)) return null;
  return rev;
}

/**
 * Is this string safe to hand git as a pathspec?
 *
 * Same leading-`-` refusal for the same reason, plus two that are specific to
 * paths: an ABSOLUTE path or a `..` segment would reach outside the
 * repository, and git is perfectly happy to diff a file it was pointed at that
 * way. Magic pathspecs (`:(glob)…`, `:!…`) are refused by the `:` charset
 * rule — they are a small language, and a browse surface has no reason to
 * expose it.
 *
 * The caller still passes the result after `--`. Both, not either: `--` alone
 * does not stop `../../etc/passwd`, and validation alone does not stop a path
 * that happens to look like a rev.
 */
export function safePath(value: unknown): string | null {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path || path.length > 4_096) return null;
  if (path.startsWith('-') || isAbsolute(path)) return null;
  if (path.split('/').some((part) => part === '..')) return null;
  if (!/^[^\0:*?<>|"\\]+$/.test(path)) return null;
  return path;
}

/** A caller-supplied count, clamped into a range with a stated default. */
function bounded(value: unknown, fallback: number, max: number, min = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

/* ------------------------------------------------------------------ *
 * Targets — which directories may be asked about at all
 * ------------------------------------------------------------------ */

/**
 * What kind of directory a target is.
 *
 * `linked` rather than the obvious word: see the file header — the never-push
 * gate asserts that one particular string appears in an array literal in one
 * file only, and a vocabulary array here would break it from a file that runs
 * no git. Using git's own adjective for a linked checkout costs nothing.
 */
export type RepoTargetKind = 'root' | 'submodule' | 'linked' | 'mount';

/** How deep a nest of superprojects the submodule walk follows. */
const SUBMODULE_DEPTH_CAP = 5;

export type SubmoduleDir = {
  /** Root-relative path, as `.gitmodules` spells it (`/`-joined). */
  rel: string;
  /** Absolute, symlinks resolved. */
  dir: string;
};

/**
 * Every INITIALISED submodule under a root — parents before children.
 *
 * A superproject such as a docs hub is several repositories, and a person
 * asking "what is checked out" means all of them: the root that holds the
 * plans and every submodule the phases edit. `.gitmodules` is the honest list
 * of what is declared; a declared path with no `.git` in it is not initialised
 * and has nothing to answer about, so it is skipped rather than 404ing every
 * surface that would have named it. Recursive, so a submodule that is itself
 * a superproject brings its own, depth-capped like the mirror's mount walk.
 */
export function submoduleDirs(root: string, depth = 0): SubmoduleDir[] {
  if (depth >= SUBMODULE_DEPTH_CAP) return [];
  const top = realish(root);
  const out: SubmoduleDir[] = [];
  for (const declared of parseGitmodulesPaths(top)) {
    const rel = safePath(declared);
    if (!rel) continue;
    const dir = realish(join(top, ...rel.split('/')));
    if (!existsSync(join(dir, '.git'))) continue;
    out.push({ rel, dir });
    for (const nested of submoduleDirs(dir, depth + 1)) {
      out.push({ rel: `${rel}/${nested.rel}`, dir: nested.dir });
    }
  }
  return out;
}

export type RepoTarget = {
  /** The opaque handle a caller passes back. Never a path. */
  key: string;
  /** Absolute directory. Produced here, never received. */
  dir: string;
  /** What to show a person. */
  label: string;
  kind: RepoTargetKind;
};

/**
 * Every directory this console will answer questions about.
 *
 * The root is always first and is the answer when a caller names nothing.
 * The rest come from facts the console already holds rather than from a
 * filesystem walk: the checkouts git has registered for this repository, and
 * the mirror mounts a run wrote down. That is the allowlist — a directory that
 * is not one of these is not a repository this console has any business
 * reading, and there is no code path that turns a caller's string into a `dir`.
 *
 * Keys are stable and readable (`root`, then the path relative to the root, or
 * the absolute path when it lies outside) so a deep link into the Repo
 * destination survives a restart.
 */
export async function repoTargets(opts: {
  root: string;
  /** Every home a console-made tree may stand in — decides `managed`. */
  managed?: readonly string[];
  /** Root-relative repository paths a mirror run mounted. */
  mounts?: string[];
}): Promise<RepoTarget[]> {
  const first = rootTarget(opts.root);
  const root = first.dir;
  const out: RepoTarget[] = [first];
  const seen = new Set([root]);

  const linked = async (repoDir: string) => {
    for (const entry of await checkouts(repoDir, opts.managed, gitEnv())) {
      const dir = realish(entry.dir);
      if (seen.has(dir) || entry.prunable) continue;
      seen.add(dir);
      out.push({ key: keyFor(root, dir), dir, label: labelFor(root, dir), kind: 'linked' });
    }
  };
  await linked(root);

  // A superproject's submodules, each followed by its own linked checkouts —
  // the trees a phase's worktree or a reviewer's checkout of that repository
  // actually are. Keyed by the root-relative path, which is also the plan's
  // scope token for that repository.
  for (const sub of submoduleDirs(root)) {
    if (!seen.has(sub.dir)) {
      seen.add(sub.dir);
      out.push({ key: sub.rel, dir: sub.dir, label: sub.rel, kind: 'submodule' });
    }
    await linked(sub.dir);
  }

  for (const repo of opts.mounts ?? []) {
    const rel = safePath(repo);
    if (!rel) continue;
    const dir = realish(join(root, rel));
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ key: keyFor(root, dir), dir, label: rel, kind: 'mount' });
  }

  return out;
}

/**
 * The root's own target, without assembling the allowlist.
 *
 * Its own function because it is BOTH the first row of `repoTargets` and the
 * answer to the overwhelmingly common request — a caller that named no
 * repository. Resolving that word through the full list would cost a
 * `worktree list` and a scan of every plan's run records, and the two spellings
 * of the root would then have to agree by luck rather than by construction.
 */
export function rootTarget(root: string): RepoTarget {
  return { key: 'root', dir: realish(root), label: 'repository root', kind: 'root' };
}

function keyFor(root: string, dir: string): string {
  const rel = relative(root, dir);
  return !rel ? 'root' : rel.startsWith('..') ? dir : rel;
}

function labelFor(root: string, dir: string): string {
  const rel = relative(root, dir);
  return !rel || rel.startsWith('..') ? dir : rel;
}

/**
 * Resolve a caller's key against the allowlist, or refuse.
 *
 * The refusal is `null` rather than a fallback to the root on purpose: a
 * client that asked about a checkout and silently got the root back would
 * render one repository's history under another's name.
 */
export function pickTarget(targets: RepoTarget[], key?: string | null): RepoTarget | null {
  if (!key) return targets[0] ?? null;
  return targets.find((target) => target.key === key) ?? null;
}

/* ------------------------------------------------------------------ *
 * Refs — the closed set every other surface validates against
 * ------------------------------------------------------------------ */

export type RepoRef = {
  name: string;
  head: string;
  short: string;
  at?: string;
  subject?: string;
  author?: string;
  upstream?: string;
  /** Is this the branch the target directory is standing on? */
  current: boolean;
};

const REF_FIELDS = [
  '%(refname:short)', '%(objectname)', '%(objectname:short)',
  '%(committerdate:iso-strict)', '%(contents:subject)', '%(authorname)',
  '%(upstream:short)', '%(HEAD)',
];
const REF_FORMAT = REF_FIELDS.join(SEP_REF);

/** `for-each-ref` output → rows. Exported so a fixture can drive the parser. */
export function parseRefs(stdout: string): RepoRef[] {
  const rows: RepoRef[] = [];
  // Records by NEWLINE, fields by NUL — and the asymmetry is git's, not a
  // choice. `for-each-ref` has no `-z`, so it ends every record with a newline;
  // splitting the whole stream on NUL alone would therefore glue each record's
  // last field to the next record's first. Newlines are safe as the record
  // boundary because none of these fields can contain one: a ref name may not,
  // and `%(contents:subject)` is a single line by construction (ref-filter
  // joins a wrapped subject with spaces).
  //
  // The FIELD separator is what had to change: `%(contents:subject)` is
  // repository CONTENT, so `\x1f` — which a subject may legally contain — was
  // not a separator at all. (P8 QA round 4, Medium.)
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [name, head, short, at, subject, author, upstream, mark] = line.split(SEP);
    if (!name || !head) continue;
    rows.push({
      name,
      head,
      short: short || head.slice(0, 12),
      ...(at ? { at } : {}),
      ...(subject ? { subject } : {}),
      ...(author ? { author } : {}),
      ...(upstream ? { upstream } : {}),
      current: mark === '*',
    });
  }
  return rows;
}

/**
 * Local branches, newest commit first — and whether the window cut any off.
 *
 * 🔴 It REPORTS its cap, and that is not decoration. The first cut returned a
 * bare array, so `commitGraph` computed its `tipsTruncated` from an
 * ALREADY-CAPPED list and could only see the second cap, never the first: a
 * repository with 354 branches whose `pe/*` ones happen to be the oldest
 * answered the default walk with `tips: ['main']` and `tipsTruncated: false` —
 * a graph missing exactly the branches the surface exists to show, presented as
 * complete. (P8 QA round 3, Medium.)
 *
 * `namespace` is the other half of that fix: the default walk asks for
 * `refs/heads/pe/` DIRECTLY rather than filtering the general list, so run
 * branches cannot be crowded out of the window by unrelated ones however old
 * they are.
 */
export async function localRefs(dir: string, opts: {
  /** A ref prefix to restrict the query to, e.g. `refs/heads/pe/`. */
  namespace?: string;
  cap?: number;
} = {}): Promise<{ refs: RepoRef[]; truncated: boolean }> {
  const cap = Math.max(1, opts.cap ?? BRANCH_CAP);
  const out = await git(dir, [
    'for-each-ref', '--sort=-committerdate', `--count=${cap + 1}`,
    `--format=${REF_FORMAT}`, opts.namespace ?? 'refs/heads/',
  ]);
  const refs = out.ok ? parseRefs(out.stdout) : [];
  return { refs: refs.slice(0, cap), truncated: refs.length > cap };
}

/**
 * Does this repository have a branch with exactly this name?
 *
 * Asked of git rather than of `localRefs`'s window, because membership is not a
 * question a capped list can answer: a caller naming the 400th-oldest branch
 * would have been refused as if it did not exist. `name` has already been
 * through `safeRev`, whose charset excludes `*`, `?` and `[`, so it cannot
 * become a glob here — and the answer is compared for equality anyway.
 */
export async function branchExists(dir: string, name: string): Promise<boolean> {
  const out = await git(dir, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${name}`]);
  if (!out.ok) return false;
  return out.stdout.split('\n').map((line) => line.trim()).includes(name);
}

/**
 * What this repository calls its trunk.
 *
 * OBSERVED, in the order a person would look: the remote's own default when
 * the repository records one, then the conventional names, then whatever HEAD
 * is standing on. Never assumed to be `main` — `worktree.ts` §`baseBranch`
 * makes the same argument, and a fork whose trunk is `develop` must not have
 * every ahead/behind measured against a branch that does not exist.
 *
 * 🔴 The one-call spelling of the first question is on the never-push gate's
 * mutating list and exempted for `runner/worktree.ts` alone. `for-each-ref`
 * answers it from the console-wide allow-list, which is the correct place for
 * a read to live.
 */
export async function trunkOf(dir: string, refs?: RepoRef[]): Promise<string | undefined> {
  const pointer = await git(dir, [
    'for-each-ref', '--format=%(symref:short)', 'refs/remotes/origin/HEAD',
  ]);
  const remote = pointer.ok ? pointer.stdout.trim().split('\n')[0]?.trim() ?? '' : '';
  const local = (refs ?? (await localRefs(dir)).refs).map((ref) => ref.name);
  // `origin/main` names a REMOTE ref; the trunk we measure against is the
  // local branch of the same name, and only when it exists — a fresh clone
  // that has never checked it out must not have every branch measured against
  // a ref this repository does not have.
  // 🔴 Membership is asked of GIT when the window cannot answer. `local` is
  // `localRefs`'s capped, date-sorted window, so a stale `main` — a trunk
  // nobody has committed to for three hundred branches — fell out of it, this
  // degraded to whatever HEAD happened to be standing on, and the default graph
  // walk lost `main`'s history while reporting itself complete. The FOURTH
  // window of a fix that modelled three. (P8 QA round 4, Medium.)
  const known = new Set(local);
  const has = async (name: string) => known.has(name) || await branchExists(dir, name);
  const bare = remote.startsWith('origin/') ? remote.slice('origin/'.length) : remote;
  if (bare && await has(bare)) return bare;
  for (const name of ['main', 'master', 'trunk']) {
    if (await has(name)) return name;
  }
  const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = head.ok ? head.stdout.trim() : '';
  return name && name !== 'HEAD' ? name : undefined;
}

/* ------------------------------------------------------------------ *
 * Surface 1 — the commit graph
 * ------------------------------------------------------------------ */

export type RepoCommit = {
  /** Full object name, for a deep link that cannot go ambiguous. */
  sha: string;
  /** Abbreviated, for display. */
  short: string;
  /** Full parent object names, in git's order — the first is the mainline. */
  parents: string[];
  /** Decorations, already stripped of the arrow and tag prefixes. */
  refs: string[];
  subject: string;
  author: string;
  /** Author date, ISO 8601 with offset. */
  at: string;
};

export type RepoGraph = {
  commits: RepoCommit[];
  /** The refs the walk started from. */
  tips: string[];
  trunk?: string;
  /**
   * This walk does not cover every branch it should — a graph presented as
   * complete while missing whole branches is worse than a short one.
   *
   * TRUE for any of the three windows biting, not just the obvious one:
   * the tip list cut at `BRANCH_CAP`, the `all` walk's ref query cut, or the
   * default walk's `refs/heads/pe/` query cut. It is NOT only about `all=1`
   * — a repository with more than `BRANCH_CAP` run branches sets it on a
   * default walk too. (P8 QA rounds 1 and 3.)
   */
  tipsTruncated: boolean;
  /** More commits exist past the last one returned. */
  truncated: boolean;
  /** Pass back as `cursor` for the next page; absent when there is none. */
  nextCursor?: string;
};

const GRAPH_FIELDS = ['%H', '%h', '%P', '%D', '%s', '%an', '%aI'];
const GRAPH_FORMAT = GRAPH_FIELDS.join(SEP_LOG);

/**
 * `git log` output → commits.
 *
 * `%D` is the decoration list WITHOUT the surrounding parentheses the
 * `--decorate` flag adds, which is why no such flag is passed: one
 * placeholder, no prose to strip. Its two prefixes still have to go — an
 * arrow-prefixed HEAD and a `tag: ` are one ref each, spelled for a human —
 * and dropping them here rather than in a renderer keeps every consumer
 * agreeing about what a ref is called.
 *
 * Exported so the parser can be driven by a fixture rather than by a
 * repository, which is what makes a two-parent commit testable without
 * constructing one.
 */
export function parseGraph(stdout: string): RepoCommit[] {
  const out: RepoCommit[] = [];
  // `git log -z` terminates each COMMIT with a NUL and the format separates
  // each FIELD with one, so the whole stream is a flat NUL-separated list read
  // in fixed-width groups. Splitting on newlines was the other half of the
  // forgery: a subject cannot contain a newline, but a field AFTER it could
  // still be shifted by a `\x1f` inside it. (P8 QA round 4.)
  const fields = stdout.split(SEP);
  for (let i = 0; i + GRAPH_FIELDS.length <= fields.length; i += GRAPH_FIELDS.length) {
    const [sha, short, parents, decorations, subject, author, at] = fields.slice(i, i + GRAPH_FIELDS.length);
    if (!sha) continue;
    out.push({
      sha,
      short: short || sha.slice(0, 12),
      parents: (parents ?? '').split(' ').map((p) => p.trim()).filter(Boolean),
      // `', '` and never `','`: git joins decorations with a comma AND a space,
      // and a ref name may contain a comma but never a space — so splitting on
      // the comma alone turned the legal branch `feat,with-a-comma` into two
      // refs that do not exist. (P8 QA round 4, Medium.)
      refs: (decorations ?? '').split(', ').map(cleanRef).filter(Boolean),
      subject: subject ?? '',
      author: author ?? '',
      at: at ?? '',
    });
  }
  return out;
}

function cleanRef(raw: string): string {
  const ref = raw.trim();
  if (!ref) return '';
  if (ref.startsWith('tag: ')) return ref.slice('tag: '.length).trim();
  const arrow = ref.indexOf(' -> ');
  return arrow === -1 ? ref : ref.slice(arrow + 4).trim();
}

/**
 * The commit graph over a bounded set of tips.
 *
 * **Which tips, and why not all of them.** The interesting history in a
 * console-driven repository is the trunk plus the run branches — `pe/<slug>`
 * and its lane siblings — and walking every local branch on a repository with
 * a hundred of them costs a hundred tips' worth of traversal to render rows
 * nobody asked for. A caller can name refs explicitly, and a caller can ask
 * for all of them; the default is the pair that makes the destination useful
 * on first paint.
 *
 * **The refs a caller names are checked for MEMBERSHIP, not just shape.** A
 * validated string is still an arbitrary revision, and the tightest available
 * rule for a surface that only ever wants branches is that the name has to be
 * one this repository actually has. `HEAD` is the one exception, and it names
 * no ref at all.
 *
 * Pagination is a skip count, and the cursor is the next one. That is O(skip)
 * in git, which is the correct trade at this scale: a sha-based cursor would
 * have to re-derive the same multi-tip ordering to be stable, and this
 * ordering is git's own.
 */
export async function commitGraph(dir: string, opts: {
  refs?: string[];
  all?: boolean;
  limit?: number;
  cursor?: string;
} = {}): Promise<RepoGraph | null> {
  const known = await localRefs(dir);
  const trunk = await trunkOf(dir, known.refs);

  // De-duplicated BEFORE the cap: `?ref=main` repeated three hundred times
  // would otherwise fill the window with one branch and report a truncation
  // that never happened. (P8 QA round 3, Low.)
  const asked = [...new Set(
    (opts.refs ?? []).map(safeRev).filter((ref): ref is string => Boolean(ref)),
  )];
  // Membership is asked of GIT, not of `known`'s window — a caller naming a
  // branch older than the cap must not be refused as if it did not exist.
  const wanted = (await Promise.all(asked.map(async (ref) => (
    ref === 'HEAD' || await branchExists(dir, ref) ? ref : null
  )))).filter((ref): ref is string => Boolean(ref));

  // A caller who NAMED refs and got none of them is refused, not quietly handed
  // the default graph of a repository it did not ask about. Partial resolution
  // is honoured — two named, one real, walk the real one — because that is the
  // caller getting what it asked for as far as this repository can give it.
  // (P8 QA round 4, Low; the same contract the diff surface already had.)
  if ((opts.refs ?? []).length && !wanted.length) return null;

  // The default walk queries `refs/heads/pe/` on its own, so run branches
  // cannot be crowded out of a general window by unrelated older branches.
  const runRefs = wanted.length || opts.all
    ? { refs: [] as RepoRef[], truncated: false }
    : await localRefs(dir, { namespace: 'refs/heads/pe/' });

  const candidates = wanted.length
    ? wanted
    : opts.all
      ? known.refs.map((ref) => ref.name)
      : [...new Set([...(trunk ? [trunk] : []), ...runRefs.refs.map((ref) => ref.name)])];
  const tips = candidates.slice(0, BRANCH_CAP);
  // BOTH caps, and the ref query's too — the flag means "this walk does not
  // cover every branch it should", whichever window swallowed one.
  // Each term is the window the walk ACTUALLY consulted. A named-ref walk
  // consults neither `known` nor `runRefs`, so neither may make its graph look
  // partial — `?ref=X&all=1` reported `tipsTruncated: true` over one branch it
  // had fully walked. (P8 QA round 4, Low.)
  const tipsTruncated = candidates.length > tips.length
    || (!wanted.length && (opts.all ? known.truncated : runRefs.truncated));

  if (!tips.length) {
    return { commits: [], tips: [], ...(trunk ? { trunk } : {}), tipsTruncated, truncated: false };
  }


  const limit = bounded(opts.limit, GRAPH_LIMIT_DEFAULT, GRAPH_LIMIT_MAX);
  const skip = bounded(opts.cursor, 0, 100_000, 0);

  // One over the limit, so "there is more" is MEASURED rather than inferred
  // from a full page — the same trick `diffText` uses for its byte budget.
  const out = await git(dir, [
    'log', '-z', '--no-color', '--date-order', `--format=${GRAPH_FORMAT}`,
    `--max-count=${limit + 1}`, `--skip=${skip}`, ...tips, '--',
  ]);
  const rows = out.ok ? parseGraph(out.stdout) : [];
  const truncated = rows.length > limit;

  return {
    commits: rows.slice(0, limit),
    tips,
    ...(trunk ? { trunk } : {}),
    tipsTruncated,
    truncated,
    ...(truncated ? { nextCursor: String(skip + limit) } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Surface 2 — branches
 * ------------------------------------------------------------------ */

/** What a `pe/…` branch name says about the run behind it. */
export type RunLink = {
  slug: string;
  /** Present on a lane branch (`pe/<slug>-p<N>`), absent on the run branch. */
  phase?: number;
};

/**
 * Read a console branch name back into the run it belongs to.
 *
 * The spelling is `worktree.ts` §`laneNames`: `pe/<slug>` for the run and
 * `pe/<slug>-p<N>` for a lane, siblings rather than parent and child because
 * `pe/<slug>/p4` is impossible in git while `pe/<slug>` exists. Parsing it
 * back is therefore a matter of the LAST `-p<digits>` and nothing else — a
 * slug may itself contain `-p` (`console-parallel-repaint` does), and a greedy
 * read would report a phase for a plan that merely has one in its name.
 */
export function parseRunBranch(branch: string): RunLink | null {
  if (typeof branch !== 'string' || !branch.startsWith('pe/')) return null;
  const rest = branch.slice('pe/'.length);
  if (!rest) return null;
  const lane = /^(.+)-p(\d+)$/.exec(rest);
  if (lane) return { slug: lane[1], phase: Number(lane[2]) };
  return { slug: rest };
}

export type RepoBranch = RepoRef & {
  /** Ahead/behind the trunk. Absent means not measured, never zero. */
  ahead?: number;
  behind?: number;
  /** True for the trunk itself, which is measured against nothing. */
  trunk: boolean;
  /** The run this branch belongs to, when its name says so. */
  run?: RunLink;
  /** Directories standing on this branch, from the checkout registry. */
  heldBy?: string[];
};

export type RepoBranches = {
  branches: RepoBranch[];
  trunk?: string;
  truncated: boolean;
  /** Some branches past `DIVERGENCE_CAP` carry no ahead/behind. */
  divergenceTruncated: boolean;
};

/**
 * The two counts from a left-right count, or nothing.
 *
 * `rev-list --left-right --count <base>...<branch>` prints `<behind> <ahead>`:
 * the LEFT side is what only the base has. Named here rather than destructured
 * at the call site because the batch reader below prints the SAME pair the
 * other way round, and the two parsers sitting next to each other is what
 * makes that asymmetry visible instead of a one-character bug.
 */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } | undefined {
  const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
  return { ahead, behind };
}

/**
 * `for-each-ref`'s `%(ahead-behind:<trunk>)` output → a map.
 *
 * 🔴 git prints `<ahead> <behind>` here — the OPPOSITE order from
 * `parseAheadBehind` above, which is exactly the sort of asymmetry that
 * produces a page claiming a branch is behind its own trunk by the number of
 * commits it is ahead. Parsed in its own exported function so BOTH orders are
 * pinned by a fixture rather than by whichever git this machine happens to
 * have.
 *
 * An empty map is the capability answer: a git older than 2.41 does not know
 * the placeholder and prints it back verbatim (or nothing), so a caller that
 * gets nothing here must fall back rather than report a repository where every
 * branch is level with its trunk.
 */
export function parseBatchAheadBehind(stdout: string): Map<string, { ahead: number; behind: number }> {
  const map = new Map<string, { ahead: number; behind: number }>();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [name, counts] = line.split(SEP);
    if (!name || !counts) continue;
    const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) continue;
    map.set(name, { ahead, behind });
  }
  return map;
}

/**
 * Ahead/behind for many branches, in ONE process where git can do it.
 *
 * `%(ahead-behind:<committish>)` landed in git 2.41 and answers the whole
 * question in a single traversal. Older gits print the placeholder back
 * verbatim (or empty), which is the capability probe: an unparsable field
 * means fall back to one left-right count per branch, capped, rather than
 * reporting a repository where every branch is level with the trunk.
 *
 * Three dots in the fallback, deliberately — the same argument
 * `worktree.ts` §`changedSince` makes: `trunk...branch` is measured from the
 * merge base, so it is what THIS branch did rather than everything the trunk
 * has moved on to since.
 */
export async function divergences(
  dir: string, trunk: string, names: string[],
): Promise<{ map: Map<string, { ahead: number; behind: number }>; truncated: boolean }> {
  const map = new Map<string, { ahead: number; behind: number }>();
  const wanted = names.filter((name) => name !== trunk);

  const batch = await git(dir, [
    'for-each-ref', `--format=%(refname:short)${SEP_REF}%(ahead-behind:${trunk})`, 'refs/heads/',
  ]);
  if (batch.ok) {
    const parsed = parseBatchAheadBehind(batch.stdout);
    if (parsed.size) {
      for (const [name, counts] of parsed) map.set(name, counts);
      map.delete(trunk);
      return { map, truncated: false };
    }
  }

  const take = wanted.slice(0, DIVERGENCE_CAP);
  const measured = await Promise.all(take.map(async (name) => {
    const out = await git(dir, ['rev-list', '--left-right', '--count', `${trunk}...${name}`]);
    return [name, out.ok ? parseAheadBehind(out.stdout) : undefined] as const;
  }));
  for (const [name, counts] of measured) if (counts) map.set(name, counts);
  return { map, truncated: wanted.length > take.length };
}

/**
 * Every local branch with its divergence, run linkage and holders.
 *
 * The holder list is the checkout registry, fetched here when the caller does
 * not already have it — the ONE place in this module that reaches for it, so
 * the gate-exempt import stays in one import and one call site rather than
 * spreading into the service layer.
 */
export async function branchList(dir: string, opts: {
  /** Directories from the checkout registry, so a branch can say who holds it. */
  held?: CheckoutEntry[];
  /** Passed to the registry read when `held` is not supplied — the managed homes. */
  managed?: readonly string[];
} = {}): Promise<RepoBranches> {
  const { refs: rows, truncated } = await localRefs(dir);
  const trunk = await trunkOf(dir, rows);

  const held = opts.held ?? await checkouts(dir, opts.managed, gitEnv());
  const holders = new Map<string, string[]>();
  for (const entry of held) {
    if (!entry.branch) continue;
    holders.set(entry.branch, [...(holders.get(entry.branch) ?? []), entry.dir]);
  }

  const { map, truncated: divergenceTruncated } = trunk
    ? await divergences(dir, trunk, rows.map((ref) => ref.name))
    : { map: new Map<string, { ahead: number; behind: number }>(), truncated: false };

  const branches: RepoBranch[] = rows.map((ref) => {
    const counts = map.get(ref.name);
    const run = parseRunBranch(ref.name);
    const held = holders.get(ref.name);
    return {
      ...ref,
      ...(counts ?? {}),
      trunk: ref.name === trunk,
      ...(run ? { run } : {}),
      ...(held?.length ? { heldBy: held } : {}),
    };
  });

  return { branches, ...(trunk ? { trunk } : {}), truncated, divergenceTruncated };
}

/* ------------------------------------------------------------------ *
 * Surface 3 — checkouts, joined to their runs
 * ------------------------------------------------------------------ */

/**
 * How a checkout got here.
 *
 * `run` is a run's own isolated tree, `lane` is one phase's, `staging` is the
 * console-wide integration checkout, `operator` is a tree the console did not
 * make, and `debris` is the one worth surfacing: a directory under the
 * console's own state that no surviving run record claims. That last is what a
 * killed console leaves behind, and it is invisible to every existing surface
 * because the cached run view only exists while the run does.
 *
 * 🔴 `staging` is decided by IDENTITY — the paths `stagingNames()` names, one
 * per worktree root — and never by the shape of a path. The first cut tested
 * `/(^|\/)integration$/` and had the two roles exactly INVERTED, because the
 * console's staging checkout is `<stagingHome>/staging` (`worktree.ts`
 * §`stagingNames`) while a RUN's own tree is `<home>/<runId>/integration`
 * (`worktree.ts` §`laneNames`). So the one tree that must never be swept —
 * `pe/integration`, every plan's folded work — reported `debris`, and an
 * orphaned run tree reported `staging`. Found by P8's QA round 1 (High).
 */
export type CheckoutRole = 'root' | 'run' | 'lane' | 'staging' | 'operator' | 'debris';

/**
 * A checkout, attributed.
 *
 * Two of `CheckoutEntry`'s fields are deliberately NOT carried, because this
 * surface never sets either and a type that advertises an always-absent field
 * has Phase 9 rendering `undefined`:
 *
 *  - `disk` is filled by the five-minute `RunGitView` probe with a `du` per
 *    tree. A browse read must not pay that on every request — a checkout of
 *    this repository is tens of thousands of files.
 *  - `CheckoutEntry.repo` is set only by `worktree.ts` §`probeMirrorGit`, which
 *    walks a mirror's N mounted repositories. `checkouts()` — the reader this
 *    surface uses — never sets it, so it is dropped and this surface's OWN
 *    `repo` (the target key, always present) takes its place.
 *
 * (P8 QA round 1, Medium; `repo` was the same mistake, found while fixing it.)
 */
/**
 * How a tree was attributed, and what that buys — a DISCRIMINATED UNION, not
 * three optional fields.
 *
 * The two answers carry genuinely different shapes. A `record` row was matched
 * against a run's own written state, so it knows the run id, its status and
 * whether it is live. A `branch` row was read off the branch NAME alone — an
 * orphan a killed console left, or an operator's hand-made `../repo-pe-<slug>`
 * — and there is no record to read those from. They are exactly the rows a
 * reclaim surface renders, and the first cut typed `runId`/`live` as always
 * present, which would have had Phase 9 render `undefined` on the one screen
 * that matters. A union makes the compiler ask `via` first. (P8 QA round 1.)
 */
export type CheckoutAttribution =
  | { via: 'record'; run: RunLink & { runId: string; status?: string; live: boolean } }
  | { via: 'branch'; run: RunLink }
  | { via?: undefined; run?: undefined };

export type RepoCheckout = Omit<CheckoutEntry, 'disk' | 'repo'> & CheckoutAttribution & {
  /**
   * Which repository the tree belongs to — the target key (`root`, or a
   * submodule's root-relative path). Always present here, unlike
   * `CheckoutEntry.repo`: the registry spans every repository of a
   * superproject, and a path alone does not say which one answered.
   */
  repo: string;
  role: CheckoutRole;
  /** The commit a detached checkout stands at, spelled as the lock spells it. */
  detached?: string;
};

/** What one run record says about the directories it made. */
export type TreeClaim = {
  slug: string;
  runId: string;
  phase?: number;
  status?: string;
  live?: boolean;
};

/**
 * What the run records say about directories, keyed by resolved path.
 *
 * A PURE function over run states so the join is testable without a console,
 * and — the point of the whole surface — so it works for runs that have
 * STOPPED. `service-runs.ts` §`runGit` reads the live runner's cache and
 * answers `null` for a shared run, an unowned run and a refused one alike;
 * every one of those still left directories on disk, and a person looking at
 * the checkout registry needs them attributed.
 */
export function treeClaims(runs: { state: RunState; live?: boolean }[]): Map<string, TreeClaim> {
  const claims = new Map<string, TreeClaim>();
  for (const { state, live } of runs) {
    if (!state?.slug) continue;
    const base: TreeClaim = {
      slug: state.slug, runId: state.id, status: state.status, live: Boolean(live),
    };
    // `realish`, not `resolve`: the registry side of this join is what git
    // PRINTS (symlinks resolved) and this side is what the console CONSTRUCTED.
    // One symlink anywhere above the state directory — `$TMPDIR` on macOS is
    // one — makes the two spellings differ, and the join then attributes
    // nothing at all: every lane of every run reads as unclaimed debris.
    if (state.workRoot) claims.set(realish(state.workRoot), base);
    for (const [key, record] of Object.entries(state.phases ?? {})) {
      const dir = (record as { worktree?: string }).worktree;
      if (!dir) continue;
      const phase = Number(key);
      claims.set(realish(dir), {
        ...base, ...(Number.isFinite(phase) ? { phase } : {}),
      });
    }
  }
  return claims;
}

/**
 * Attribute each registered checkout to whatever claims it.
 *
 * Two sources, in that order and never the other way round: a RUN RECORD names
 * the directory it created, and a BRANCH NAME merely looks like one of ours. A
 * record is evidence; a name is a guess that an operator's own
 * `../repo-pe-<slug>` would satisfy, so `via` says which was used and a
 * surface can show the difference.
 */
export function attributeCheckouts(
  entries: CheckoutEntry[],
  claims: Map<string, TreeClaim>,
  opts: {
    /** `stagingNames(...).dir` per worktree root — the trees `pe/integration` may live in. */
    staging?: readonly string[];
    /** The target key of the repository these entries came from. */
    repo?: string;
  } = {},
): RepoCheckout[] {
  const staging = new Set((opts.staging ?? []).map((dir) => realish(dir)));
  const repo = opts.repo ?? 'root';
  return entries.map((entry) => {
    const dir = realish(entry.dir);
    const claim = claims.get(dir);
    const fromName = entry.branch ? parseRunBranch(entry.branch) : null;

    const role: CheckoutRole = entry.root
      ? 'root'
      : claim
        ? (claim.phase === undefined ? 'run' : 'lane')
        : staging.has(dir)
          ? 'staging'
          : entry.managed
            ? 'debris'
            : 'operator';

    // Built as one of the union's three arms rather than as a bag of optional
    // fields, so a future edit cannot quietly produce a fourth shape.
    const attribution: CheckoutAttribution = claim
      ? {
        via: 'record',
        run: {
          slug: claim.slug,
          ...(claim.phase === undefined ? {} : { phase: claim.phase }),
          runId: claim.runId,
          ...(claim.status ? { status: claim.status } : {}),
          live: Boolean(claim.live),
        },
      }
      : fromName
        ? { via: 'branch', run: fromName }
        : {};

    const { disk: _disk, repo: _repo, ...rest } = entry;
    return { ...rest, repo, role, ...attribution };
  });
}

/**
 * The whole checkout picture for a repository.
 *
 * A detached entry carries the lock's own spelling of where it stands
 * (`detached@<sha12>`, `shared/worktree-model.js`) rather than a bare sha, so
 * the Repo destination and the queue page name the same ground with the same
 * string.
 */
export async function checkoutList(opts: {
  root: string;
  /** Every home a console-made tree may stand in — decides `managed`. */
  managed?: readonly string[];
  /** The staging trees, one per worktree root — decides the `staging` role. */
  staging?: readonly string[];
  runs: { state: RunState; live?: boolean }[];
}): Promise<{ checkouts: RepoCheckout[]; truncated: boolean }> {
  // One registry per REPOSITORY, and a superproject is several: the root's
  // own trees first, then every initialised submodule's, each row saying which
  // repository it belongs to. A hub whose phases edit a submodule keeps that
  // submodule's worktrees exactly where this list used to stop looking.
  const root = realish(opts.root);
  const claims = treeClaims(opts.runs);
  const staging = opts.staging?.length ? { staging: opts.staging } : {};
  const repos: { key: string; dir: string }[] = [
    { key: 'root', dir: root },
    ...submoduleDirs(root).map((sub) => ({ key: sub.rel, dir: sub.dir })),
  ];
  const rows: RepoCheckout[] = [];
  const seen = new Set<string>();
  for (const repo of repos) {
    const entries = await checkouts(repo.dir, opts.managed, gitEnv());
    for (const row of attributeCheckouts(entries, claims, { ...staging, repo: repo.key })) {
      if (seen.has(row.dir)) continue;
      seen.add(row.dir);
      rows.push(row);
    }
  }

  const detached = await Promise.all(rows.map(async (row) => {
    if (row.branch || row.prunable) return row;
    const head = await git(row.dir, ['rev-parse', 'HEAD']);
    const sha = head.ok ? head.stdout.trim() : '';
    return sha ? { ...row, detached: detachedRef(sha) } : row;
  }));

  return { checkouts: detached, truncated: false };
}

/* ------------------------------------------------------------------ *
 * Surface 4 — diffs
 * ------------------------------------------------------------------ */

export type RepoDiff = {
  base?: string;
  tip?: string;
  files: DiffStatRow[];
  filesTruncated: boolean;
  /**
   * The stat itself overflowed its buffer, so `fileCount` is a FLOOR (G-DIFF).
   *
   * Distinct from `filesTruncated`, which says only "the list was cut to the
   * cap". This says the total is unknown, which is what lets a surface write
   * "diff too large to list" rather than a number it cannot stand behind.
   */
  overflow?: boolean;
  /** Present only when a single path was asked for. */
  patch?: DiffOutput & { path: string };
  /** Every file in the range, so the total is honest even when the list is cut. */
  fileCount: number;
};

/**
 * A bounded diff: always the file list, the patch only on request.
 *
 * The split is the honest shape and `git.ts` §`diffStat` already argues half of
 * it — a range too big to render still yields a real file list with real
 * counts, so a surface says "47 files, hunks not shown" instead of nothing. The
 * other half is a browse constraint: sending every hunk of a 40-file range to a
 * browser to render one of them is megabytes for a page that shows one file, so
 * the patch is per-file and asked for by name.
 *
 * Both halves are validated: the range is two independent revs (never one
 * string with `..` in it, which is what `safeRev` refuses), and the path is a
 * repository-relative pathspec passed after `--`. `null` is the refusal, and it
 * is deliberately indistinguishable from "that revision is not here" — a browse
 * surface that told a caller WHICH of its guesses had the right shape would be
 * an oracle for the next guess.
 */
export async function repoDiff(dir: string, opts: {
  base?: string;
  tip?: string;
  path?: string;
  maxBytes?: number;
  unified?: number;
} = {}): Promise<RepoDiff | null> {
  const base = opts.base === undefined ? undefined : safeRev(opts.base);
  const tip = opts.tip === undefined ? undefined : safeRev(opts.tip);
  if ((opts.base !== undefined && !base) || (opts.tip !== undefined && !tip)) return null;

  const path = opts.path === undefined ? undefined : safePath(opts.path);
  if (opts.path !== undefined && !path) return null;

  for (const rev of [base, tip]) {
    if (rev && !await revExists(dir, rev)) return null;
  }

  const range = { ...(base ? { base } : {}), ...(tip ? { tip } : {}) };
  // `env` on both reads: `git.ts`'s own helpers inherit the console's
  // environment, and an inherited `GIT_DIR` makes them answer about a DIFFERENT
  // repository than the one this surface was asked about. The other four
  // surfaces already go through this module's `git()`. (P8 QA round 1, Medium.)
  const all = await diffStatDetailed(dir, range, { env: gitEnv() });
  const files = all.rows.slice(0, DIFF_FILE_CAP);

  const out: RepoDiff = {
    ...(base ? { base } : {}),
    ...(tip ? { tip } : {}),
    files,
    // 🔴 An overflowed stat is ALWAYS truncated, whatever the row count says
    // (G-DIFF). The rows are whatever fitted in the buffer, so `fileCount` is a
    // floor rather than a total — and the old shape reported both as exact,
    // which is how a 26 000-file range rendered as "nothing changed".
    filesTruncated: all.overflow || all.rows.length > DIFF_FILE_CAP,
    ...(all.overflow ? { overflow: true } : {}),
    fileCount: all.rows.length,
  };

  if (path) {
    const text = await diffText(dir, range, {
      paths: [path],
      env: gitEnv(),
      maxBytes: bounded(opts.maxBytes, PATCH_BYTES_DEFAULT, PATCH_BYTES_MAX, 64 * 1024),
      unified: bounded(opts.unified, 3, 20, 0),
    });
    out.patch = { ...text, path };
  }

  return out;
}

/** Does this revision resolve to a commit here? The membership check for a rev. */
async function revExists(dir: string, rev: string): Promise<boolean> {
  return Boolean(await commitOf(dir, rev));
}

/** The commit a validated rev names here, or empty. One read, both callers. */
async function commitOf(dir: string, rev: string): Promise<string> {
  const out = await git(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return out.ok ? out.stdout.trim() : '';
}

/**
 * The commit a ref resolves to in this repository, or `undefined`.
 *
 * The landscape's one rev read (phase 9): where the staging branch stands.
 * Validated like every rev this module takes — a leading `-` or a range is
 * refused before git is asked — and `undefined` for a ref that is not here,
 * never a guess: a staging branch nobody has made yet is a fact the map
 * shows as such.
 */
export async function refHead(dir: string, ref: string): Promise<string | undefined> {
  const rev = safeRev(ref);
  if (!rev) return undefined;
  return (await commitOf(dir, rev)) || undefined;
}

/* ------------------------------------------------------------------ *
 * Surface 5 — settle history
 * ------------------------------------------------------------------ */

export type SettleKind =
  /** The run's branch had its fate decided. */
  | 'settled'
  /** A settle was asked for and is waiting on something. */
  | 'pending'
  /** The strategy could not be taken — a mirror run's one-tree settle. */
  | 'unsupported'
  /** A lane's commits reached the run branch — or a phase's landing policy took it. */
  | 'landed'
  /** The console pushed a phase's branch — the one publication it makes (5.1, `pushRef`). */
  | 'pushed'
  /** A lane's commits did NOT reach it; the integration was abandoned. */
  | 'failed'
  /** A checkout was given back — released, reclaimed or swept. */
  | 'released'
  /** A branch already contained by the trunk was deleted. */
  | 'pruned';

export type SettleEvent = {
  slug: string;
  runId: string;
  at: string;
  kind: SettleKind;
  /** The run branch, when the run had one of its own. */
  branch?: string;
  strategy?: SettleStrategy;
  phase?: number;
  detail?: string;
  /** Which of the two sources this row came from. */
  via: 'record' | 'journal';
};

/**
 * Journal events that are part of the settle story, and what each one means.
 *
 * An OBJECT, not an array, and that is not a style choice: the never-push gate
 * scans array literals for git verbs, and a list of event names here is one
 * innocent addition away from turning that gate red from a file that runs no
 * git. A map also carries the meaning beside the name, which a list would have
 * needed a second structure for.
 */
const SETTLE_EVENTS: Readonly<Record<string, SettleKind>> = Object.freeze({
  'run.settled': 'settled',
  'run.settle-pending': 'pending',
  'run.settle-unsupported': 'unsupported',
  'phase.worktree-landing': 'landed',
  'phase.worktree-landed': 'landed',
  'phase.worktree-failed': 'failed',
  'run.worktree-released': 'released',
  'run.isolation-reclaimed': 'released',
  'run.worktrees-swept': 'released',
  'run.branches-pruned': 'pruned',
  // 🔴 The settle's own ending was missing from the settle history (S10). A
  // `pr` settle spends a session and journals `phase.pr-session-done` with
  // whether it ended well — the one line saying whether the branch was actually
  // published — and the history that exists to answer "what happened to this
  // branch" did not read it.
  'phase.pr-session-done': 'settled',
  'run.errand': 'pending',
});

/** The journal event names this history is assembled from. */
export const SETTLE_EVENT_NAMES: readonly string[] = Object.freeze(Object.keys(SETTLE_EVENTS));

/**
 * Where each run's work ended up, newest first.
 *
 * TWO sources, because each one knows something the other does not. The run
 * RECORD carries `settledAt` and the strategy, and survives for as long as the
 * record does — it is the fact that answers "was this branch merged away, or
 * never created" long after the journal has been trimmed. The JOURNAL carries
 * the per-lane detail (which phase landed, what an integration said when it
 * refused) that the record folds away.
 *
 * A pure function over both, so the join is testable without a repository and
 * without a console: the caller does the reading, this decides what it means.
 * A record-derived row and a journal-derived row for the same moment are NOT
 * de-duplicated — they are different evidence, they carry different detail, and
 * `via` says which is which so a surface can prefer one without this function
 * having to guess which.
 */
export function settleHistory(
  inputs: { state: RunState; entries?: JournalEntry[] }[],
  opts: { limit?: number } = {},
): { events: SettleEvent[]; truncated: boolean } {
  const rows: SettleEvent[] = [];

  for (const { state, entries } of inputs) {
    if (!state?.slug) continue;
    const branch = runBranchOf(state);
    const common = {
      slug: state.slug,
      runId: state.id,
      ...(branch ? { branch } : {}),
      ...(state.settle ? { strategy: state.settle } : {}),
    };

    if (state.settledAt) {
      rows.push({ ...common, at: state.settledAt, kind: 'settled', via: 'record' });
    }

    for (const entry of entries ?? []) {
      const kind = SETTLE_EVENTS[entry.event];
      if (!kind) continue;
      const detail = detailOf(entry);
      rows.push({
        ...common,
        at: entry.time,
        kind,
        ...(typeof entry.phase === 'number' ? { phase: entry.phase } : {}),
        ...(detail ? { detail } : {}),
        via: 'journal',
      });
    }
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const limit = bounded(opts.limit, SETTLE_CAP, SETTLE_CAP);
  return { events: rows.slice(0, limit), truncated: rows.length > limit };
}

/**
 * The branch a run works on, spelled the way the lock spells it.
 *
 * `RunnerBase.branchFor`'s rule, minus the lane it does not have here: a
 * detached run owns no ref and is named by where it stands, a `new-branch` run
 * is `pe/<slug>`, and a default-branch run has no branch of its own to name.
 * Duplicated deliberately — the runner's copy is about a LIVE lane and reaches
 * into `this.lanes`; this one has to answer for a run that stopped weeks ago.
 */
function runBranchOf(state: RunState): string | undefined {
  if (state.detachAt) return detachedRef(state.detachAt);
  return state.gitMode === 'new-branch' ? `pe/${state.slug}` : undefined;
}

/** The one human-readable field a settle event carries, capped. */
function detailOf(entry: JournalEntry): string | undefined {
  const data = entry.data ?? {};
  for (const key of ['detail', 'reason', 'error', 'strategy', 'branch']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 400);
  }
  return undefined;
}

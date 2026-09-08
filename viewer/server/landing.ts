/**
 * The landing packet — how a finished plan leaves this machine.
 *
 * The console never pushes. That is not a missing feature; it is the invariant
 * the whole write surface is built on (`engine.ts` and `writes.ts` refuse
 * `--git`, `viewer/test/never-push.test.ts` pins that nothing here can run a
 * remote-talking git verb, and `--allow-writes` deliberately buys scaffolding
 * and recording, not publishing). An autopilot that could push would be one
 * misparsed board away from putting unreviewed work on a branch other people
 * build on, and in this repository a push to `main` is a plugin release.
 *
 * So the handover is a FILE. A plan that is finished gets its work written out
 * in the two forms git itself can read back:
 *
 *   - a **bundle** — the exact history, one file, fetchable with `git fetch`;
 *   - a **patch series** — the same commits as `git am` input, readable and
 *     editable one at a time.
 *
 * Both are produced by git verbs that write to disk and touch no ref, no
 * index, and no remote (`git.ts` §Landing plumbing). Where the work goes is
 * then a person's decision, made with the packet in hand.
 *
 * ## On disk
 *
 *     runs/<instance>/<slug>/landing/
 *       landing.json                 the manifest — the contract below
 *       <slug>.bundle                git bundle of base..<branch|HEAD>
 *       patches/0001-….patch …       git format-patch of the same range
 *
 * Beside the run's own state, like `review/` — it is this console's artefact
 * about this checkout, not a document about the plan, so it does not belong in
 * `docs/` where it would land in somebody's commit.
 *
 * `landing.json` is the contract. **Phase 22's merge-back reads it**: `window`
 * says what range a worktree's branch must carry, `repo.branch` and
 * `bundle.ref` say what to fetch it as, `bundle.prerequisites` says what the
 * receiving repository must already have, and `files` is the complete,
 * authoritative list of what exists in the directory — the download route
 * serves a name only if it appears there, so the manifest is the path
 * whitelist rather than a description of one.
 */

import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  branchState, bundleCreate, bundleVerify, commitsInRange, commitsTouching, firstParent, formatPatch, revExists,
} from './git.ts';
import type { BranchState } from './git.ts';

export const LANDING_SCHEMA_VERSION = 1;

/** How the range being landed was arrived at. */
export type LandingWindowKind = 'plan-window' | 'explicit' | 'none';

export type LandingWindow = {
  kind: LandingWindowKind;
  /** Absent means "from the start of history" — a plan whose first commit is the repo's. */
  base?: string;
  tip?: string;
  note: string;
};

export type LandingArtifact = {
  /** Path relative to the landing directory, forward slashes. The download key. */
  name: string;
  kind: 'manifest' | 'bundle' | 'patch';
  bytes: number;
};

export type LandingCommit = { sha: string; subject?: string; date?: string; author?: string };

export type LandingPacket = {
  version: number;
  slug: string;
  /** When this packet was composed — not when the work happened. */
  at: string;
  repo: BranchState;
  window: LandingWindow;
  commits: LandingCommit[];
  /** The range's real length; `commits` is capped for display. */
  commitCount: number;
  commitsTruncated: boolean;
  bundle?: { name: string; bytes: number; ref: string; prerequisites: string[] };
  patches: { dir: string; files: string[] };
  /** Everything downloadable, manifest included. The route's whitelist. */
  files: LandingArtifact[];
  /** Copy-pasteable, in order — what a person runs to land this. */
  apply: string[];
  /** What the packet does NOT carry, said out loud. */
  notes: string[];
};

export const MANIFEST = 'landing.json';
export const PATCH_DIR = 'patches';
/** More than this and the display list is cut; `commitCount` still tells the truth. */
export const MAX_LISTED_COMMITS = 200;

/* ------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------ */

export type PlanWindowInput = {
  root: string;
  /** Absolute path to `docs/plans/<slug>.md`. */
  planPath?: string;
  /** Absolute path to `docs/handoffs/<slug>`. */
  handoffDir?: string;
  base?: string;
  tip?: string;
};

/**
 * Where a whole PLAN's work sits in history.
 *
 * Not the review window. A review brackets ONE phase between two handoff
 * landings; a landing brackets the plan — from just before it first touched
 * this repository to whatever is committed now.
 *
 * The base is the parent of the plan's OLDEST commit, found by asking git for
 * one log over the plan file and the handoff directory together. Both, because
 * either can be first: a plan authored in its own session lands `docs/plans/`
 * before any handoff exists, while a plan scaffolded and executed in one
 * sitting can land both in the same commit.
 *
 * The tip is HEAD, not the newest handoff commit. A landing is "give me what is
 * on this branch", and a phase that committed after writing its handoff — or
 * an operator who fixed a typo afterwards — has work that the review window
 * legitimately excludes and a landing must not.
 */
export async function planWindow(input: PlanWindowInput): Promise<LandingWindow> {
  const { root } = input;

  if (input.base || input.tip) {
    const base = input.base && await revExists(root, input.base) ? input.base : undefined;
    const tip = input.tip && await revExists(root, input.tip) ? input.tip : undefined;
    if (base || tip) {
      return {
        kind: 'explicit',
        ...(base ? { base } : {}),
        ...(tip ? { tip } : {}),
        note: `The range you asked for: ${base ?? 'the start of history'}..${tip ?? 'HEAD'}.`,
      };
    }
  }

  const paths = [input.planPath, input.handoffDir].filter((p): p is string => Boolean(p));
  const spine = paths.length ? await commitsTouching(root, paths, 1_000) : [];
  if (!spine.length) {
    return {
      kind: 'none',
      note: 'Neither the plan file nor its handoffs have been committed in this repository, '
        + 'so there is no range to cut a landing from. Commit the plan first.',
    };
  }

  const oldest = spine[spine.length - 1].sha;
  const base = await firstParent(root, oldest);
  return {
    kind: 'plan-window',
    ...(base ? { base } : {}),
    tip: 'HEAD',
    note: base
      ? `From ${base} — the commit before this plan first touched the repository (${oldest}) — `
        + 'to HEAD. Everything committed on this branch since the plan started, which is more than '
        + 'the plan strictly authored if other work landed on the same branch.'
      : `This plan's first commit (${oldest}) is the first commit in the repository, so the range `
        + 'starts from an empty tree.',
  };
}

/* ------------------------------------------------------------------ *
 * Composing
 * ------------------------------------------------------------------ */

export type ComposeInput = PlanWindowInput & { slug: string; dir: string };

export type ComposeOutcome =
  | { ok: true; packet: LandingPacket; detail: string }
  | { ok: false; packet: null; detail: string };

/**
 * Write the packet, replacing whatever was there.
 *
 * Replacing, not adding: a second compose after two more phases must not leave
 * the first compose's patch files beside the new ones, where the manifest would
 * not list them but a directory listing would — and `0001-` from the old series
 * is a different commit from `0001-` in the new one. The directory is emptied
 * of the artefacts this function owns before any of them is written.
 */
export async function composeLanding(input: ComposeInput): Promise<ComposeOutcome> {
  const { root, slug, dir } = input;

  const repo = await branchState(root);
  if (!repo.available) {
    return { ok: false, packet: null, detail: 'That source directory is not a git repository, so there is nothing to bundle.' };
  }

  const window = await planWindow(input);
  if (window.kind === 'none') return { ok: false, packet: null, detail: window.note };

  // The ref decides what the bundle is fetchable AS. A branch name gives the
  // receiver `refs/heads/<branch>` and a one-command landing; a detached HEAD
  // can only offer `HEAD`, which still fetches but has to be named on arrival.
  const ref = repo.branch ?? 'HEAD';
  const commits = await commitsInRange(root, window.base, ref === 'HEAD' ? 'HEAD' : ref, MAX_LISTED_COMMITS + 1);
  if (!commits.length) {
    return {
      ok: false,
      packet: null,
      detail: `There are no commits in ${window.base ?? 'the start of history'}..${ref}, so there is nothing to land. `
        + 'git refuses to write an empty bundle, and a packet advertising a file that does not exist would be worse.',
    };
  }

  resetDir(dir);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    // Reachable: a file where the directory should be, a read-only state dir,
    // a full disk. Uncaught it rejected the promise and the route answered 500
    // — an error page for a condition the card could have simply reported.
    return { ok: false, packet: null, detail: `The packet directory could not be created: ${(error as Error).message}` };
  }

  const bundleName = `${safeStem(slug)}.bundle`;
  const bundleFile = join(dir, bundleName);
  const made = await bundleCreate(root, bundleFile, { ...(window.base ? { base: window.base } : {}), ref });
  if (!made.ok || !existsSync(bundleFile)) {
    return { ok: false, packet: null, detail: `git could not write the bundle: ${made.error ?? 'no file was produced'}` };
  }
  const verified = await bundleVerify(root, bundleFile);

  const patchDir = join(dir, PATCH_DIR);
  const patched = await formatPatch(root, patchDir, { ...(window.base ? { base: window.base } : {}), ref });
  // A patch series that failed is a NOTE, not a failure: the bundle is the
  // authoritative artefact and it is already written. Losing the whole packet
  // because the readable copy could not be produced would be the wrong trade.
  const patchFiles = patched.ok
    ? patched.files.map((f) => basename(f)).sort()
    : [];

  const files: LandingArtifact[] = [
    { name: MANIFEST, kind: 'manifest', bytes: 0 },
    { name: bundleName, kind: 'bundle', bytes: sizeOf(bundleFile) },
    ...patchFiles.map((f) => ({ name: `${PATCH_DIR}/${f}`, kind: 'patch' as const, bytes: sizeOf(join(patchDir, f)) })),
  ];

  const listed = commits.slice(0, MAX_LISTED_COMMITS);
  const packet: LandingPacket = {
    version: LANDING_SCHEMA_VERSION,
    slug,
    at: new Date().toISOString(),
    repo,
    window,
    commits: listed,
    commitCount: commits.length,
    commitsTruncated: commits.length > MAX_LISTED_COMMITS,
    bundle: {
      name: bundleName,
      bytes: sizeOf(bundleFile),
      ref,
      prerequisites: verified.prerequisites,
    },
    patches: { dir: PATCH_DIR, files: patchFiles },
    files,
    apply: applySteps({ slug, ref, bundleName, branch: repo.branch, prerequisites: verified.prerequisites, patches: patchFiles.length }),
    notes: composeNotes({ repo, patched: patched.ok, patchError: patched.error, verified: verified.ok, truncated: commits.length > MAX_LISTED_COMMITS }),
  };

  const manifestFile = join(dir, MANIFEST);
  writeAtomic(manifestFile, `${JSON.stringify(packet, null, 2)}\n`);
  // The manifest's own size is known only after it is written, and a size of 0
  // in a list whose whole job is to be the download whitelist reads as a broken
  // file. Stamp it, then rewrite once — the second write is the one that lands.
  packet.files[0].bytes = sizeOf(manifestFile);
  writeAtomic(manifestFile, `${JSON.stringify(packet, null, 2)}\n`);

  return {
    ok: true,
    packet,
    detail: `Landing packet for ${slug}: ${commits.length} commit${commits.length === 1 ? '' : 's'}, `
      + `a ${Math.max(1, Math.round(sizeOf(bundleFile) / 1024))} KB bundle and ${patchFiles.length} patch`
      + `${patchFiles.length === 1 ? '' : 'es'}.`,
  };
}

/** What a person runs, in order. */
function applySteps(input: {
  slug: string; ref: string; bundleName: string; branch?: string; prerequisites: string[]; patches: number;
}): string[] {
  const target = input.branch ? `${input.branch}:${input.branch}` : 'HEAD';
  const steps = [
    `git bundle verify <packet>/${input.bundleName}`,
    `git fetch <packet>/${input.bundleName} ${target}`,
  ];
  if (input.branch) steps.push(`git switch ${input.branch}`);
  else steps.push('git switch -c <a-name-you-choose> FETCH_HEAD');
  if (input.patches) {
    steps.push(`# or, to read and apply them one at a time: git am <packet>/${PATCH_DIR}/*.patch`);
  }
  steps.push('# then push it yourself, when you have decided it should go.');
  return steps;
}

/** The caveats. Anything the packet does not carry is said here, not omitted. */
function composeNotes(input: {
  repo: BranchState; patched: boolean; patchError?: string; verified: boolean; truncated: boolean;
}): string[] {
  const notes: string[] = [];
  if (input.repo.dirty.length) {
    notes.push(
      `${input.repo.dirty.length}${input.repo.dirtyTruncated ? '+' : ''} uncommitted `
      + `path${input.repo.dirty.length === 1 ? '' : 's'} in the working tree are NOT in this packet — `
      + 'a bundle carries commits. Commit them and compose again if they belong to the landing.',
    );
  }
  if (!input.repo.branch) {
    notes.push('HEAD is detached, so the bundle carries no branch name — the receiver names it on arrival.');
  } else if (!input.repo.upstream) {
    notes.push(`${input.repo.branch} has no upstream. That is the expected state here: this console never pushes, `
      + 'and the packet is how the work leaves the machine.');
  } else if (input.repo.ahead) {
    notes.push(`${input.repo.branch} is ${input.repo.ahead} commit${input.repo.ahead === 1 ? '' : 's'} ahead of `
      + `${input.repo.upstream}${input.repo.behind ? ` and ${input.repo.behind} behind` : ''}.`);
  }
  if (!input.patched) {
    notes.push(`The patch series could not be written (${input.patchError ?? 'git declined'}), so the bundle is `
      + 'the only artefact. It is the complete one.');
  }
  if (!input.verified) {
    notes.push('git bundle verify did not pass on the file just written — treat the packet as suspect and compose again.');
  }
  if (input.truncated) {
    notes.push(`Only the newest ${MAX_LISTED_COMMITS} commits are listed; the bundle carries the whole range.`);
  }
  return notes;
}

/* ------------------------------------------------------------------ *
 * Reading it back
 * ------------------------------------------------------------------ */

/**
 * The packet on disk, or nothing.
 *
 * A manifest from a FUTURE version is not readable here, and half-reading one
 * is how a forward-compatible format becomes a corrupt one — the same rule
 * `ReviewStore.get` follows. Absent is the safe answer: the console offers to
 * compose a fresh packet instead of serving files it cannot describe.
 */
export function readLanding(dir: string): LandingPacket | undefined {
  const file = join(dir, MANIFEST);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LandingPacket;
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (!Array.isArray(parsed.files)) return undefined;
    if (parsed.version > LANDING_SCHEMA_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * The absolute path for a requested artefact name, or null.
 *
 * The manifest's `files` list is the whitelist — not a sanitiser over the
 * requested name. A name is served because the packet SAYS it exists, so
 * `../../.ssh/id_ed25519`, an absolute path, a symlink planted in the
 * directory and a URL-encoded traversal all fail the same way: they are not in
 * the list. `existsSync` then keeps a manifest that outlived its files from
 * offering a 200 on nothing.
 */
export function landingFile(dir: string, name: string): string | null {
  const packet = readLanding(dir);
  if (!packet) return null;
  const known = packet.files.some((f) => f.name === name);
  if (!known) return null;
  const abs = join(dir, name);
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}

/* ------------------------------------------------------------------ *
 * Small mechanics
 * ------------------------------------------------------------------ */

/**
 * Empty the landing directory of the artefacts this module owns.
 *
 * Scoped to those three shapes rather than `rm -rf` on the directory: the path
 * is composed from an instance id and a slug, and a bug in either would make an
 * unconditional recursive delete the most destructive line in the console.
 */
function resetDir(dir: string): void {
  if (!existsSync(dir)) return;
  try { rmSync(join(dir, PATCH_DIR), { recursive: true, force: true }); } catch { /* nothing to remove */ }
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === MANIFEST || name.endsWith('.bundle')) {
      try { rmSync(join(dir, name), { force: true }); } catch { /* nothing to remove */ }
    }
  }
}

/** A slug as a filename: this names a file the operator downloads. */
function safeStem(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'landing';
}

function sizeOf(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

/**
 * Temp file then rename, so a console killed mid-write leaves no half-manifest.
 *
 * A truncated `landing.json` would not merely fail to parse — `readLanding`
 * drops it, which means the download route stops serving a bundle that is
 * sitting right there, because the whitelist it consults no longer exists.
 */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

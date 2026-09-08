/**
 * The read-only invariant for `gh`, as a test rather than a promise.
 *
 * `never-push.test.ts` exists because the console reads a repository and must
 * never publish from it. This is the same rule for the same reason against a
 * different binary: `gh` can close an issue, post a comment, open a pull
 * request and merge one, and this console has a browser-reachable surface that
 * runs it. So the vocabulary is an ALLOW-list of two verbs — `issue list` and
 * `issue view` — asserted syntactically over ALL of `server/`, exactly the way
 * the git gate is.
 *
 * The method is deliberately the same one, and the scanner is SHARED
 * (`test/argv-scan.ts`) rather than copied: every array literal containing a
 * string literal is an argv in this codebase, a second implementation of "what
 * is an argv" would be a second thing to keep correct, and the holes that
 * scanner had (a variable among the arguments, a double-quoted literal) were
 * found once and must not be re-found here. It is imported from a plain module
 * and not from `never-push.test.ts`, which re-registered that file's eleven
 * tests inside this one (QA round 1, Low).
 *
 * ## It scans ALL of `server/`, and it finds `gh` by the SPAWN
 *
 * Scoping it to the new directory would have made it a gate on one folder and
 * an invitation everywhere else — `gh pr merge` in a route file would have
 * sailed past (QA round 1, Low). So the rule is console-wide.
 *
 * Which meant answering "is this array a `gh` argv?" over sixty files, and the
 * obvious answer — a set of known `gh` subcommand words — is wrong in this
 * codebase: `['auth', 'status']` is `claude auth status`, `['release',
 * '--owner']` is `phase-lock.sh`, `['run', 'exec', 'dlx']` is a package-manager
 * vocabulary. Ten false positives, none of them GitHub.
 *
 * So the gate keys on the thing that actually matters: a file that SPAWNS the
 * literal `'gh'`. That set is asserted to be exactly `GH_CALLERS` — so a new
 * file talking to GitHub is a visible edit to this file — and only those files'
 * argv are checked against the verb allow-list. It is both stricter (no guess)
 * and quieter (no false positive).
 *
 * What it does NOT claim:
 *   - that `gh` is authenticated, installed, or reachable. Those are runtime
 *     facts and `fetch.ts` answers all three with `unknown`.
 *   - that a session the console spawns will not run `gh`. A session does what
 *     its phase says under its own account and the permission layer governs it;
 *     what this forbids is the SERVER writing to GitHub by itself.
 */

import './state-sandbox.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { argvLiterals } from './argv-scan.ts';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'server');
const ISSUES_DIR = join(SERVER_DIR, 'issues');

/**
 * `gh` subcommands that WRITE. Not exhaustive — it does not have to be, because
 * the gate below is an allow-list — but these are the ones a well-meaning
 * "while we are here" edit reaches for, and naming them makes the failure
 * message say what was wrong rather than only that something was.
 */
const WRITE_VERBS = [
  'create', 'edit', 'close', 'reopen', 'comment', 'delete', 'transfer', 'pin', 'unpin',
  'lock', 'unlock', 'merge', 'ready', 'review', 'checkout', 'develop', 'api',
];

/** The only two things this console may ask `gh` to do. */
const ALLOWED_GH = [
  ['issue', 'list'],
  ['issue', 'view'],
  // `watch-refs.ts`, since before this module existed: has that run finished,
  // has that pull request left OPEN. Reads, both of them.
  ['run', 'view'],
  ['pr', 'view'],
];

/**
 * A spawn of the literal `gh` — `execFile('gh', …)` and every sibling.
 *
 * The leading boundary excludes a METHOD call, so `RE.exec('gh')` is not a
 * process. Comments are stripped before this runs, so prose naming `gh` (there
 * is a lot of it) is not a caller.
 */
/*
 * 🔴 All three quote styles, like the argv scanner itself. Keyed on `'gh'`
 * alone, a file writing `execFile("gh", ['issue', 'close', n])` passed every
 * assertion in this file (QA round 2) — and `server/` is under neither eslint
 * nor prettier, so nothing else would have reformatted it into view. The single
 * quote is this repository's convention, which is exactly why the double one is
 * the shape a hurried edit arrives in.
 */
const SPAWNS_GH =
  /(?:^|[^.\w$])(?:execFile|execFileSync|exec|execSync|spawn|spawnSync)\s*\(\s*(['"`])gh\1/;

/**
 * `gh`'s own subcommand heads — the SECOND of the two filters.
 *
 * Neither is sufficient alone and both are needed. Head-alone matches
 * `['auth', 'status']` (that is `claude`) in files that never touch GitHub;
 * file-alone matches `watch-refs.ts`'s own vocabularies (`['gh-run', 'gh-pr',
 * 'date', 'lock', 'cmd']` is the scheme list, not an argv). Together they name
 * exactly the arrays that are handed to `gh`.
 */
const GH_HEADS = new Set([
  'issue', 'pr', 'repo', 'run', 'workflow', 'release', 'gist', 'auth', 'api',
  'label', 'project', 'secret', 'variable', 'ssh-key', 'gpg-key', 'codespace',
]);

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.endsWith('-out')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(path, out);
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * The one file allowed to run `gh` outside `server/issues/`, and the verb it
 * may use.
 *
 * `watch-refs.ts` asks about a workflow run and a pull request on behalf of a
 * session's `--watch` ref. Both are `view` — a read — so it belongs on the
 * allow-list rather than in an exemption of its own; it is named here so that
 * a reviewer can see the whole set of files that reach GitHub in one place,
 * and so the positive assertion below can prove the list describes real code.
 */
const GH_CALLERS = ['issues/fetch.ts', 'watch-refs.ts'];

/**
 * A source file with its comments removed.
 *
 * Prose is exempt for exactly the reason `never-push.test.ts` exempts it: the
 * header of `index.ts` explains that `gh` holds its own CREDENTIALS and names
 * `gh issue list`, and a gate that reads its own documentation as a violation
 * teaches people to stop writing the documentation.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const FILES = tsFiles(SERVER_DIR);
const ISSUES_FILES = tsFiles(ISSUES_DIR);
/** Every server file that actually spawns `gh`, root-relative. */
const GH_FILES = FILES.filter((file) => SPAWNS_GH.test(code(file)))
  .map((file) => relative(SERVER_DIR, file));
/** Argv literals in those files alone — see the header on why not all of them. */
const GH_ARGVS = FILES
  .filter((file) => GH_FILES.includes(relative(SERVER_DIR, file)))
  .flatMap((file) => argvLiterals(code(file), relative(SERVER_DIR, file)))
  .filter((argv) => GH_HEADS.has(argv.args[0]));

test('the scanner is looking at the real server, not at nothing', () => {
  // A gate whose input silently became empty passes for ever — the same floor
  // `never-push.test.ts` keeps, and for the same reason.
  assert.ok(FILES.length > 30, `only ${FILES.length} server files found`);
  assert.ok(ISSUES_FILES.length >= 3, `only ${ISSUES_FILES.length} files found under server/issues`);
  assert.ok(GH_FILES.length >= 2, `only ${GH_FILES.length} files spawn gh — is the detector still right?`);
  assert.ok(GH_ARGVS.length >= 4, `only ${GH_ARGVS.length} gh argv literals found — is the scan reaching them?`);
});

test('every gh argument list in viewer/server is one of the READ verbs', () => {
  const offences = GH_ARGVS
    .filter((argv) => !ALLOWED_GH.some(([head, verb]) => argv.args[0] === head && argv.args[1] === verb))
    .map((argv) => `${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`);

  assert.deepEqual(offences, [],
    `gh may only be asked to ${ALLOWED_GH.map((a) => a.join(' ')).join(' or ')}; widening that is an edit to this file`);

  // The positive half, for the same reason the git gate asserts its verbs are
  // in use: an allow-list nothing exercises is a hole waiting for a first user.
  const used = new Set(GH_ARGVS.map((argv) => `${argv.args[0]} ${argv.args[1]}`));
  for (const [head, verb] of ALLOWED_GH) {
    assert.ok(used.has(`${head} ${verb}`),
      `${head} ${verb} is allowed but unused — take it off the list rather than leaving it open`);
  }

  // …and the set of FILES that reach GitHub is the one named above. A new one
  // is a decision, taken here, where somebody reviewing this file can see it.
  assert.deepEqual([...GH_FILES].sort(), [...GH_CALLERS].sort(),
    'a server file outside the named set spawns gh — name it here, deliberately');
});

test('no writing gh subcommand appears in any file that spawns gh', () => {
  // Belt to the allow-list's braces. It catches a write reached by a shape the
  // head check cannot see — `['issue', verb]` with `verb` computed, say, whose
  // literal `'close'` would still be sitting in some array nearby.
  const banned = new Set(WRITE_VERBS);
  const offences = GH_ARGVS
    .filter((argv) => argv.args.some((a) => banned.has(a)))
    .map((argv) => `${argv.file}:${argv.line} ${JSON.stringify(argv.args)}`);

  assert.deepEqual(offences, [], 'a writing gh subcommand reached an argument list');
});

test('nothing in server/issues runs anything but gh', () => {
  // `execFile` is the only spawn here and its first argument must be the
  // literal `gh`. A computed binary would make every assertion above decorative.
  //
  // The leading boundary excludes a METHOD call: `ISSUE_REF_RE.exec(ref)` is a
  // regex match, not a process, and reading it as one made this gate fail on
  // its own module the first time it ran.
  const spawns: string[] = [];
  for (const file of ISSUES_FILES) {
    for (const match of code(file)
      .matchAll(/(^|[^.\w$])(execFile|execFileSync|exec|execSync|spawn|spawnSync)\s*\(\s*([^,)]*)/g)) {
      spawns.push(`${relative(SERVER_DIR, file)}: ${match[2]}(${match[3].trim()}`);
    }
  }
  assert.ok(spawns.length >= 1, 'the scan found no spawn at all — is it still reading the right files?');
  for (const spawn of spawns) {
    assert.match(spawn, /\('gh'$/, `${spawn} — only the literal 'gh' may be spawned here`);
  }
});

test('no token is read in server/issues — gh holds its own credentials', () => {
  // The module forwards `GH_TOKEN`/`GITHUB_TOKEN` from the environment into the
  // child when the operator has set them, which is `gh`'s own documented way of
  // being authenticated. What it must never do is LOAD one: no keychain, no
  // `accounts/credentials` import, no hand-built `Authorization` header — which
  // would mean this console holding a GitHub secret it has no reason to have.
  //
  // The predicate is credential MACHINERY, not the English word: `reasonFor`
  // reads `gh`'s own stderr for "Bad credentials" to tell a signed-out console
  // from a rate-limited one, and a gate that forbade the word would forbid the
  // honest failure message.
  for (const file of ISSUES_FILES) {
    const source = code(file);
    assert.doesNotMatch(source, /keytar|keychain|Authorization|Bearer |find-generic-password/i,
      `${relative(SERVER_DIR, file)} builds an authenticated request itself; gh authenticates itself`);
    assert.doesNotMatch(source, /\bfrom\s+'[^']*credentials/i,
      `${relative(SERVER_DIR, file)} imports the credentials module; nothing here may hold a secret`);
  }
});

test('the scanner can FAIL — the same rules against sources that break them', () => {
  const close = argvLiterals("await run(['issue', 'close', String(n), '--repo', repo]);");
  assert.equal(close.length, 1);
  assert.equal(close[0].args[1], 'close', 'a write verb must be visible to the allow-list');
  assert.ok(WRITE_VERBS.includes(close[0].args[1]), 'and to the ban list');

  // The shape that made the git scanner's first version useless: one variable
  // among the arguments. It must still be seen.
  const computed = argvLiterals("run(['pr', 'merge', number, '--squash']);");
  assert.equal(computed[0].args[0], 'pr');
  assert.ok(!ALLOWED_GH.some(([h, v]) => h === computed[0].args[0] && v === computed[0].args[1]),
    'gh pr merge is not on the allow-list');

  assert.deepEqual(argvLiterals("const handler = verbs['close'];"), [],
    'reading a property named close executes nothing');
});

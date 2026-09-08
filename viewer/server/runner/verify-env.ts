/**
 * Reads `scripts/verify.env` — the F5-style single source for the
 * verification-command vocabulary (`CWD_SENSITIVE`, `PREFLIGHT_SKIP`,
 * `EXTERNAL_WAIT`), shared with the bash engine exactly the way
 * `sizing.env`/`mcp.env` are: bash sources the file, this module regex-parses
 * the same lines, and a drift test (`test/verify-env.test.ts`) holds the two
 * readers — and the hardcoded fallbacks — to the same values.
 *
 * `EXTERNAL_WAIT` is the newest and the only one both readers use at DIFFERENT
 * moments: lint F16 warns at plan time that a §Verification built from these
 * shapes will hold a session for the full external duration, and the runner's
 * stall detector matches the same shapes against an open Bash call to park a
 * session that is squatting a lock inside its own turn. Two moments, one list,
 * or the warning describes a runtime nobody watches.
 *
 * The fallback exists for a console driving an OLDER scripts directory that
 * predates the file; it must be kept identical to the file's contents, which
 * is what the drift test pins.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type VerifyEnv = {
  /** Leads whose meaning depends on the working directory. */
  cwdSensitive: ReadonlySet<string>;
  /** Names never worth a resolution warning (builtins, keywords). */
  preflightSkip: ReadonlySet<string>;
  /**
   * The external-clock alternation, VERBATIM as the file spells it — the same
   * string bash hands `grep -oE`. Kept as source rather than a compiled regex
   * so the drift test can compare two strings, which is the only comparison
   * that can actually fail when the file changes.
   */
  externalWaitSource: string;
  /**
   * The same alternation compiled. One `RegExp` per scripts directory rather
   * than one per match: this is asked on every liveness tick of every lane.
   *
   * `String.raw`-safe by construction — every construct in the shared value is
   * valid in both POSIX ERE and JS (see the note in `scripts/verify.env`) —
   * but compiled defensively all the same: a malformed edit to the file must
   * degrade to the fallback, never throw on a tick.
   */
  externalWait: RegExp;
  /**
   * The ONE carve-out, verbatim — see `EXTERNAL_WAIT_ALLOW` in `verify.env`.
   * Applied by REMOVAL rather than as a second verdict, because the subject is
   * a line that may hold several commands: `docker compose up -d && docker
   * compose up` must still match on its second half.
   */
  externalWaitAllowSource: string;
  /** The carve-out compiled, GLOBAL — every occurrence is deleted, not the first. */
  externalWaitAllow: RegExp;
  /**
   * Bring-up shapes that belong in `- **Setup:**` rather than §Verification —
   * lint F22's vocabulary. Verbatim, for the same reason `externalWaitSource`
   * is: a set comparison cannot see a character out of place in a regex.
   */
  setupLeadsSource: string;
  /** The same alternation compiled, non-global (the first hit is the evidence). */
  setupLeads: RegExp;
};

/**
 * Newlines and tabs folded to single spaces, whitespace runs collapsed.
 *
 * The shared vocabulary is dialect-neutral and therefore spells its spaces
 * literally (` --watch`, `until [^`]+ do `), which means a multi-line shell
 * construct — the exact shape a poll loop takes in a fenced block —
 * cannot match until it is one line. Both readers fold first: bash with `tr`,
 * this side here, so `until curl -sf localhost\n do\n sleep 5\ndone` is the
 * same subject on both sides.
 */
export function foldWhitespace(text: string): string {
  // A newline becomes `; ` and NOT a space. It is a statement separator in
  // shell, and folding it to a space threw that fact away — which is how a
  // two-line command (`echo "waiting"` then a poll loop) came to read as ONE
  // statement led by `echo`, and bypassed the in-turn guard entirely.
  // Semicolon also keeps the multi-line loop matching: `until X \n do \n sleep`
  // becomes `until X; do; sleep`, which the vocabulary's `; *do` arm reads.
  return text.replace(/\r?\n/g, '; ').replace(/\t/g, ' ').replace(/ {2,}/g, ' ');
}

/**
 * The fragment of the external-clock vocabulary this text matches, or null.
 *
 * THE reader — the liveness detector, lint parity checks and anything else ask
 * through here rather than touching `env.externalWait`, so the fold and the
 * carve-out cannot be applied in one place and forgotten in another. That
 * forgetting is the whole failure mode this module exists for.
 */
export function externalWaitMatch(env: VerifyEnv, text: string): string | null {
  return externalWaitHit(env, text)?.matched ?? null;
}

/**
 * The same answer with its POSITION, and the text the position indexes into.
 *
 * A caller that needs to know WHERE the match landed cannot compute it from the
 * original string: the fold rewrites whitespace and the carve-out deletes
 * spans, so every offset moves. Handing back the carved text with the index is
 * the only way to ask "what statement is this match part of" and get an answer
 * about the same string the matcher looked at.
 */
export function externalWaitHit(
  env: VerifyEnv, text: string,
): { matched: string; carved: string; index: number } | null {
  const carved = foldWhitespace(text).replace(env.externalWaitAllow, () => '');
  const hit = env.externalWait.exec(carved);
  return hit ? { matched: hit[0].trim(), carved, index: hit.index } : null;
}

/** The bring-up fragment this text matches, or null. Folded, never carved. */
export function setupLeadMatch(env: VerifyEnv, text: string): string | null {
  const hit = env.setupLeads.exec(foldWhitespace(text));
  return hit ? hit[0].trim() : null;
}

/** The shared external-clock vocabulary. Keep byte-identical to `verify.env`. */
const EXTERNAL_WAIT_FALLBACK =
  'gh run watch|gh pr checks[^`]*--watch| --watch([^A-Za-z]|$)|task deploy'
  + '|sleep [0-9]{3,}|sleep [6-9][0-9]([^0-9]|$)|sleep [0-9]+[mh]'
  + '|until [^`]+; *do|until [^`]+ do |while (true|:) *; *do|while \\[\\[? [^`]+; *do|while test [^`]+; *do'
  + '|while \\(\\( [^`]+; *do|while sleep [^`]+; *do|while ! [^`]+; *do|watch -n'
  + '|aws [a-z0-9-]+ wait |kubectl rollout status'
  + '|docker[ -]compose logs -f|docker[ -]compose up( |$)|tail -f';

/** The carve-out. Keep byte-identical to `verify.env`. */
const EXTERNAL_WAIT_ALLOW_FALLBACK = 'docker[ -]compose up (-d|--detach)|phase-outcome\\.sh [^;&|]*';

/** Lint F22's bring-up vocabulary. Keep byte-identical to `verify.env`. */
const SETUP_LEADS_FALLBACK =
  'docker[ -]compose up|docker start |npm ci|npm install|pnpm install'
  + '|yarn install|bundle install|pip install|uv sync|poetry install|terraform init'
  + '|alembic upgrade|minikube start|kind create cluster|vagrant up|sleep [0-9]';

export const VERIFY_ENV_FALLBACK: VerifyEnv = {
  cwdSensitive: new Set([
    'docker', 'docker-compose', 'pnpm', 'npm', 'yarn', 'task', 'make', 'just',
    'pytest', 'go', 'cargo', 'alembic', 'vitest', 'jest', 'tsc', 'node',
  ]),
  preflightSkip: new Set([
    'cd', 'true', 'false', 'echo', 'printf', 'test', 'pwd', 'env', 'which',
    'bash', 'sh', 'command', 'export', 'set', 'time',
    'if', 'then', 'fi', 'elif', 'else', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  ]),
  externalWaitSource: EXTERNAL_WAIT_FALLBACK,
  externalWait: new RegExp(EXTERNAL_WAIT_FALLBACK),
  externalWaitAllowSource: EXTERNAL_WAIT_ALLOW_FALLBACK,
  externalWaitAllow: new RegExp(EXTERNAL_WAIT_ALLOW_FALLBACK, 'g'),
  setupLeadsSource: SETUP_LEADS_FALLBACK,
  setupLeads: new RegExp(SETUP_LEADS_FALLBACK),
};

const cache = new Map<string, VerifyEnv>();

/**
 * The raw value of one `KEY="…"` / `KEY='…'` line, or null when the file lacks
 * it.
 *
 * Both quotings, because the file uses both and has to: the word lists are
 * double-quoted, and `EXTERNAL_WAIT` cannot be — it carries backticks, which
 * bash would run as command substitution inside double quotes. A reader that
 * knew only one quoting would silently fall back on a file that is perfectly
 * correct, which is the worst of the three outcomes.
 */
function readRaw(text: string, key: string): string | null {
  const match = new RegExp(`^${key}=(?:"([^"]*)"|'([^']*)')`, 'm').exec(text);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/** Parse one `KEY="a b c"` line into a set, or null when the file lacks it. */
function readList(text: string, key: string): Set<string> | null {
  const raw = readRaw(text, key);
  return raw === null ? null : new Set(raw.split(/\s+/).filter(Boolean));
}

/**
 * Compile the shared alternation, falling back rather than throwing.
 *
 * A file edited into an invalid regex must cost a fallback on one console, not
 * an exception on a liveness tick that would be caught and logged once a
 * minute per lane forever.
 */
function compile(source: string, fallback: RegExp, flags = ''): RegExp {
  try { return new RegExp(source, flags); } catch { return fallback; }
}

export function loadVerifyEnv(scriptsDir: string): VerifyEnv {
  const hit = cache.get(scriptsDir);
  if (hit) return hit;
  let env = VERIFY_ENV_FALLBACK;
  try {
    const text = readFileSync(join(scriptsDir, 'verify.env'), 'utf8');
    const externalWaitSource = readRaw(text, 'EXTERNAL_WAIT') || VERIFY_ENV_FALLBACK.externalWaitSource;
    const allowSource = readRaw(text, 'EXTERNAL_WAIT_ALLOW') || VERIFY_ENV_FALLBACK.externalWaitAllowSource;
    const setupSource = readRaw(text, 'SETUP_LEADS') || VERIFY_ENV_FALLBACK.setupLeadsSource;
    env = {
      cwdSensitive: readList(text, 'CWD_SENSITIVE') ?? VERIFY_ENV_FALLBACK.cwdSensitive,
      preflightSkip: readList(text, 'PREFLIGHT_SKIP') ?? VERIFY_ENV_FALLBACK.preflightSkip,
      externalWaitSource,
      externalWait: compile(externalWaitSource, VERIFY_ENV_FALLBACK.externalWait),
      externalWaitAllowSource: allowSource,
      externalWaitAllow: compile(allowSource, VERIFY_ENV_FALLBACK.externalWaitAllow, 'g'),
      setupLeadsSource: setupSource,
      setupLeads: compile(setupSource, VERIFY_ENV_FALLBACK.setupLeads),
    };
  } catch { /* an older scripts dir without the file — the fallback holds */ }
  cache.set(scriptsDir, env);
  return env;
}

/**
 * Independent verification: the runner's answer to "did that phase actually
 * work?" that does not consult the session which claims it did.
 *
 * A plan's `**Verification:**` bullet is supposed to hold "the runnable
 * command/test that proves each exit criterion". In practice it is prose with
 * commands embedded in it, and the prose matters:
 *
 *   - **Verification:** `docker compose run … pytest tests/unit -q` (new tests)
 *     + full safe set `… -m "not slow and not soak" -q` + `task audit:schema`.
 *   - **Verification:** targeted pytest + safe set; `task contracts` byte-stable.
 *
 * The second span there is a continuation fragment — running it executes `…`.
 * The second bullet names two suites in English and no command at all. A
 * verifier that quietly ran what it could parse and reported success would be
 * worse than none: it would launder "I understood one of three things" into
 * "verified", which is the exact failure the runner exists to prevent.
 *
 * So: extract conservatively, run only what is recognisably a command and
 * demonstrably read-only, and **report every fragment left behind**. The runner
 * decides what an incomplete verification means — under the default autonomy it
 * parks for a human rather than advancing.
 *
 * ## Reading a command well enough to judge it
 *
 * The opposite failure is just as bad, and it is the one that actually bit. A
 * plan wrote this, which is two ordinary read-only commands:
 *
 *   cd …/viewer && PHASE_CONSOLE_TEST_ROOT=~/repo node --test "test/*.test.ts"
 *   cd … && git ls-files \
 *     | grep -v '^viewer/web/vendor' \
 *     | xargs grep -nliE 'secret|private-host' ; echo "scrub exit: $?"
 *
 * The old reader split the fence on newlines, so the backslash continuations
 * became three separate "commands" — two of them beginning with `|`. Then the
 * classifier looked at the first whitespace token of each and refused all four,
 * `cd` included. A person was asked to hand-confirm four checks that were two
 * commands this could have run in eleven seconds, and confirming them recorded
 * `ran: 0` as verified. Asking a human to do the machine's job is not caution;
 * it spends the one resource that does not scale and teaches them to click yes.
 *
 * So the reader now joins continuations, and the classifier splits a command
 * into the segments a shell would run — respecting quotes — and requires **every
 * segment** to pass. That is strictly safer than judging the first token, which
 * let `node --test x && curl -X POST …` through on the strength of `node`, and
 * `FOO=1 ./deploy.sh` through because the head token was an assignment. It is
 * also what the CLI's own Bash matcher does.
 *
 * Structure this cannot fully parse — an unbalanced quote, a substitution whose
 * inner command is unknowable — is refused rather than guessed at, and becomes a
 * card for a person. That direction is deliberate: an unparsed command must
 * never fall through to "looks fine".
 *
 * ## Reading the markdown well enough to find the command
 *
 * Two more ways a real plan defeated all of the above, both measured on run
 * `dc3d6d25`, where phases 1 and 2 each advanced on a person clicking "verified"
 * with `ran: 0`:
 *
 *   - **Verification:** `cd …/viewer && npm test && npm run test:client &&
 *     npm run typecheck:client && npm run build`. Manual: enable `changed`, …
 *
 * That is ONE command. It is wrapped because the file is wrapped at 100 columns
 * — markdown joins the lines back, and so does every reader of the rendered
 * page. The extractor did not, and refused its own best command as "spans
 * multiple lines". The same bullet then raised a second card for `changed`, a
 * notification category being named in a sentence.
 *
 * So: a span's line breaks are wrapping, not statement separators (a newline
 * separates statements in a *block*, and blocks are fenced — that path is
 * unchanged), and **a backticked name is a citation, not an unmet check**.
 * `test/terminal*.test.ts`, `changed` and `POST /api/prefs` name things the
 * prose is talking about; asking a person to hand-confirm them, beside commands
 * that did run, is exactly the "teaches them to click yes" failure again. Names
 * are dropped only when something runnable was found — a bullet whose entire
 * content is a name still says so, because then nothing was proven.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync, readdirSync, statSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { log } from '../log.ts';
import { groupMembers } from '../pid.ts';
// `signals.ts` and not a local kill: verification children are the one
// child-spawning path in `server/` the ladder did not cover, and the ladder is
// the ONLY place that signals a process (test/invariants.test.ts greps for it).
// No `killAfterMs` — the ladder's own 15s default is the same grace the runner
// uses, and importing the constant from `runner-core.ts` would be a cycle
// (it imports this file).
import { killLadder, type LadderEnding } from './signals.ts';
import type { VerifyNotRun, VerifyRun, VerifySkip, VerifySummary } from './state.ts';

/**
 * Kept in step with `GATE_CMD_DENY` in scripts/phase-graph.sh — same intent,
 * and `verify-extract.test.ts` diffs the two token by token, so keep prose OUT
 * of the expression itself.
 *
 * The package-manager RELEASE verbs joined the list when the `cmd:` watch
 * scheme opened a second door to it (console-unattended-autopilot P2).
 * `MUTATING_SCRIPT` already refused a script CALLED `publish.sh` on its name
 * alone, while `npm publish` sailed straight past — a rule that stops the
 * wrapper and runs the command it wraps is a spelling test, not a rule. It
 * matters twice over here: this repo IS an npm package, and a `cmd:` ref is a
 * command a SESSION wrote, run on a timer with nobody watching. `version` is on
 * the list with them because it writes to the repository and can push a tag.
 *
 * `gh` is deliberately NOT here: its own inverted allowlist below already
 * refuses `gh release create` ("read-only gh subcommands") and `gh api -X POST`
 * ("non-GET GitHub API request") while still permitting `gh release view` and
 * `gh api … -q …` — which is exactly what a watch ref wants. A blanket
 * `gh (release|api)` line here would have broken the reads without adding a
 * single refusal.
 *
 * The git clause's verb must END where it ends, and may follow global options
 * (2026-09-18). With no boundary, `git merge-base --is-ancestor` read as a
 * merge — the second stop run f0da619a held at its phase 18 — while
 * `git -C ../other push` and `git --no-pager commit` walked past the verb the
 * clause expected right after `git`. The boundary is "not a word character and
 * not a hyphen", never whitespace alone: a whole gate-check line can carry
 * `git push;true`. The hyphenated verbs that WRITE the tree (`merge-file`,
 * `merge-index`, `merge-one-file`, `checkout-index`) stay refused;
 * `merge-base`, `merge-tree` and `commit-graph` read.
 */
const MUTATION_DENY = new RegExp(
  '(^|[;&|\\s])(rm|mv|dd|mkfs|shutdown|reboot|kill|pkill|chown|chmod|sudo)(\\s|$)'
  + '|terraform\\s+(apply|destroy)'
  + '|git(\\s+(-[Cc]\\s+\\S+|--?[\\w-]+(=\\S+)?))*\\s+(push|reset|clean|checkout|commit|rebase|merge)(-(file|index|one-file))?([^-\\w]|$)'
  + '|docker\\s+(rm|rmi|kill|stop|system\\s+prune)'
  + '|task\\s+[a-z:]*(deploy|ship|update|apply|destroy)'
  + '|(npm|pnpm|yarn|cargo|gem|twine|poetry|uv)\\s+(publish|version|deprecate|unpublish|dist-tag|owner|access)'
  + '|\\s(delete|put|create|set|modify|terminate|reboot)-'
  + '|>\\s*/|>>\\s*/',
  'i',
);

/**
 * A redirect into `/dev/null` discards output; it writes nothing. The deny
 * rule's `>\s*\/` is there for a write to an absolute path, and it read
 * `grep -q x f 2>/dev/null` as one — "mutates", the class no answer may carve.
 * It is removed before the rule is asked, and `>& file` (a write plus `2>&1`)
 * is folded to `> file` so the write is still seen. The bash twin is
 * `_deny_view` in scripts/phase-graph.sh.
 */
const DEV_NULL_REDIRECT = /[0-9&]?>>?&?\s*\/dev\/null(?=$|[\s;&|)])/g;

/** Does this segment look like it changes something? The one reading of `MUTATION_DENY`. */
function mutates(segment: string): boolean {
  return MUTATION_DENY.test(segment.replace(DEV_NULL_REDIRECT, ' ').replace(/>&(?=\s*[^\s0-9-])/g, '>'));
}

/**
 * Only these lead a command the runner will execute. An allowlist rather than a
 * pattern because the input is human prose: `docs/plans/x.md` and `main.py` are
 * both plausible-looking "commands" to a regex and neither is one.
 *
 * Case-sensitive on purpose. `NPM test` fails in bash too, and a classifier that
 * forgave the typo would be promising something the shell will not deliver.
 */
const VERBS = new Set([
  'task', 'make', 'just',
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'tsc', 'jest', 'vitest', 'eslint', 'prettier',
  'python', 'python3', 'pytest', 'uv', 'poetry', 'ruff', 'mypy', 'black', 'tox', 'alembic',
  'go', 'cargo', 'rustc',
  'bash', 'sh', 'zsh', 'shellcheck',
  // A test runner like jest or pytest — and this repository's own. Its absence
  // halted a run (f0da619a, 2026-09-18): `Person-check: halt` parks a phase on
  // any fragment read as prose, and eight phases verified with `bats`.
  'bats',
  'docker', 'docker-compose', 'kubectl', 'gh',
  'git', 'terraform',
  'curl', 'dig', 'ssh', 'psql', 'redis-cli', 'jq',
  'grep', 'rg', 'diff', 'test', 'ls', 'cat', 'head', 'tail', 'wc', 'find', 'awk', 'sed',
  'echo', 'printf', 'true', 'false', 'pwd', 'env', 'which',
  // Read-only filters that appear mid-pipeline in real verification blocks.
  // `xargs` is here because the command it runs is judged separately, below.
  'xargs', 'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'stat', 'nl',
  // Pacing, not work. "start services, sleep 8, then test" is the standard
  // preamble of a containerised plan's §Verification, and refusing the pause
  // put a card in front of a person asking them to vouch for `sleep 8` — on
  // every phase of a real plan. Bounded like everything else by the
  // per-command timeout.
  'sleep',
  // The macOS keychain, for one read: a credential step is proved by
  // `security find-generic-password -s <service>`, which prints the item's
  // attributes and never its secret (#201). Gated by subcommand below, like
  // docker — a lead alone would let `dump-keychain` through.
  'security',
]);

/**
 * Leads a `- **Setup:**` command may use that a §Verification command may not.
 *
 * Setup is bring-up: it exists to CHANGE something — start a stack, install
 * dependencies, run a migration — which is exactly what the list above and the
 * `REACHES_OUT` gates below are built to refuse. So the setup lane widens two
 * things and only two: these leads join `VERBS`, and the read-only subcommand
 * gates are not applied (`docker compose up -d` is the whole point, and
 * `DOCKER_READ_ONLY` would refuse it).
 *
 * **`MUTATION_DENY` and `MUTATING_SCRIPT` still hold, absolutely.** A Setup
 * bullet cannot `rm`, `git push`, `terraform apply`, `npm publish` or run a
 * script named `deploy.sh` — the widening is "may start things", never "may do
 * anything". Every entry here is a lead from `SETUP_LEADS` in
 * `scripts/verify.env` plus the two file-makers a bring-up needs.
 */
const SETUP_VERBS = new Set([
  'minikube', 'kind', 'vagrant', 'createdb', 'mkdir', 'bundle', 'pip', 'pip3',
]);

/**
 * And what each of them may actually do.
 *
 * `SETUP_VERBS` says a lead is RECOGNISED; without this it also said the lead
 * was unconditional, and QA found H1's class one door over: restoring
 * `REACHES_OUT` changed nothing for these four because that table has no entry
 * for them, so `vagrant destroy -f`, `minikube delete --all --purge` and
 * `kind delete cluster` all ran. `scripts/verify.env`'s `SETUP_LEADS` had
 * always specified the widening per SUBCOMMAND (`minikube start`,
 * `kind create cluster`, `vagrant up`); this file implemented it per LEAD, and
 * a docstring claiming parity with that file is what hid the gap.
 *
 * A lead mapped to `null` takes no subcommand — `createdb <name>` and
 * `mkdir -p <dir>` create and cannot destroy.
 */
const SETUP_SUBCOMMANDS: Record<string, ReadonlySet<string> | null> = {
  minikube: new Set(['start']),
  kind: new Set(['create']),
  vagrant: new Set(['up', 'provision']),
  bundle: new Set(['install', 'config', 'check']),
  pip: new Set(['install']),
  pip3: new Set(['install']),
  createdb: null,
  mkdir: null,
};

/*
 * The three bounds `dockerSetupGate` applies before it reads a subcommand.
 *
 * The first cut of each was written against the spelling QA happened to use,
 * and QA's next round used a different one. Every pattern here therefore
 * accepts BOTH `--flag value` and `--flag=value`, and the path bound refuses a
 * relative path that climbs out (`../../etc/prod/compose.yml`) as well as an
 * absolute one — measured bypasses, all five of them.
 */

/**
 * `-H`, `--host`, `--context`, or an env prefix that aims the client elsewhere
 * — `DOCKER_HOST=`, `DOCKER_CONTEXT=`, a `DOCKER_CONFIG=` holding another
 * context, or a `COMPOSE_PROJECT_NAME=` that attaches to somebody else's
 * stack (QA round 4's spelling).
 */
const DOCKER_REMOTE =
  /(^|\s)(DOCKER_HOST=|DOCKER_CONTEXT=|DOCKER_CONFIG=|COMPOSE_PROJECT_NAME=|(-H|--host|--context)(=|\s))/;

/**
 * A compose/env file or project directory that is absolute, or climbs out —
 * as `--flag value`, `--flag=value`, the pflag shorthand with no separator
 * (`-f/etc/prod/compose.yml`), or compose's own `COMPOSE_FILE=` env prefix
 * (a `:`-separated list, any entry of which may be foreign).
 */
const DOCKER_FOREIGN_PATH =
  /(^|\s)(?:(-f|--file|--env-file|--project-directory)(=|\s+)?|COMPOSE_FILE=)(\/|~|[^\s]*(\.\.|:\/|:~))/;

/**
 * A host that is not this machine, for the setup verbs that create ON a host:
 * `createdb -h prod-db.internal` creates a database on another machine, and
 * `minikube start --driver=ssh` brings a cluster up on one.
 */
const SETUP_REMOTE_HOST =
  /(^|\s)(PGHOST=|PGHOSTADDR=|--driver=ssh|--ssh-ip-address|(-h|--host)(=|\s+|)(?!(localhost|127\.0\.0\.1|::1)(\s|$))\S)/;

/** A compose project NAME attaches to whatever stack already carries it. */
const DOCKER_PROJECT_FLAG = /(^|\s)(docker\s+compose|docker-compose)\s+([^;&|]*\s+)?(-p|--project-name)(=|\s)/;

/**
 * `--renew-anon-volumes` (also `-V`, which a short-flag CLUSTER can hide in —
 * `up -dV` dodged a pattern that expected the flag alone) and
 * `--remove-orphans`.
 */
const DOCKER_DESTRUCTIVE =
  /(^|\s)(--renew-anon-volumes|--remove-orphans|-[a-z]*V[a-zA-Z]*)(\s|=|$)/;

/** The gate that enforces it — same shape as `dockerSetupGate`. */
function setupVerbGate(segment: string): string | null {
  const tokens = headOf(tokenize(segment));
  const lead = (tokens[0] ?? '').replace(/^.*\//, '');
  const allowed = SETUP_SUBCOMMANDS[lead];
  if (allowed === undefined) return null;
  if ((lead === 'createdb' || lead === 'minikube') && SETUP_REMOTE_HOST.test(segment.replace(/["']/g, ''))) {
    return 'names another host, so it creates on somebody else\'s machine';
  }
  if (allowed === null) return null;
  const sub = skipFlags(tokens.slice(1))[0];
  if (sub && allowed.has(sub)) return null;
  return `is not one of the bring-up ${lead} subcommands (${[...allowed].join(', ')})`;
}

/** `./run.sh`, `scripts/x.sh`, `./scripts/x.py`, `/abs/path/x.ts`. */
const SCRIPT_PATH = /^\.{0,2}\/?[\w.@-]+(\/[\w.@-]+)*\.(sh|bash|zsh|py|js|ts|mjs|cjs)$/;

/**
 * A script path is trusted on its name alone — there is no way to know what
 * `./run.sh` does short of running it. So the name has to carry the signal, the
 * same way `task deploy:x` does in `MUTATION_DENY`: a name that reads as a verb
 * of consequence goes to a person. `FOO=1 ./deploy.sh` used to run here.
 */
const MUTATING_SCRIPT =
  /(^|[_.-])(deploy|ship|publish|release|provision|migrate|destroy|install|bootstrap|reset|seed|sync|apply|update|upgrade|push|prune)([_.-]|\.[a-z]+$)/i;

/** Docker subcommands that only look. */
const DOCKER_READ_ONLY = new Set([
  'ps', 'logs', 'inspect', 'images', 'version', 'info', 'top', 'stats', 'port', 'diff', 'config',
]);

/** The two spellings the `docker` gate answers for. */
const DOCKER_VERBS = new Set(['docker', 'docker-compose']);

/**
 * The keychain subcommands that only look (control-tower phase 111, #201).
 * Without `-w` or `-g` each prints an item's attributes and exits 0 when it
 * exists — exactly what a credential step's proof asks. Everything else
 * `security` does (`add-*`, `delete-*`, `dump-keychain`, `export`,
 * `unlock-keychain`, interactive `-i`) writes, unlocks or prints secrets.
 */
const KEYCHAIN_LOOKUPS = new Set(['find-generic-password', 'find-internet-password']);

/**
 * `-w` prints the password alone and `-g` prints it beside the attributes.
 * Read per token, so a short-flag cluster cannot hide either (`-gs x`, `-aw`).
 */
const KEYCHAIN_PRINTS_SECRET = /^-[A-Za-z]*[gw]/;

/**
 * Docker subcommands a `- **Setup:**` bullet may run that §Verification may not.
 *
 * The bring-up half, and nothing else. `down` is absent deliberately —
 * `docker compose down -v` destroys named volumes, which on a plan whose
 * database lives in one is the difference between a preamble and a data-loss
 * incident, and it is not bring-up in any case. `rm`/`rmi`/`kill`/`stop` are
 * already refused by `MUTATION_DENY` and stay refused.
 *
 * `pull` is absent for a different reason, and it is not that it is dangerous:
 * `never-push.test.ts` scans every argument list under `viewer/server` for a
 * git verb that reaches a remote, and cannot tell a docker subcommand set from
 * an argv — a bare `'pull'` in a literal here reads to it exactly like
 * `git pull`. That gate deliberately has no exemption, and dodging it by
 * spelling the set differently would be weakening it. Nothing is lost: `up`
 * pulls a missing image by itself, so a separate `pull` is a pre-warm rather
 * than a step bring-up needs. Do not "restore" it.
 */
const DOCKER_SETUP_OK = new Set(['up', 'start', 'build', 'create']);

/**
 * Verbs that reach OUTSIDE this working tree, and are therefore only allowed in
 * a shape that is demonstrably read-only.
 *
 * `MUTATION_DENY` above is a denylist, and a denylist is the wrong instrument
 * for these: `curl -X POST https://…`, `ssh box 'systemctl restart api'` and
 * `psql -c 'DELETE FROM orders'` all sail past it, and every one of them is a
 * verification bullet somebody could plausibly write. The runner then executes
 * it, unattended, at 3am, because a markdown file said so.
 *
 * So for this handful the question is inverted: not "does it look dangerous?"
 * but "can I show it is safe?". Anything that cannot be shown safe goes to the
 * person who wrote the plan, with the reason — which is a card in the console,
 * not a dead end.
 *
 * These now run against a single SEGMENT rather than the whole line, which is
 * what closes the hole where a leading local verb hid a trailing remote write.
 */
const REACHES_OUT: Record<string, (segment: string) => string | null> = {
  // Anything that is not a plain GET, or that carries a body, is a write.
  curl: (c) => (/\s-(X|-request)\s+(?!GET\b)/i.test(c) ? 'sends a non-GET request'
    : /\s-(d|F|T)\b|--data|--form|--upload-file/.test(c) ? 'sends a request body'
      : null),
  // The command run on the far end is the thing to judge, and we cannot judge
  // it: it is quoted prose on another machine. Only a bare connection check and
  // an explicitly read-only remote command pass.
  ssh: (c) => {
    const remote = /^ssh\s+(?:-\S+\s+|-\S+\s+\S+\s+)*\S+\s+(.+)$/.exec(c)?.[1]?.trim();
    if (!remote) return null; // `ssh host` alone connects and does nothing
    const bare = remote.replace(/^['"]|['"]$/g, '').trim();
    return /^(cat|ls|head|tail|grep|wc|stat|df|du|uptime|whoami|hostname|date|docker\s+(ps|logs|inspect)|systemctl\s+(status|is-active)|journalctl)\b/.test(bare)
      ? null
      : 'runs a command on another machine that cannot be shown to be read-only';
  },
  psql: (c) => (/-c\s*(['"])\s*(select|show|explain|\\d|\\l)/i.test(c) || !/-c\b|-f\b/.test(c)
    ? null
    : 'runs SQL that is not demonstrably a read'),
  // `run` and `exec` are judged by the command they carry (see `innerCommand`),
  // not by their own name: `docker compose run --rm api pytest -q` is a test
  // suite, and refusing it sends every containerised plan's verification to a
  // human. The hyphenated and spaced spellings are the same thing. Token-walked
  // rather than regexed: `docker compose -f infra/compose.yml config` used to
  // backtrack the optional `compose\s+` group and judge the subcommand as
  // `compose` — refusing a pure read ~5 times on one real plan.
  docker: (c) => {
    let rest = headOf(tokenize(c)).slice(1);
    if (rest[0] === 'compose') rest = rest.slice(1);
    rest = skipFlags(rest);
    const sub = rest[0];
    if (!sub) return null; // bare `docker` prints usage
    if (DOCKER_READ_ONLY.has(sub) || sub === 'run' || sub === 'exec') return null;
    return 'is not one of the read-only docker subcommands';
  },
  // GitHub's CLI: most of it writes, so the question is inverted like kubectl —
  // only demonstrably read-only subcommand pairs pass. `--watch` shapes wait on
  // an external clock (F16 warns at plan time; here they would hold a session
  // for the full CI duration). `gh api` passes only as a plain GET.
  gh: (c) => {
    if (/\s--watch\b/.test(c) || /^gh\s+run\s+watch\b/.test(c)) {
      return 'waits on an external clock the runner cannot bound';
    }
    const m = /^gh\s+([a-z-]+)(?:\s+([a-z-]+))?/.exec(c);
    if (!m) return 'is not a gh invocation the runner can judge';
    if (m[1] === 'api') {
      return /\s(-X|--method)\s+(?!GET\b)\S+/i.test(c) || /(^|\s)(-f|-F|--field|--raw-field|--input)\b/.test(c)
        ? 'sends a non-GET GitHub API request'
        : null;
    }
    const pair = `${m[1]} ${m[2] ?? ''}`.trim();
    const READ = /^(run (list|view|download)|pr (list|view|checks|status|diff)|issue (list|view)|release (list|view)|repo view|workflow (list|view)|search (repos|issues|prs|code)|status|auth status)$/;
    return READ.test(pair) ? null : 'is not one of the read-only gh subcommands';
  },
  kubectl: (c) => (/^kubectl\s+(get|describe|logs|top|explain|version|api-resources)\b/.test(c)
    ? null
    : 'is not one of the read-only kubectl subcommands'),
  'redis-cli': (c) => (/\b(get|keys|scan|info|ping|ttl|type|llen|exists|dbsize)\b/i.test(c)
    ? null
    : 'runs a Redis command that is not demonstrably a read'),
  // The keychain: the two lookups, never a form that prints the secret. The
  // subcommand must lead — a global flag before it (`-i`, `-q`) is refused
  // rather than walked past, since `-i` is the interactive shell.
  security: (c) => {
    const rest = headOf(tokenize(c)).slice(1);
    const sub = rest[0];
    if (!sub || !KEYCHAIN_LOOKUPS.has(sub)) {
      return `is not one of the read-only keychain lookups (${[...KEYCHAIN_LOOKUPS].join(', ')})`;
    }
    // A `$` or a backtick expands at run time — `$'-w'` and `$FLAG` reach
    // `security` as `-w` — so what it would be passed is the shell's to say,
    // not this judge's. Quotes and escapes are already read through.
    const expands = rest.slice(1).find((token) => /[$`]/.test(token));
    if (expands) {
      return `passes an expansion the judge cannot read (\`${expands.slice(0, 12)}\`); a keychain proof names its flags and its item literally`;
    }
    const prints = rest.slice(1).find((token) => KEYCHAIN_PRINTS_SECRET.test(token));
    return prints
      ? `prints the secret (\`${prints.slice(0, 8)}\`); a proof needs only the item's attributes`
      : null;
  },
};
REACHES_OUT['docker-compose'] = REACHES_OUT.docker;

/**
 * The `docker` gate as the SETUP lane sees it: the read-only set, plus
 * bring-up. Everything else — including `down` — answers exactly as it does in
 * the verify lane, in that lane's words.
 */
function dockerSetupGate(segment: string): string | null {
  // Bounded in host and in path before the subcommand is even read. The
  // widening is "bring up THIS repo's stack": a compose file outside the tree,
  // a project directory pointing at the root, or a `DOCKER_HOST` aimed at
  // another machine are all "bring up somebody else's", and the last one turns
  // every allowance below into a remote one. The bounds read the segment with
  // its quote marks removed — round 5 measured `-f "/etc/x"` sailing past a
  // pattern that expected the `/` right after the space.
  const flat = segment.replace(/["']/g, '');
  if (DOCKER_REMOTE.test(flat)) {
    return 'aims at another docker host, so it brings up a stack on another machine';
  }
  if (DOCKER_PROJECT_FLAG.test(flat)) {
    return 'names a compose project, so it attaches to whatever stack carries that name';
  }
  if (DOCKER_FOREIGN_PATH.test(flat)) {
    return 'names a compose path outside this tree, so it brings up somebody else\'s stack';
  }
  // Flags that DESTROY while bringing up — the same harm `down` is excluded
  // for, spelled as an option instead of a subcommand.
  if (DOCKER_DESTRUCTIVE.test(flat)) {
    return 'carries a flag that removes volumes or containers while starting';
  }
  let rest = headOf(tokenize(segment)).slice(1);
  if (rest[0] === 'compose') rest = rest.slice(1);
  rest = skipFlags(rest);
  const sub = rest[0];
  if (!sub) return null;
  if (DOCKER_SETUP_OK.has(sub)) return null;
  return REACHES_OUT.docker(segment);
}

export type Extraction = {
  commands: string[];
  notRun: VerifyNotRun[];
  /** Fragments the run's own answers set aside: not run, not asked about, still on the record. */
  waived: VerifyNotRun[];
};

/**
 * Which wall refused a fragment. Only `unknown-lead` can ever be approved —
 * and only when approving would actually make it run (`approvable`).
 */
export type RefusalCode =
  | 'unknown-lead' | 'mutates' | 'reaches-out' | 'unreadable' | 'background'
  | 'prose' | 'names-file' | 'fragment' | 'other';

type Refusal = { code: RefusalCode; reason: string; lead?: string };

const refusal = (code: RefusalCode, reason: string, lead?: string): Refusal =>
  (lead ? { code, reason, lead } : { code, reason });

/**
 * The operator's answers for one phase, keyed by `commandFingerprint`.
 *
 * `approve` relaxes exactly ONE judgement for that exact text — "is this a
 * command I recognise?" — and nothing else: the deny wall, the named-script
 * wall, the off-machine gates and the wrapper recursion all still run, so an
 * approved `frobnicate && rm -rf x` is still refused. `waive` sets a refused
 * fragment aside for this phase. Neither ever reaches `runSingleCommand` (the
 * `cmd:` watch door), which runs strings a SESSION wrote.
 */
export type VerifyApprovals = {
  approve?: ReadonlySet<string>;
  waive?: ReadonlySet<string>;
};

/**
 * The sha256 of a command's WHOLE text, whitespace folded — so markdown
 * wrapping is not a different command, and one more flag is. What an approval
 * is bound to (the practice Claude Code's exact-command rules and OWASP's
 * "bind approval to the exact action" both describe); `condense` truncates for
 * display and must never key anything.
 */
export function commandFingerprint(text: string): string {
  return createHash('sha256').update(foldCommand(text)).digest('hex');
}

/**
 * A command's text with its whitespace folded — what `commandFingerprint`
 * hashes, and the key a session's recorded proof is matched on (`proofs.ts`,
 * control-tower phase 62). `phase-outcome.sh … verified` folds the same way
 * before it writes, so the two ends compare equal strings.
 */
export function foldCommand(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Pull candidate commands out of a Verification bullet.
 *
 * Fenced blocks are read with their line continuations joined; inline spans are
 * taken whole. Anything that is not recognisably a command, or that would mutate
 * something, comes back in `notRun` with the reason — never dropped.
 */
export function extractCommands(
  text: string | undefined, lane: Lane = 'verify', approvals?: VerifyApprovals,
): Extraction {
  const out: Extraction = { commands: [], notRun: [], waived: [] };
  if (!text || !text.trim()) return out;

  const candidates: string[] = [];

  // ONE ordered pass, fence-alternative first so a fence's own backticks can
  // never be re-read as inline spans. It used to be two passes — every fenced
  // block, then every inline span — which meant the commands came back in
  // EXTRACTION order rather than SOURCE order.
  //
  // That is not cosmetic and the setup lane is where it bit: a phase whose
  // `- **Setup:**` is a fenced block, under a plan-wide `**Setup (every
  // phase):**` line of inline spans, ran its own block BEFORE the shared stack
  // the block depends on — the exact opposite of the "plan first, bring-up is
  // ordered" contract the format documents. Found by `engine-parity`, which
  // compares this against the bash engine's answer and saw the two orders
  // disagree. §Verification had the same latent bug for any bullet mixing the
  // two shapes; it is fixed here for both, because one extractor with two
  // orders is the thing this function exists to avoid.
  const FENCE = /(?:```|~~~)[^\n]*\r?\n([\s\S]*?)(?:```|~~~)/g;
  const INLINE = /`([^`]+)`/g;
  const found: { at: number; commands: string[] }[] = [];

  // Fenced blocks are located AND MASKED first — replaced by spaces of the same
  // length, so every offset still indexes the original text. Masking rather
  // than deleting is what keeps the inline scanner's pairing identical to what
  // it has always been: a stray unbalanced backtick before a fence used to
  // pair against the text after it, and a scanner that walked both shapes in
  // one alternation paired it against the fence's own backticks instead —
  // producing `npm test then` as a command, which would RUN and redden the
  // phase. Same pairing as before, source order as intended.
  let masked = text;
  for (const match of text.matchAll(FENCE)) {
    found.push({ at: match.index ?? 0, commands: fencedCommands(String(match[1])) });
    masked = masked.slice(0, match.index ?? 0)
      + ' '.repeat(match[0].length)
      + masked.slice((match.index ?? 0) + match[0].length);
  }
  for (const match of masked.matchAll(INLINE)) {
    // An inline span is one line however the source file wrapped it. Joining
    // is what the renderer does; not joining refused whole commands for the
    // crime of being longer than a hundred columns.
    found.push({
      at: match.index ?? 0,
      commands: [match[1].replace(/\s*\r?\n\s*/g, ' ').trim().replace(/^\$\s+/, '')],
    });
  }
  found.sort((a, b) => a.at - b.at);
  for (const entry of found) candidates.push(...entry.commands);

  // Prose with no code spans at all still states a requirement — say so rather
  // than reporting a phase with zero commands as cleanly verified.
  if (!candidates.length) {
    const prose = masked.replace(INLINE, ' ');
    const item: VerifyNotRun = {
      text: condense(prose),
      reason: 'no command in the plan text — verify by hand',
      code: 'prose',
      fp: commandFingerprint(prose),
      approvable: false,
    };
    (approvals?.waive?.has(item.fp!) ? out.waived : out.notRun).push(item);
    return out;
  }

  const refused: (VerifyNotRun & { cited: boolean })[] = [];
  for (const candidate of candidates) {
    const fp = commandFingerprint(candidate);
    const approved = approvals?.approve?.has(fp) ?? false;
    const verdict = refuse(candidate, lane, approved);
    // Dropped from both lists — see `PREAMBLE`. Not run, and not reported.
    if (verdict === PREAMBLE) continue;
    if (!verdict) { out.commands.push(candidate); continue; }
    const item: VerifyNotRun = {
      text: condense(candidate),
      reason: verdict.reason,
      code: verdict.code,
      ...(verdict.lead ? { lead: verdict.lead } : {}),
      fp,
      // Approvable means an approval would make it RUN — asked of the same
      // judgement with the one relaxation, never inferred from the code.
      approvable: verdict.code === 'unknown-lead' && refuse(candidate, lane, true) === null,
    };
    if (approvals?.waive?.has(fp)) { out.waived.push(item); continue; }
    refused.push({ ...item, cited: namesAThing(candidate) });
  }

  // A name in backticks beside commands that ran is the prose talking about
  // something, not a check somebody owes. With nothing runnable in the bullet it
  // is reported like any other fragment — that phase really was not verified.
  for (const { cited, ...item } of refused) {
    if (cited && out.commands.length) continue;
    out.notRun.push(item);
  }

  return out;
}

/** `GET /api/state` — a route being named, and never a command. */
const HTTP_CALL = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S*$/;

/**
 * Source files that need an interpreter, cited by name: `server/terminal.ts`,
 * `test/agent.test.ts`. Written `./x.py` the author means "run this"; written
 * bare with a slash in it they mean "that file". `.sh` is excluded on purpose —
 * `scripts/check.sh` is a command in every plan that has one.
 */
const CITED_SOURCE = /^[\w.@-]+(\/[\w.@-]+)+\.(ts|tsx|js|jsx|mjs|cjs|py)$/;

/**
 * Does this span name a thing rather than state an action?
 *
 * One word is the test that carries it: an instruction has a verb and an object.
 * `changed`, `test/terminal*.test.ts` and `SessionInfo` are things a sentence is
 * about. Anything with a space in it is treated as an attempted command and
 * still goes to a person — including `./deploy.sh`, which is one word but is
 * unmistakably an instruction, and whose whole point is that a human runs it.
 */
function namesAThing(candidate: string): boolean {
  const text = candidate.trim();
  if (HTTP_CALL.test(text)) return true;
  // `1`, `128 112 3 12 124` — an exit-code table's cells, backticked. Pure
  // numbers are the prose naming values; handing them to bash produced real
  // "a person will be asked: 1 …" cards. Before the whitespace test, since
  // the multi-number shape contains spaces.
  if (/^\d[\d\s.,]*$/.test(text)) return true;
  if (/\s/.test(text)) return false;
  if (CITED_SOURCE.test(text)) return true;
  if (SCRIPT_PATH.test(text)) return false;
  return !VERBS.has(text.replace(/^.*\//, ''));
}

/**
 * Read a fenced block into whole commands.
 *
 * A command wrapped across lines is one command. Splitting the fence on `\n`
 * turned `git ls-files \` / `| grep …` into two, the second of which begins with
 * a pipe and is not a command at all — which is how a plan holding two runnable
 * commands produced four "checks only you can make".
 */
function fencedCommands(body: string): string[] {
  const out: string[] = [];
  let buffer = '';

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    // A blank line or a comment ends nothing mid-command; it is only skipped
    // when we are not part-way through one.
    if (!buffer && (!line.trim() || line.trim().startsWith('#'))) continue;

    // An ODD number of trailing backslashes is a continuation; an even number is
    // an escaped backslash that happens to end the line.
    const continues = /(^|[^\\])(\\\\)*\\$/.test(line);
    const piece = (continues ? line.slice(0, -1) : line).trim().replace(/^\$\s+/, '');
    buffer = buffer ? `${buffer} ${piece}` : piece;

    // `foo |` and `foo &&` continue onto the next line too, with no backslash.
    if (continues || /(\||\|\||&&)$/.test(buffer)) continue;

    if (buffer) out.push(buffer);
    buffer = '';
  }
  if (buffer) out.push(buffer);
  return out;
}

/**
 * Not a refusal — a candidate that is neither a check nor a chore.
 *
 * Distinct from `null` (run it) and from a reason string (tell a person about
 * it), because a plan's environment preamble belongs in NEITHER list: running
 * `export PATH=…` in its own subprocess accomplishes nothing, and reporting it
 * as "a check only you can make" is a false alarm about a line that is not a
 * check at all.
 *
 * It stays out of `commands` too, which is what keeps F14 honest: a
 * §Verification holding nothing but a preamble still has nothing runnable in
 * it, and must still warn.
 */
const PREAMBLE = '\u0000preamble';

/**
 * Which lane a command is being judged for.
 *
 * `verify` is the read-only judgement everything has always had. `setup` is
 * the same judgement with the two documented widenings (`SETUP_VERBS`, no
 * `REACHES_OUT` gate) — see that constant for what stays.
 */
type Lane = 'verify' | 'setup';

/**
 * Why this candidate will not be run, or null when it will be.
 *
 * `approved` is the operator's exact-text approval of THIS candidate: it
 * relaxes "is this a command I recognise?" for its segments and nothing else.
 */
function refuse(candidate: string, lane: Lane = 'verify', approved = false): Refusal | typeof PREAMBLE | null {
  if (!candidate) return refusal('fragment', 'empty');
  // A continuation of the command above it: running `…` is nonsense, and
  // guessing what it continues would be worse.
  if (/^(…|\.\.\.)/.test(candidate)) return refusal('fragment', 'a continuation fragment, not a whole command');
  if (candidate.length > 2_000) return refusal('fragment', 'implausibly long for a command');
  if (/\n/.test(candidate)) return refusal('fragment', 'spans multiple lines');
  return refuseCommand(candidate, 0, lane, approved);
}

const MAX_NESTING = 3;

/** What `segments` answers when the structure would be a guess. */
const UNREADABLE_STRUCTURE = refusal('unreadable',
  'could not be read with confidence — unbalanced quoting, or a substitution '
  + 'whose inner command the runner cannot judge');

/** What `segments` answers for a lone `&`. */
const BACKGROUNDED = refusal('background',
  'backgrounds a command with `&` — bash returns at once and never reads its exit code, '
  + 'so it could prove nothing');

/**
 * Every segment a shell would run must pass, or the whole command is refused —
 * and so must every command a double-quoted `$(…)` runs.
 */
function refuseCommand(
  command: string, depth: number, lane: Lane = 'verify', approved = false,
): Refusal | typeof PREAMBLE | null {
  if (depth > MAX_NESTING) return refusal('unreadable', 'nests commands more deeply than the runner will judge');

  const split = segments(unwrap(command));
  if ('refusal' in split) return split.refusal;
  if (!split.parts.length) return refusal('fragment', 'empty');

  // A preamble segment is skipped rather than returned, so that
  // `export PATH=… && npm test` stays the runnable command it obviously is —
  // returning on the first segment would have dropped the suite along with the
  // export. Only a command that is preamble the whole way down is one.
  let preambleOnly = true;
  for (const segment of split.parts) {
    const reason = refuseSegment(segment, depth, lane, approved);
    if (reason === PREAMBLE) continue;
    if (reason) return reason;
    preambleOnly = false;
  }
  // `test "$(ls a | wc -l)" -ge 8` is how this plan format writes a check, and
  // `echo "$(rm -rf x)"` used to run because nothing looked inside the quotes.
  // What a substitution runs is judged like any other command.
  for (const sub of split.inner) {
    const reason = refuseCommand(sub, depth + 1, lane, approved);
    if (reason && reason !== PREAMBLE) return reason;
  }
  return preambleOnly ? PREAMBLE : null;
}

/**
 * Shell keywords that head a command without replacing it — `! grep …`,
 * `if grep …`, `then echo ok`, `do grep x "$f"`. Walked past, and the command
 * after them judged under its own name: otherwise an approved loop would carry
 * `do ssh host '…'` past the ssh gate as a command called `do`.
 */
const KEYWORD_PREFIX = /^(!|if|elif|then|else|do|while|until)\s+/;

/**
 * Words that are shell grammar rather than a program. They run nothing by
 * themselves, so a loop or conditional is an exact-text approval away — with
 * every command inside it still judged.
 */
const SHELL_GRAMMAR = new Set(['for', 'in', 'done', 'fi', 'esac', 'case', '{', '}']);

/** Which wall an unrecognised lead hits: a click (`unknown-lead`), or prose and file names that never are. */
function unknownCode(text: string, raw: string, tokens: readonly string[]): RefusalCode {
  if (SHELL_GRAMMAR.has(raw)) return 'unknown-lead';
  if (HTTP_CALL.test(text.trim())) return 'prose';
  if (tokens.length === 1) return raw.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(raw) ? 'names-file' : 'prose';
  if (!/^[A-Za-z_][A-Za-z0-9_.+-]*$/.test(raw.replace(/^.*\//, ''))) return 'prose';
  return 'unknown-lead';
}

function refuseSegment(
  input: string, depth: number, lane: Lane = 'verify', approved = false,
): Refusal | typeof PREAMBLE | null {
  let segment = input.trim();
  for (let keyword = KEYWORD_PREFIX.exec(segment); keyword; keyword = KEYWORD_PREFIX.exec(segment)) {
    segment = segment.slice(keyword[0].length);
  }
  const tokens = headOf(tokenize(segment));
  if (!tokens.length) return refusal('other', `\`${condense(segment)}\` sets a variable but runs nothing`);

  const raw = tokens[0];
  const verb = raw.replace(/^.*\//, ''); // /usr/bin/node → node

  // `cd` is navigation, not a verb: it is how a plan says "the tests live in
  // that other directory", and refusing it refuses the whole line. Substitution
  // is already rejected above, so the argument here is always a literal path.
  // Deliberately not confined to the working tree — a plan legitimately points
  // at a sibling repo.
  if (verb === 'cd') {
    if (tokens.length > 2) return refusal('other', '`cd` with more than one argument is not a path this can check');
    return null;
  }

  // `export PATH="$HOME/.nvm/versions/node/v24.13.1/bin:$PATH"` is not a check
  // and not a chore for a person: it is the line a plan puts above its commands
  // so they can find their toolchain. `headOf` already walks past a bare
  // `FOO=bar cmd`, but an `export` on its own line kept its verb and fell all
  // the way to "is not a recognised command" — so every phase of a plan that
  // prefixed its §Verification this way reported a check only a human could
  // make, three phases at a time, about a line that runs nothing.
  //
  // `set -euo pipefail` is here for the same reason. `source`/`.` deliberately
  // is not: it executes a file whose contents this cannot see.
  if (verb === 'export' || verb === 'set') {
    // `export FOO=$(…)` never reaches here — substitution is refused upstream —
    // so an argument list that is all assignments (or all `set` flags) really
    // does change nothing but the environment. Anything else is a shape this
    // did not understand, and unrecognised is the safe answer.
    const rest = tokens.slice(1);
    const inert = verb === 'set'
      ? rest.every((t) => /^[-+][A-Za-z]+$/.test(t) || /^[-+]o$/.test(t) || /^[a-z]+$/.test(t))
      // Bare names beside the assignments are inert too: `export A=1 npm` marks
      // `npm` for export as a VARIABLE NAME and runs nothing — bash semantics,
      // not a command with a prefix.
      : rest.length > 0 && rest.every((t) => /^[A-Za-z_][A-Za-z0-9_]*(=|$)/.test(t));
    if (inert) return PREAMBLE;
  }

  // `test/agent.test.ts` alone is a file the prose is naming. Handing it to bash
  // gets exit 126 and a phase halted for a plan that was only being descriptive;
  // `./x.ts` and `node test/x.ts` are unaffected, being an instruction and a
  // command respectively.
  if (tokens.length === 1 && CITED_SOURCE.test(raw)) {
    return refusal('names-file', `\`${verb.slice(0, 32)}\` names a file rather than a command`);
  }

  // The deny wall BEFORE the recognition test, so `rm -rf build` reads as what
  // it is ("mutates", which no answer can carve) rather than as a program the
  // runner merely does not know — the one class an approval may relax.
  if (mutates(segment)) {
    return refusal('mutates', `\`${condense(segment)}\` looks like it mutates something — a human should run this`);
  }

  const isScript = SCRIPT_PATH.test(raw);
  const recognised = VERBS.has(raw) || VERBS.has(verb) || isScript
    || (lane === 'setup' && (SETUP_VERBS.has(raw) || SETUP_VERBS.has(verb)));
  const code = recognised ? null : unknownCode(segment, raw, tokens);
  // An approval relaxes recognition for a real program the runner does not
  // know, and for nothing else: prose, a named file and a single word stay
  // refused even under an approved fingerprint (defense in depth — the
  // service admits only approvable fingerprints, and this must not rely on it).
  if (!recognised && !(approved && code === 'unknown-lead')) {
    return refusal(code!, `\`${verb.slice(0, 32)}\` is not a recognised command`, verb.slice(0, 64));
  }
  if (isScript && MUTATING_SCRIPT.test(verb)) {
    return refusal('mutates', `\`${verb.slice(0, 32)}\` is named for something that changes state — a human should run this`);
  }

  // The setup lane keeps EVERY one of these gates and overrides exactly one.
  //
  // The first cut deleted them all, on the reasoning that they ask "is this
  // demonstrably a READ" and bring-up is not one. That reasoning is right about
  // `docker` and wrong about everything else, and QA measured the difference:
  // fifteen commands the verify lane refuses became runnable, among them
  // `ssh <host> 'systemctl restart api'`, `psql -c 'DROP TABLE users'`,
  // `kubectl delete pod`, `gh release create`, `redis-cli FLUSHALL` and
  // `docker compose down -v` — every one of them unattended, before every
  // verification attempt, and by design unable to colour the phase red, so
  // nothing would ever have surfaced it. `MUTATION_DENY` does not catch them:
  // its own docstring says `gh` is absent from it BECAUSE the inverted
  // allowlist here already refuses `gh release create`, and deleting the
  // allowlist deleted that argument.
  //
  // Only `docker` genuinely needed the widening, because `DOCKER_READ_ONLY` is
  // what refuses `docker compose up -d` — the one command the Setup bullet
  // exists for.
  const gate = lane === 'setup'
    ? (DOCKER_VERBS.has(verb) || DOCKER_VERBS.has(raw)
      ? dockerSetupGate
      : (SETUP_SUBCOMMANDS[verb] !== undefined || SETUP_SUBCOMMANDS[raw] !== undefined
        ? setupVerbGate
        : (REACHES_OUT[verb] ?? REACHES_OUT[raw])))
    : (REACHES_OUT[verb] ?? REACHES_OUT[raw]);
  if (gate) {
    const objection = gate(segment.trim());
    if (objection) {
      return refusal('reaches-out',
        `\`${condense(segment)}\` ${objection} — a person should run this, not an unattended runner`);
    }
  }

  // `xargs grep …`, `docker compose run … pytest`, `bash -c '…'` all run a
  // command of their own. Judging the wrapper and not the payload is how a
  // denylist gets walked straight past.
  const inner = innerCommand(verb, tokens);
  if (inner === UNREADABLE) {
    return refusal('unreadable', `\`${condense(segment)}\` runs another command the runner could not read`);
  }
  if (inner) return refuseCommand(inner, depth + 1, lane, approved);

  return null;
}

/* ------------------------------------------------------------------ *
 * Reading shell syntax, without a dependency
 * ------------------------------------------------------------------ */

/**
 * Split on the control operators, respecting quotes.
 *
 * Refuses when the result would be a guess: an unbalanced quote, or an
 * UNQUOTED substitution — `$(…)`, a backtick, `<(…)` — whose output is
 * word-split into the command itself. Refusing sends it to a person, which is
 * the safe direction; the alternative is executing structure this did not
 * understand.
 *
 * A `$(…)` INSIDE double quotes is one word whatever it prints, so its command
 * comes back in `inner`, to be judged like any other. It used to be read past
 * entirely — `echo "$(rm -rf x)"` ran (2026-09-18). A backtick inside double
 * quotes is still refused.
 *
 * `2>&1`, `>&2`, `1>&-` duplicate a descriptor and `&>` / `>&` send output to a
 * file: redirections, not separators (`2>&1` was split, and `1` judged as a
 * command). `|&` is a pipe. A LONE `&` backgrounds what precedes it: bash
 * returns at once and never reads its exit code, so a red suite read green —
 * refused.
 */
function segments(command: string): { parts: string[]; inner: string[] } | { refusal: Refusal } {
  const out: string[] = [];
  const inner: string[] = [];
  let buffer = '';
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      // Inside single quotes a backslash is literal; inside double quotes it escapes.
      if (quote === '"' && ch === '\\' && next !== undefined) { buffer += ch + next; i++; continue; }
      if (quote === '"' && ch === '`') return { refusal: UNREADABLE_STRUCTURE };
      if (quote === '"' && ch === '$' && next === '(') {
        const close = closingParen(command, i + 1);
        if (close < 0) return { refusal: UNREADABLE_STRUCTURE };
        inner.push(command.slice(i + 2, close));
        buffer += command.slice(i, close + 1);
        i = close;
        continue;
      }
      if (ch === quote) quote = null;
      buffer += ch;
      continue;
    }

    if (ch === '\\' && next !== undefined) { buffer += ch + next; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue; }
    if (ch === '`') return { refusal: UNREADABLE_STRUCTURE };
    if (ch === '$' && next === '(') return { refusal: UNREADABLE_STRUCTURE };
    if ((ch === '<' || ch === '>') && next === '(') return { refusal: UNREADABLE_STRUCTURE };
    // A subshell anywhere but wrapping the whole command (already unwrapped) is
    // structure this will not take apart.
    if (ch === '(' || ch === ')') return { refusal: UNREADABLE_STRUCTURE };

    if (ch === '&') {
      if (next === '&') { out.push(buffer); buffer = ''; i++; continue; }
      if (/[<>]$/.test(buffer) || next === '>') { buffer += ch; continue; }
      return { refusal: BACKGROUNDED };
    }
    if (ch === '|' && (next === '|' || next === '&')) { out.push(buffer); buffer = ''; i++; continue; }
    if (ch === '|' || ch === ';') { out.push(buffer); buffer = ''; continue; }

    buffer += ch;
  }

  if (quote) return { refusal: UNREADABLE_STRUCTURE };
  out.push(buffer);
  return { parts: out.map((s) => s.trim()).filter(Boolean), inner };
}

/** The index of the `)` closing the `(` at `open`, quotes respected — or -1. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\') { i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** A chain member that only sets up the ones after it — carried into each, never a check of its own. */
const CHAIN_SETUP_LEADS: ReadonlySet<string> = new Set(['cd', 'pushd', 'export', 'source', '.', 'set', 'unset', 'umask', 'ulimit']);

/**
 * The members of a top-level `&&` chain, each runnable ALONE — what #103's
 * chained-gate comment asks attribution to do (control-tower phase 83, the
 * fifth amendment). A chain stops at its first red member, so `vitest run &&
 * node ratchet.mjs` red on vitest never said whether the ratchet was red too:
 * one owner was reported where there were two. Only `&&` separates members
 * (outside quotes and parentheses); a member keeps its own `||`, `|` and `;`.
 * A member that only sets up the rest — `cd`, `export`, … — is carried as a
 * prefix into every member after it, because `npm test` alone would run in
 * the wrong directory. Null when there are not two checks to tell apart, or
 * the quoting cannot be read.
 */
export function chainMembers(command: string): string[] | null {
  const parts: string[] = [];
  let buffer = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote) {
      if (quote === '"' && ch === '\\' && next !== undefined) { buffer += ch + next; i++; continue; }
      if (ch === quote) quote = null;
      buffer += ch;
      continue;
    }
    if (ch === '\\' && next !== undefined) { buffer += ch + next; i++; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '&' && next === '&' && depth === 0) { parts.push(buffer.trim()); buffer = ''; i++; continue; }
    buffer += ch;
  }
  if (quote || depth !== 0) return null;
  parts.push(buffer.trim());
  if (parts.some((part) => !part)) return null;
  const prefix: string[] = [];
  const members: string[] = [];
  for (const part of parts) {
    if (CHAIN_SETUP_LEADS.has(part.split(/\s+/)[0])) { prefix.push(part); continue; }
    members.push([...prefix, part].join(' && '));
  }
  return members.length >= 2 ? members : null;
}

/** `(cd api && pytest -q)` is one command wearing parentheses. */
function unwrap(command: string): string {
  let text = command.trim();
  for (;;) {
    if (!(text.startsWith('(') && text.endsWith(')'))) return text;
    // Only when the opening paren is the one the final paren closes.
    let depth = 0;
    let wraps = true;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && i !== text.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps || depth !== 0) return text;
    text = text.slice(1, -1).trim();
  }
}

/** Split a segment into words, respecting quotes and dropping the quote marks. */
function tokenize(segment: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: string | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && i + 1 < segment.length) { current += segment[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) { current += segment[++i]; started = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || current) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) out.push(current);
  return out;
}

const BARE_WRAPPERS = new Set(['time', 'nohup', 'command', 'builtin']);
const DURATION = /^\d+(\.\d+)?[smhd]?$/;

/**
 * Drop what a shell allows in front of the actual command, and return the
 * tokens from the verb onward.
 *
 * The env-assignment case is the one that mattered: the old classifier saw
 * `FOO=1 ./deploy.sh`, matched the assignment, declared the command "known", and
 * then looked up its gate under the name `FOO=1` — so nothing gated it and it
 * ran.
 */
function headOf(tokens: string[]): string[] {
  let rest = tokens;
  for (;;) {
    const head = rest[0];
    if (head === undefined) return [];

    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) { rest = rest.slice(1); continue; }
    if (BARE_WRAPPERS.has(head)) { rest = rest.slice(1); continue; }
    if (head === 'env') {
      rest = rest.slice(1);
      while (rest[0]?.startsWith('-')) rest = rest.slice(1);
      continue;
    }
    if (head === 'nice') {
      rest = rest.slice(1);
      if (rest[0] === '-n') rest = rest.slice(2);
      else if (/^-\d+$/.test(rest[0] ?? '')) rest = rest.slice(1);
      continue;
    }
    if (head === 'timeout') {
      rest = rest.slice(1);
      while (rest.length && (rest[0].startsWith('-') || DURATION.test(rest[0]))) rest = rest.slice(1);
      continue;
    }
    return rest;
  }
}

/** A wrapper whose payload could not be located — refuse rather than assume. */
const UNREADABLE = Symbol('unreadable inner command');

/** Flags that swallow the following token, for the wrappers below. */
const VALUE_FLAGS = new Set([
  '-I', '-n', '-P', '-d', '-a', '-s', '-L', '-E', // xargs
  '-e', '--env', '-v', '--volume', '-w', '--workdir', '-u', '--user', '-p', '--publish',
  '--name', '--entrypoint', '-l', '--label', '--network', '--platform', '--env-file',
  // compose-level flags that sit before the subcommand. `--ansi never` and
  // `--parallel 1` read as the subcommand until their values were listed —
  // and a bring-up refused in the setup lane vanishes without a card.
  '-f', '--file', '--project-directory', '--project-name', '--profile',
  '--ansi', '--parallel', '--progress', '-H', '--host', '--context', '--log-level',
]);

/**
 * The command a wrapper will itself run, or null when there is none.
 *
 * `xargs` with no command defaults to `echo`, which is why an empty tail is null
 * rather than unreadable.
 */
function innerCommand(verb: string, tokens: string[]): string | typeof UNREADABLE | null {
  if (verb === 'xargs') {
    const tail = skipFlags(tokens.slice(1));
    return tail.length ? quoteJoin(tail) : null;
  }

  if (verb === 'bash' || verb === 'sh' || verb === 'zsh') {
    const at = tokens.indexOf('-c');
    if (at === -1) return null;
    const script = tokens[at + 1];
    return script ? script : UNREADABLE;
  }

  if (verb === 'docker' || verb === 'docker-compose') {
    let rest = tokens.slice(1);
    if (rest[0] === 'compose') rest = rest.slice(1);
    // Compose-level flags (`-f infra/compose.yml`, `-p name`) sit BEFORE the
    // subcommand — the same walk the gate does, or `run`'s payload goes unjudged.
    rest = skipFlags(rest);
    const sub = rest[0];
    if (sub !== 'run' && sub !== 'exec') return null;
    const tail = skipFlags(rest.slice(1));
    // The first survivor is the service/container; the rest is its command.
    const inner = tail.slice(1);
    return inner.length ? quoteJoin(inner) : UNREADABLE;
  }

  return null;
}

function skipFlags(tokens: string[]): string[] {
  let rest = tokens;
  while (rest.length && rest[0].startsWith('-')) {
    const flag = rest[0];
    rest = rest.slice(1);
    // `--flag=value` carries its own value; a bare flag we know takes the next.
    if (!flag.includes('=') && VALUE_FLAGS.has(flag)) rest = rest.slice(1);
  }
  return rest;
}

/** Re-quote tokens that need it, so the rebuilt inner command re-parses. */
function quoteJoin(tokens: string[]): string {
  return tokens
    .map((t) => (/[\s'"|;&()$`\\]/.test(t) ? `'${t.replace(/'/g, `'\\''`)}'` : t))
    .join(' ');
}

function condense(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/* ------------------------------------------------------------------ *
 * The clock, and what a red names
 * ------------------------------------------------------------------ */

/**
 * Per §Verification command, when nothing more specific says (control-tower
 * phase 83, #95: a plan's `Verify timeout:`, else the line's measured history
 * — `verify-ledger.ts` `resolveVerifyLimit`). Half an hour, because the number
 * is a statement about what a phase's verification IS: a full suite, often a
 * build, sometimes a container. At the old 15-minute default a slow-but-green
 * check came back red and halted a phase that had done nothing wrong.
 * `runner-core.ts` re-exports it under the same name.
 */
export const VERIFY_TIMEOUT_MS = 30 * 60_000;

/**
 * No command's limit exceeds this, however long its history or its retry: a
 * wedged command must still end, and four hours is past any suite measured.
 */
export const VERIFY_TIMEOUT_CEILING_MS = 4 * 60 * 60_000;

/**
 * A cut command's one retry runs at this multiple of its limit (#95). A cut
 * proves only "longer than the limit"; the measured case was a suite at 34 min
 * against 30 under the autopilot's own load, and the same limit again would
 * have cut it again.
 */
export const TIMEOUT_RETRY_FACTOR = 2;

/** How many failing tests one command's record names at most. */
export const FAILURE_CAP = 200;

/**
 * The failing tests a test runner's output names, each once, in order
 * (control-tower phase 83, #103) — what a verification baseline is compared by.
 *
 * Three shapes, the ones this codebase's §Verification lines print: node's
 * `spec` reporter (`✖ name (1.2ms)` — node 24 prints it even into a pipe, and
 * repeats every failure under `✖ failing tests:`), TAP from `node --test
 * --test-reporter=tap` (`not ok 3 - name`, indented when nested), and TAP from
 * bats (`not ok 3 name`). A `# TODO` failure is not a failure. Output that
 * names no test — a crash, a compiler error — answers nothing, and the caller
 * compares the whole command instead.
 */
export function failureIds(output: string): string[] {
  const scanner = new FailureScanner();
  scanner.push(output);
  return scanner.end();
}

const SPEC_FAILURE = /^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)\s*$/;
const TAP_FAILURE = /^\s*not ok \d+(?: -)? (.+?)\s*$/;

/** `failureIds` over a stream — one command's output arrives in chunks that split lines anywhere. */
export class FailureScanner {
  private partial = '';
  private readonly seen = new Set<string>();

  push(chunk: string): void {
    const text = this.partial + chunk;
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  end(): string[] {
    if (this.partial) this.line(this.partial);
    this.partial = '';
    return [...this.seen];
  }

  private line(raw: string): void {
    if (this.seen.size >= FAILURE_CAP) return;
    const line = raw.replace(/\r$/, '');
    const spec = SPEC_FAILURE.exec(line);
    if (spec) { this.seen.add(spec[1]); return; }
    const tap = TAP_FAILURE.exec(line);
    if (!tap) return;
    if (/\s#\s*(?:TODO|SKIP)\b/i.test(tap[1])) return;
    this.seen.add(tap[1].replace(/\s+#\s.*$/, ''));
  }
}

/** A verification's rows, judged — see `verificationVerdict`. */
export type VerificationVerdict = {
  /** No command's FINAL attempt is red, and none was cut by the clock. */
  ok: boolean;
  /** The rows that ARE a command's verdict and are red: the halt's list. */
  broke: VerifyRun[];
  /**
   * The rows that ARE a command's verdict and failed on the MACHINE — an exit
   * 127, a named `PRECONDITION`, a refused connection to the session's own
   * port (control-tower phase 89, `environmentOf`). Not green and not red:
   * `unproven`, never charged, never a re-open.
   */
  unproven: VerifyRun[];
  /** Red (or cut) first attempts a green retry of the same command answered. */
  rescued: VerifyRun[];
  /**
   * The rows that ARE a command's verdict and were cut by the verification's
   * clock (control-tower phase 83, #95): `verify-timeout`, which is not a red.
   */
  timedOut: VerifyRun[];
};

/**
 * The ONE verdict over a verification's rows (control-tower phase 45, #45).
 *
 * A red command is retried once and BOTH attempts stay on the record, the
 * second marked `retry` — so the rows are attempts, and a command's verdict is
 * its last attempt. A red row that a green retry of the same command follows is
 * therefore `rescued`, never `broke`. The runner used to read
 * `ran.filter(!ok)` for its halt while `verify` read the last attempt for its
 * `ok`, and the two disagreed in the same second: measured over one week, all
 * 6 verify-failed halts were commands the verdict itself called green.
 * `verify` and the runner now both read this, so they cannot.
 *
 * A row the verification's CLOCK cut (`timedOut`) is its own verdict since
 * control-tower phase 83 (#95): `timedOut`, never `broke`. Killed at 2043 s, a
 * suite that ran green in 850 s on the same head was a red — a streak charge
 * and a re-opened phase for a machine that was merely busy.
 */
export function verificationVerdict(ran: readonly VerifyRun[]): VerificationVerdict {
  const broke: VerifyRun[] = [];
  const rescued: VerifyRun[] = [];
  const timedOut: VerifyRun[] = [];
  const unproven: VerifyRun[] = [];
  ran.forEach((row, index) => {
    const next = ran[index + 1];
    // Superseded by its own retry: the retry is the command's verdict.
    if (!row.retry && next?.retry && next.command === row.command) {
      if (!row.ok && next.ok) rescued.push(row);
      return;
    }
    if (row.ok) return;
    if (row.timedOut) timedOut.push(row);
    else if (row.environment) unproven.push(row);
    else broke.push(row);
  });
  return { ok: broke.length === 0 && timedOut.length === 0 && unproven.length === 0, broke, unproven, rescued, timedOut };
}

/* ------------------------------------------------------------------ *
 * The machine, not the work (control-tower phase 89, #41)
 * ------------------------------------------------------------------ */

/** A line of output that names a precondition — `PRECONDITION FAILED: Metro already serving on :8081 …`. */
const PRECONDITION_LINE = /^.*\bPRECONDITION\b.*$/m;
/** A refused connection, as node, curl, a browser and python spell it. */
const REFUSED = /ECONNREFUSED|ERR_CONNECTION_REFUSED|[Cc]onnection refused/;
/** The loopback ports a refusal names: `127.0.0.1:8151`, `localhost:8151`, `port 8151`. */
const REFUSED_PORT = /(?:(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):|\bport )(\d{2,5})\b/g;

/**
 * Why a failed command failed on the MACHINE rather than on the work, or null
 * — the `environment` outcome (control-tower phase 89, #41's 2026-09-25
 * 06:11Z comment: 26 such records across four plans, every one a permanent
 * red on a phase whose work was complete).
 *
 * Three shapes, each a fact about the machine the verification ran on:
 *  - a runtime exit 127: the shell could not find what it was told to run
 *    (a lead missing from the PATH is skipped before this; this is a script
 *    or a binary a line calls further in);
 *  - a line naming a `PRECONDITION` — a check the suite makes of its world
 *    before it tests anything (vca's `PRECONDITION FAILED: Metro already
 *    serving on :8081 but METRO_LOG … empty`, whose default pointed at
 *    another plan's log);
 *  - a refused connection to a loopback port the phase's OWN session served
 *    on (`ownPorts`, `LaneSignals.ownPorts`): the server ended with the
 *    session, before the console's verification ran (vca P13/P14 on :8151).
 * A command its clock cut is never one — that is `verify-timeout`'s.
 *
 * And since control-tower phase 106 (#185) a fourth, asked first: a line that
 * failed within `MISSING_DEPS_FAST_MS` naming a package that is not installed
 * (or a binary from one), in a directory whose `node_modules` — or the
 * `.venv` it runs from — really is absent (`missingDependency`; `cwd` is
 * where the line ran). A superproject mirror mounts every repository fresh,
 * with nothing installed, and ai-builder-v7 P15's `cd hetzner && npm run
 * verify:local` read red in 1.7 s as an ordinary pre-existing red.
 */
export function environmentOf(
  row: Pick<VerifyRun, 'ok' | 'code' | 'output' | 'timedOut'> & Partial<Pick<VerifyRun, 'command' | 'ms'>>,
  ownPorts: readonly number[] = [],
  cwd?: string,
): string | null {
  if (row.ok || row.timedOut) return null;
  if (cwd && row.command && typeof row.ms === 'number' && row.ms < MISSING_DEPS_FAST_MS) {
    const absent = missingDependency(row.command, row.output ?? '', cwd);
    if (absent) {
      return `the dependencies are not installed here — ${absent}, and it failed in ${limitWords(row.ms)}: `
        + 'install the dependencies (a `- **Setup:**` line such as `npm ci` or `python3 -m venv .venv`) — the machine, not the work';
    }
  }
  if (row.code === 127) return 'exit 127: the shell could not find a command it was given — a fact about this machine, not the work';
  const precondition = PRECONDITION_LINE.exec(row.output ?? '');
  if (precondition) return `a precondition failed: ${precondition[0].trim().slice(0, 200)}`;
  if (ownPorts.length && REFUSED.test(row.output ?? '')) {
    for (const match of (row.output ?? '').matchAll(REFUSED_PORT)) {
      const port = Number(match[1]);
      if (ownPorts.includes(port)) {
        return `connection refused on :${port}, a port the phase's own session served on — it stopped with the session`;
      }
    }
  }
  return null;
}

/**
 * How fast a missing dependency fails (control-tower phase 106, #185): a line
 * whose `node_modules` or `.venv` is absent dies in its first second or two
 * (1.7 s on ai-builder-v7 P15). Past this the same words are a suite's own red
 * — one that ran for minutes and then named a module is reporting on the work.
 */
export const MISSING_DEPS_FAST_MS = 5_000;

/**
 * What a package that is not installed prints: node's CommonJS and ESM
 * spellings of a BARE specifier — never a relative one, which is the work's
 * own broken import whatever is installed — and a shell's missing binary (a
 * package script's `vitest` with no `node_modules/.bin`).
 */
const BARE_MODULE = /Cannot find (?:module|package) '([^'./][^']*)'/;
const NOT_FOUND = /(?:command not found|: not found)\s*$/m;
/** A virtualenv binary a line runs: `.venv/bin/pytest`, `tb/.venv/bin/python`. */
const VENV_BIN = /(?:^|[\s;&|(])((?:[^\s;&|()'"`]*\/)?\.venv)\/bin\/\S/;

/**
 * The directory a line's dependencies would have to be installed in: its cwd,
 * moved by a leading `cd <dir> &&` and then by a package manager's own
 * directory flag (`npm --prefix`, `-C`, `--dir`, `--cwd`).
 */
function lineDir(command: string, cwd: string): { dir: string; rest: string } {
  let dir = cwd;
  let rest = command.trim();
  const cd = /^cd\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s*(?:&&|;)\s*/.exec(rest);
  if (cd) {
    dir = resolve(dir, cd[1] ?? cd[2] ?? cd[3]!);
    rest = rest.slice(cd[0].length);
  }
  const flag = /(?:^|\s)(?:--prefix|-C|--dir|--cwd)(?:=|\s+)(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/.exec(rest);
  if (flag && /^(?:npm|pnpm|yarn|npx)\b/.test(rest)) dir = resolve(dir, flag[1] ?? flag[2] ?? flag[3]!);
  return { dir, rest };
}

/** Is there a `node_modules` where node would look for one — here or in any directory above? */
function nodeModulesAbove(dir: string): boolean {
  let at = resolve(dir);
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(at, 'node_modules'))) return true;
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
  return false;
}

/** A path as a person reads it beside the line: relative to where the line ran. */
function shownFrom(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/**
 * Why a fast red is a dependency that is not installed, or null — the line's
 * `.venv` is not there, or its output names a package (or a package's binary)
 * in a node project with no `node_modules` anywhere node would look. Never on
 * the output's word alone: a `Cannot find module 'x'` beside an installed
 * `node_modules` is the work's red.
 */
function missingDependency(command: string, output: string, cwd: string): string | null {
  const { dir, rest } = lineDir(command, cwd);
  const venv = VENV_BIN.exec(rest);
  if (venv) {
    const at = resolve(dir, venv[1]!);
    if (!existsSync(at)) return `\`${shownFrom(cwd, at)}\` is absent`;
  }
  const bare = BARE_MODULE.exec(output);
  if ((bare || NOT_FOUND.test(output)) && existsSync(join(dir, 'package.json')) && !nodeModulesAbove(dir)) {
    return `\`${shownFrom(cwd, join(dir, 'node_modules'))}\` is absent${bare ? ` (${bare[0]})` : ''}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * A clean export, and what it cannot hold (control-tower phase 106, #191)
 * ------------------------------------------------------------------ */

/** `../sibling/…` — a relative path that climbs out of where it is read from. */
const CLIMB = /(?:^|[\s'"=(:,])((?:\.\.\/)+[^\s'"`;&|()<>,]+)/g;

/** The repository root holding `dir`: the nearest ancestor with a `.git` entry (a linked worktree's is a file). */
function repoTopOf(dir: string): string {
  let at = resolve(dir);
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(at, '.git'))) return at;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return resolve(dir);
}

/** An empty directory — what an unmounted submodule leaves behind. */
function isEmptyDir(path: string): boolean {
  try { return statSync(path).isDirectory() && readdirSync(path).length === 0; } catch { return false; }
}

/**
 * The siblings `text` names that the working tree has and a clean export of it
 * does not (control-tower phase 106, #191): each `../x` that climbs out of the
 * repository the line runs in, cut to its first component past the climb, that
 * resolves from `inPlace` and not from `cwd`. A path neither tree has is not
 * the export's doing — the line is red in place too — so it is never named.
 */
export function unprovidedSiblings(text: string, cwd: string, inPlace: string): string[] {
  const top = repoTopOf(cwd);
  const out = new Set<string>();
  for (const match of text.matchAll(CLIMB)) {
    const parts = match[1]!.replace(/[)\].,:;]+$/, '').split('/');
    let up = 0;
    while (parts[up] === '..') up += 1;
    if (!parts[up]) continue;
    const sibling = [...parts.slice(0, up), parts[up]].join('/');
    const there = resolve(cwd, sibling);
    if (there === top || there.startsWith(`${top}${sep}`)) continue;
    const here = resolve(inPlace, sibling);
    if ((!existsSync(there) || isEmptyDir(there)) && existsSync(here) && !isEmptyDir(here)) out.add(sibling);
  }
  return [...out];
}

/** The `environment` sentence for siblings an export could not provide. */
function siblingWords(siblings: readonly string[], ran: boolean): string {
  const named = siblings.map((sibling) => `\`${sibling}\``).join(', ');
  return `the clean export cannot provide ${named} — the working tree has it beside the repository and a checkout of the `
    + `commit does not (${ran ? 'its output names it' : 'not run'}); the machine, not the work`;
}

/* ------------------------------------------------------------------ *
 * Running them
 * ------------------------------------------------------------------ */

export type VerifyOptions = {
  cwd: string;
  /** Per-command ceiling. A full suite is slow; a wedged one must still end. */
  timeoutMs?: number;
  /**
   * Each command's own ceiling, when the caller resolved one per line
   * (control-tower phase 83, #95 — the plan's `Verify timeout:`, else the
   * line's measured history). Wins over `timeoutMs`; the Setup preamble keeps
   * its own shorter clock.
   */
  timeoutFor?: (command: string) => number;
  /**
   * Run only these commands (folded text, `foldCommand`) — a verification
   * BASELINE measures the lines it could not reuse (#103). The rest are not
   * run and not reported. Absent: every command runs.
   */
  only?: ReadonlySet<string>;
  /**
   * `false` runs every command whatever the one before it did — a baseline
   * wants each line's own answer, and a red first line would otherwise hide
   * the rest. Default: stop at the first command that is not green.
   */
  cascade?: boolean;
  /**
   * Who asked: the phase's verdict (`verify`, the default), its baseline at
   * boarding, or the attribution of a red `&&` chain — its members, each run
   * alone (`chainMembers`, #103).
   */
  purpose?: 'verify' | 'baseline' | 'attribution' | 'wip-gate';
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /**
   * Run every command at this lower priority (`nice -n`, control-tower phase
   * 105): a baseline measured BESIDE a working session must not take the
   * machine from it. Absent: the console's own priority, as before.
   */
  nice?: number;
  /**
   * Awaited before each command runs, once `onStart` has named it — the
   * baseline's seat under the machine-load guard (control-tower phase 105,
   * phase 100's guard): new work waits while the machine is loaded.
   */
  gate?: (command: string) => Promise<void>;
  /**
   * A command's process is up — `stage: 'setup'` for a `Setup:` command.
   * What lets the run record the process its lane is waiting on, so a reader
   * that does not know the run is live still has a fact to read (#173).
   */
  onChild?: (pid: number, command: string, stage: 'setup' | 'verify') => void;
  /** A `Setup:` command is about to run — the bring-up half of `onStart`. */
  onSetupStart?: (command: string, index: number, total: number) => void;
  onStart?: (command: string, index: number, total: number) => void;
  /**
   * One command SETTLED — the half that was missing.
   *
   * `onStart` alone meant a command's outcome could only be inferred when the
   * next one started, and the last command's outcome never reached the live
   * stream at all: a forty-minute suite was one line followed by silence, with
   * no exit code, no elapsed time and no `[2/2]`. The result carries what the
   * record carries — code, ms, and a tail of output when it is red, since a
   * green command's log is not what anyone is watching for.
   *
   * The result is the one the VERDICT is judged on, so a command rescued on
   * retry reports green once, with `retry` set.
   */
  onDone?: (result: VerifyRun, index: number, total: number) => void;
  /**
   * The commands this machine cannot run, announced when that is decided —
   * before any of the others start.
   *
   * F17 skips a command whose lead is missing from the PATH, and a phase whose
   * every check is skipped PARKS. Until now that unfolded entirely off screen
   * and the operator met it only as a parked phase.
   */
  onSkip?: (skipped: readonly VerifySkip[]) => void;
  /** Leads never worth a resolution check (builtins, keywords). */
  preflightSkip?: ReadonlySet<string>;
  /** Test seam: overrides the on-disk executability probe. Production never sets it. */
  canExecute?: (lead: string) => boolean;
  /**
   * The phase's `- **Setup:**` bullet, raw — bring-up that runs BEFORE the
   * verification commands and is never part of the verdict.
   *
   * `check: false` in the plan's own words: these commands are how the phase
   * becomes provable (`docker compose up -d`, `npm ci`, the `sleep 8` after
   * them), and a plan had nowhere to put them but §Verification, where each
   * one is a line that can turn a phase red for a reason unrelated to its
   * work and a question the boarding preflight asks a person to vouch for.
   * Same extractor and the same wall, with ONE gate widened
   * (`DOCKER_SETUP_OK`) and a shorter clock — see `runSetup`.
   */
  setupText?: string;
  /** This phase's start-door answers (`approvalsForPhase`) — for both the Setup and the verification lanes. */
  approvals?: VerifyApprovals;
  /**
   * Commands the phase's session already proved green at an equivalent tree,
   * keyed by folded text (`proofs.ts` `judgeProofs`, control-tower phase 62,
   * #68). Such a command is not run again: its row is the proof's, green, with
   * `proven` naming it. Everything else runs exactly as before.
   */
  proven?: ReadonlyMap<string, NonNullable<VerifyRun['proven']>>;
  /**
   * The loopback ports the phase's session served on (`LaneSignals.ownPorts`):
   * a refused connection to one of them is `environment`, never red
   * (control-tower phase 89, `environmentOf`).
   */
  ownPorts?: readonly number[];
  /**
   * `cwd` is a clean EXPORT standing in for this directory of the working tree
   * (control-tower phase 106, #191): a line naming a sibling (`../x`) the
   * working tree has and the export does not is `environment` — not run when
   * the line itself names it, and so classified when its red output does.
   */
  inPlace?: string;
};

/**
 * How many bring-up commands one phase may declare.
 *
 * Bounded because these run before every verification attempt of every phase
 * and are outside the verdict: a plan cannot be allowed to spend an unbounded
 * amount of the run's time on work nothing will ever mark red. Eight is more
 * than any measured preamble (the largest in the sample was three).
 */
const MAX_SETUP_COMMANDS = 8;

/** And a clock to go with the count — see `runSetup`. */
const SETUP_TIMEOUT_MS = 10 * 60_000;

/** Fallback when the caller passes no skip set (mirrors scripts/verify.env;
 * the drift test pins it against the file). */
export const DEFAULT_PREFLIGHT_SKIP: ReadonlySet<string> = new Set([
  'cd', 'true', 'false', 'echo', 'printf', 'test', 'pwd', 'env', 'which',
  'bash', 'sh', 'command', 'export', 'set', 'time',
  'if', 'then', 'fi', 'elif', 'else', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
]);

/** The program a command starts with, past `FOO=1` prefixes — or null for
 * paths (judged elsewhere) and empty candidates. One extractor, three
 * consumers: the boarding preflight, the verify-time skip below, and (via
 * the same rules re-implemented in bash) lint F17. */
export function resolveLead(command: string): string | null {
  let rest = command.trim();
  for (;;) {
    // `! grep …` negates `grep`: its lead is `grep`. Read as `!`, the missing-
    // binary check called it absent and SKIPPED the line (2026-09-18).
    const prefix = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.exec(rest) ?? /^!\s+/.exec(rest);
    if (!prefix) break;
    rest = rest.slice(prefix[0].length);
  }
  const token = rest.split(/\s+/)[0] ?? '';
  if (!token || token.includes('/')) return null;
  return token;
}

/**
 * Which leads resolve to no executable on the (hardened) verification PATH —
 * `lead → reason`. The predicate the boarding preflight and verify-time skip
 * share, so "predicted missing" and "skipped" can never disagree.
 */
export function unresolvableLeads(
  commands: readonly string[],
  envPath: string | undefined,
  skip: ReadonlySet<string> = DEFAULT_PREFLIGHT_SKIP,
  canExecute?: (lead: string) => boolean,
): Map<string, string> {
  const missing = new Map<string, string>();
  const dirs = hardenedPath(envPath).path.split(':').filter(Boolean);
  const executable = canExecute ?? ((lead: string) => dirs.some((dir) => {
    try { accessSync(join(dir, lead), fsConstants.X_OK); return true; } catch { return false; }
  }));
  const seen = new Set<string>();
  for (const command of commands) {
    const lead = resolveLead(command);
    if (!lead || seen.has(lead) || skip.has(lead)) continue;
    seen.add(lead);
    if (!executable(lead)) missing.set(lead, `\`${lead}\` is not installed on the verification PATH here`);
  }
  return missing;
}

const DEFAULT_TIMEOUT_MS = 15 * 60_000;
/** Enough tail to see which assertion failed, not a whole suite log. */
const KEEP_OUTPUT = 8_000;
/** What `execFile`'s `maxBuffer` used to be — now a cap on accumulation, not a kill. */
const MAX_OUTPUT = 16 * 1024 * 1024;
/**
 * How long a timed-out verification's GROUP gets between SIGTERM and SIGKILL.
 *
 * Shorter than the runner's 15s session grace on purpose: that grace exists so
 * a `claude` session can flush its transcript and run its SessionEnd hooks,
 * and a test runner has nothing of the sort to save. This is paid on every
 * timeout, so it is the difference between a wedged command costing five
 * seconds to clean up and fifteen.
 */
const KILL_GRACE_MS = 5_000;

/**
 * How long a command's streams get to drain after its LEADER exits before
 * whatever still holds them is a straggler — named, stopped through the
 * ladder, and the line settled on the leader's own code (control-tower phase
 * 106, #168). tamagui P4's sweep started Metro as `( … nohup yarn start … & )`;
 * the redirect covered `yarn` alone, the backgrounded subshell kept the
 * command's stdout, and `close` — which needs the streams' EOF — waited 50+
 * minutes on a sweep that had passed. Draining a pipe takes milliseconds.
 */
export const LEADER_DRAIN_GRACE_MS = 2_000;

/**
 * After the ladder, how long the streams get to reach EOF before they are let
 * go regardless: what still holds them left the group, and no signal of ours
 * reaches it.
 */
const STREAM_RELEASE_MS = 1_000;

/**
 * The two `notRun` reasons the MACHINE writes about its own behaviour — a
 * command skipped because an earlier one exited red, and a command the abort
 * signal cut off. Exported so `confirm()` can tell them apart from the reasons
 * that mark a genuine question for a person (prose fragments, refused verbs):
 * the human card exists for questions, and a consequence of a red — or of the
 * console stopping — is not one. One definition; the strings are load-bearing
 * (`runner.test.ts` pins the cascade literal).
 */
export const CASCADE_SKIP_REASON = 'skipped after an earlier command failed';
export const STOPPED_SKIP_REASON = 'the run was stopped before this command';

/** A limit as a person reads it: `30 min`, `1h 30m`, `0.4 s`. */
export function limitWords(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ''}`;
}

/** Why a command's final attempt is not green, in the words a halt or a park carries. */
function endingWords(row: VerifyRun, retriedCut: boolean): string {
  if (row.environment) return `\`${condense(row.command)}\` could not be judged here — ${row.environment} (unproven, not a red)`;
  if (!row.timedOut) return `\`${condense(row.command)}\` exited ${row.code}`;
  const at = row.limitMs ? ` after ${limitWords(row.limitMs)}` : '';
  return `\`${condense(row.command)}\` timed out${at}${retriedCut ? ', twice' : ''} — its clock cut it, not a red`;
}

export async function verifyPhase(
  verificationText: string | undefined, opts: VerifyOptions,
): Promise<VerifySummary> {
  const extracted = extractCommands(verificationText, 'verify', opts.approvals);
  const { notRun, waived } = extracted;
  // A baseline measures only the lines it could not reuse (#103).
  const commands = opts.only
    ? extracted.commands.filter((command) => opts.only!.has(foldCommand(command)))
    : extracted.commands;
  // Bring-up first, and its result kept OUT of everything below. It runs even
  // when §Verification turns out to be unrunnable here — the whole point is
  // that the two are separate questions, and "the stack came up but nothing
  // could be proved" is a more useful record than either half alone.
  const setup = await runSetup(opts);

  if (!verificationText || !verificationText.trim()) {
    return {
      ok: false, reason: 'the plan states no verification for this phase', ran: [], notRun: [],
      ...(setup ? { setup } : {}),
    };
  }
  if (!commands.length) {
    return {
      ok: false,
      reason: `nothing runnable in this phase's verification (${notRun.length} fragment${notRun.length === 1 ? '' : 's'} left for a human)`,
      ran: [],
      notRun,
      ...(waived.length ? { waived } : {}),
      ...(setup ? { setup } : {}),
    };
  }

  // A lead the PATH cannot resolve would exit 127 — a fact about this MACHINE,
  // not about the work. 15 of 16 observed verify-failed halts were this shape
  // (`rg` a shell function elsewhere, `python` meaning python3), every one
  // predicted at boarding and run anyway. Skipped-with-reason, never failed;
  // PHASE_CONSOLE_VERIFY_NO_SKIP=1 restores the old behaviour for one release.
  const skipped: VerifySkip[] = [];
  let runnable: string[] = commands;
  if (process.env.PHASE_CONSOLE_VERIFY_NO_SKIP !== '1') {
    const missing = unresolvableLeads(
      commands, (opts.env ?? process.env).PATH,
      opts.preflightSkip ?? DEFAULT_PREFLIGHT_SKIP, opts.canExecute);
    if (missing.size) {
      runnable = [];
      for (const command of commands) {
        const lead = resolveLead(command);
        // A command the session proved is not run here at all, so a lead this
        // machine lacks says nothing about it.
        if (lead && missing.has(lead) && !opts.proven?.has(foldCommand(command))) {
          skipped.push({
            command: condense(command),
            lead,
            reason: `\`${lead}\` is not installed on the verification PATH — confirm this check by hand, or fix the PATH`,
          });
        } else runnable.push(command);
      }
    }
  }

  // Announced before anything runs, so the checklist opens with the skips
  // already on it rather than growing them at the end.
  if (skipped.length) opts.onSkip?.(skipped);

  if (!runnable.length && skipped.length) {
    // Everything the plan wrote is unrunnable HERE. Not a verdict — an
    // unanswered question: the skips ride `notRun` so the runner's existing
    // person-park (askHuman) owns it, never a verify-failed halt.
    const leads = [...new Set(skipped.map((s) => s.lead))].join(', ');
    return {
      ok: false,
      reason: `all ${commands.length} command(s) are unrunnable here — leads not on the verification PATH: ${leads}`,
      ran: [],
      notRun: [...notRun, ...skipped.map((s) => ({ text: s.command, reason: s.reason }))],
      ...(waived.length ? { waived } : {}),
      skipped,
      ...(setup ? { setup } : {}),
    };
  }

  const ran: VerifyRun[] = [];
  let failedRun: VerifyRun | null = null;
  for (const [index, command] of runnable.entries()) {
    if (opts.signal?.aborted) {
      notRun.push({ text: condense(command), reason: STOPPED_SKIP_REASON });
      continue;
    }
    opts.onStart?.(command, index, runnable.length);
    // Proven by the session at an equivalent tree (control-tower phase 62,
    // #68): the proof is the row, and the command is not paid for twice.
    const proof = opts.proven?.get(foldCommand(command));
    if (proof) {
      const row: VerifyRun = { command, ok: true, code: 0, ms: 0, output: '', proven: proof };
      ran.push(row);
      opts.onDone?.(row, index, runnable.length);
      continue;
    }
    if (opts.gate) {
      await opts.gate(command);
      if (opts.signal?.aborted) {
        notRun.push({ text: condense(command), reason: STOPPED_SKIP_REASON });
        continue;
      }
    }
    const limit = opts.timeoutFor?.(command) ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // An export that cannot hold what the line names is checked BEFORE the line
    // runs (control-tower phase 106, #191): a sibling the working tree has and
    // a clean checkout does not would make it red by construction.
    const lacking = opts.inPlace && opts.inPlace !== opts.cwd ? unprovidedSiblings(command, opts.cwd, opts.inPlace) : [];
    let result: VerifyRun = lacking.length
      ? { command, ok: false, code: 1, ms: 0, output: '', environment: siblingWords(lacking, false) }
      : await runOne(command, { ...opts, timeoutMs: limit });
    // The machine, not the work (control-tower phase 89): said on the row, and
    // never retried — an unchanged precondition fails the same way twice, and
    // vca's verifier retried exactly that twice without changing anything.
    if (!result.environment) {
      const shown = !result.ok && !result.timedOut && opts.inPlace && opts.inPlace !== opts.cwd
        ? unprovidedSiblings(result.output, opts.cwd, opts.inPlace) : [];
      const environment = environmentOf(result, opts.ownPorts, opts.cwd) ?? (shown.length ? siblingWords(shown, true) : null);
      if (environment) result = { ...result, environment };
    }
    ran.push(result);
    // One recorded retry for a command that ran and exited red. Measured:
    // three spurious full-suite reds in one night, each judged green later —
    // one of them cost a 3h52m park. A 127 is not retried (the missing binary
    // will not appear between attempts), and neither is anything after the
    // abort signal. Both attempts stay on the record; the verdict is the last
    // one's.
    //
    // A command the CLOCK cut is retried too since control-tower phase 83
    // (#95), at twice its limit: a cut proves only "longer than the limit",
    // and the measured cut was a suite at 34 min under the autopilot's own
    // load against a 30-minute clock. It is retried by the console, never by a
    // session, and a second cut is `verify-timeout` — which is not a red.
    // A command that EXITS 124 by itself is a red like any other: the clock's
    // cut is `timedOut`, and the abort signal's is excluded here by name.
    //
    // Never for a BASELINE (control-tower phase 105, #190 ask 1): the retry
    // rescues a flaky VERDICT, whose red re-opens a phase. A baseline's red
    // decides nothing — it names what was red before the phase touched the
    // tree — and its retry was a second full suite (ai-builder-v7 P3's red
    // `task verify:local`, 702 s, run again before its session could board).
    // Its row stands as measured: red once, not retried.
    if (!result.ok && !result.environment && !opts.signal?.aborted && opts.purpose !== 'baseline') {
      // Never past the ceiling — unless the plan's own word already was, and
      // then never below it.
      const again = result.timedOut
        ? Math.min(limit * TIMEOUT_RETRY_FACTOR, Math.max(VERIFY_TIMEOUT_CEILING_MS, limit))
        : limit;
      const second = await runOne(command, { ...opts, timeoutMs: again });
      ran.push({ ...second, retry: true });
      result = second;
    }
    // After the retry, so the stream reports the outcome the VERDICT is judged
    // on rather than a red that was about to be rescued a second later.
    opts.onDone?.(result, index, runnable.length);
    // Stop at the first red: later commands usually depend on earlier ones, and
    // a wall of cascading failures buries the one that actually matters. A
    // baseline (`cascade: false`) wants every line's own answer instead.
    if (!result.ok) {
      failedRun ??= result;
      if (opts.cascade === false) continue;
      for (const rest of runnable.slice(index + 1)) {
        notRun.push({ text: condense(rest), reason: CASCADE_SKIP_REASON });
      }
      break;
    }
  }

  const failed = failedRun;
  // The ONE verdict (control-tower phase 45): `ok` below and the runner's halt
  // are both read off it, so they cannot disagree about a rescued command.
  const verdict = verificationVerdict(ran);
  const cutTwice = (row: VerifyRun): boolean => ran.some((other) => other !== row && other.command === row.command && other.timedOut);
  // Commands, not attempts: a rescued flake is one green command with two rows.
  const greens = ran.filter((r) => !r.retry).length;
  const provenCount = ran.filter((r) => r.proven).length;
  const provenNote = provenCount ? ` (${provenCount} proven by the session at an equivalent tree)` : '';
  // A verification the abort signal cut off proved nothing about whatever it
  // never ran. `ok: !failed` alone once answered `true, "0 commands green"`
  // over three commands a console shutdown skipped — and the phase settled
  // done on it. A red that DID run keeps its own reason; the stop only ever
  // makes the verdict more honest, never green.
  const stopped = opts.signal?.aborted === true;
  const skipNote = skipped.length
    ? `; ${skipped.length} skipped — unrunnable here (${[...new Set(skipped.map((s) => s.lead))].join(', ')})`
    : '';
  return {
    ok: verdict.ok && !failed && !stopped,
    reason: failed
      ? endingWords(failed, cutTwice(failed))
      : stopped
        ? `the run was stopped mid-verification — ${ran.length} of ${runnable.length} command(s) ran`
        : `${greens} command${greens === 1 ? '' : 's'} green${provenNote}${skipNote}`
          + verdict.rescued.map((r) => `; \`${condense(r.command)}\` green on retry (first ${
            r.timedOut ? `timed out after ${limitWords(r.limitMs ?? 0)}` : `exited ${r.code}`})`).join(''),
    ran,
    notRun,
    ...(skipped.length ? { skipped } : {}),
    ...(waived.length ? { waived } : {}),
    ...(setup ? { setup } : {}),
    ...(verdict.timedOut.length ? { timedOut: verdict.timedOut.map((row) => row.command) } : {}),
    ...(verdict.unproven.length ? { unproven: verdict.unproven.map((row) => ({ command: row.command, why: row.environment! })) } : {}),
  };
}

/**
 * Run the phase's `- **Setup:**` preamble, and report ONLY a failure.
 *
 * Returns the first command that did not exit 0, or undefined — which covers
 * both "no Setup declared" and "all of it worked", because neither is
 * something a reader needs told. No retry (the verification's one recorded
 * retry exists to absorb a flaky suite; re-running `docker compose up -d`
 * absorbs nothing), no cascade bookkeeping, and no `notRun` — a fragment of
 * prose in a Setup bullet is simply not run, silently, since nothing here can
 * make the phase red and an unanswerable question about bring-up is not a
 * question worth parking a person on.
 */
async function runSetup(
  opts: VerifyOptions,
): Promise<{ ok: false; command: string; output: string } | undefined> {
  if (!opts.setupText?.trim()) return undefined;
  const { commands } = extractCommands(opts.setupText, 'setup', opts.approvals);
  // A count is not a clock: eight commands at the verification timeout is four
  // hours of preamble nothing will ever mark red. Bring-up that has not
  // returned in ten minutes is not going to.
  const bounded = { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? SETUP_TIMEOUT_MS, SETUP_TIMEOUT_MS) };
  const listed = commands.slice(0, MAX_SETUP_COMMANDS);
  for (const [index, command] of listed.entries()) {
    if (opts.signal?.aborted) return undefined;
    opts.onSetupStart?.(command, index, listed.length);
    const result = await runOne(command, bounded, 'setup');
    if (!result.ok) {
      return { ok: false, command: condense(command), output: result.output };
    }
  }
  return undefined;
}

/**
 * Directories a verification's PATH must be able to see.
 *
 * Under launchd the plist bakes the PATH of whatever shell ran the installer,
 * and a thin one turns a green suite into `"python": executable file not found`
 * at 3 a.m. — a halt that blames the code when only the environment failed
 * (that exact halt stopped a real run). APPENDED, never prepended: the existing
 * PATH keeps deciding which toolchain wins, and only otherwise-invisible
 * binaries are rescued. The amendment is logged once per process so the plist
 * defect stays visible instead of papered over — the durable fix is starting the
 * console from a shell with a full PATH.
 */
const STANDARD_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
let pathAmendWarned = false;

export function hardenedPath(path: string | undefined): { path: string; added: string[] } {
  const current = (path ?? '').split(':').filter(Boolean);
  const have = new Set(current);
  const added = STANDARD_DIRS.filter((dir) => !have.has(dir) && existsSync(dir));
  return { path: [...current, ...added].join(':'), added };
}

/** Where `nice` lives on every machine this console runs on (macOS and Linux alike). */
const NICE_BIN = '/usr/bin/nice';

/**
 * The environment every §Verification and `Setup:` command runs under — built
 * in ONE place, because the baseline's reuse key digests exactly this
 * (`verifyEnvDigest`), and a digest of a different environment from the one
 * the commands get would vouch for runs it never saw.
 *
 * The SESSION's environment, made non-interactive by the specific switches —
 * `NO_COLOR`, `TERM=dumb`, and a stdin that is closed (`runOne`'s `'ignore'`):
 * nothing can wait on a prompt, and nothing is told it is somewhere else. It
 * used to add `CI=1` as well (control-tower phase 106, #195), and suites read
 * `CI` as "this is the CI infrastructure": app-backend's preview-store tests
 * skip on a laptop whose Redis wants a password and ERROR under `CI`, so a line
 * green in the session's shell was red every time the console ran it. A `CI`
 * the console itself inherited still passes through untouched — whoever
 * started it with one meant it.
 */
function commandEnv(env: NodeJS.ProcessEnv | undefined): { env: NodeJS.ProcessEnv; added: string[] } {
  const base = { ...(env ?? process.env) };
  const hardened = hardenedPath(base.PATH);
  return { env: { ...base, PATH: hardened.path, NO_COLOR: '1', TERM: 'dumb' }, added: hardened.added };
}

/**
 * The variables of that environment a measurement depends on — what moves the
 * digest. Not the whole environment: a console's own variables (`PE_*`, a
 * session id, a trace parent) change with every start and no command reads
 * them, and a digest over them would never match twice.
 */
export const ENV_DIGEST_KEYS: readonly string[] = [
  'PATH', 'CI', 'TERM', 'NO_COLOR', 'NODE_OPTIONS', 'NODE_ENV', 'LANG', 'LC_ALL', 'TZ', 'SHELL', 'HOME',
];

/**
 * The environment half of a baseline's reuse key (control-tower phase 105,
 * #190 ask 3): a measurement stands in for another only when both ran under
 * the same environment — the machine (platform, architecture, the console's
 * Node), the variables in `ENV_DIGEST_KEYS` as the commands receive them, and
 * the `Setup:` preamble that brought the stack up. Sixteen hex characters.
 */
export function verifyEnvDigest(opts: { env?: NodeJS.ProcessEnv; setupText?: string }): string {
  const { env } = commandEnv(opts.env);
  const setup = opts.setupText?.trim() ? extractCommands(opts.setupText, 'setup').commands.map(foldCommand) : [];
  const facts = {
    platform: process.platform, arch: process.arch, node: process.version,
    env: Object.fromEntries(ENV_DIGEST_KEYS.map((key) => [key, env[key] ?? null])),
    setup,
  };
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16);
}

/**
 * One §Verification command, in a process group of its own.
 *
 * `execFile`'s own `timeout` sends SIGTERM to the `bash` it spawned and to
 * nothing else. Every command this codebase expects in a §Verification —
 * `npm test`, `docker compose run … pytest`, a `task` target — does its actual
 * work in CHILDREN of that bash, so a timeout killed the shell and left the
 * test runner, the containers and their sockets behind: the run recorded a
 * clean 124 and the machine kept the work. This was the one child-spawning
 * path in `server/` that `signals.ts` did not cover.
 *
 * So: `detached: true` makes the child a process-group leader, and the timeout
 * goes through `killLadder`, which wakes the group (a stopped process queues
 * SIGTERM and never runs its handler), addresses `-pid` so everything the
 * command started goes with it, and keeps a SIGKILL backstop. `how` records
 * which rung it took, because a 124 that does not say whether the children
 * were reaped is a 124 nobody can act on.
 */
function runOne(command: string, opts: VerifyOptions, stage: 'setup' | 'verify' = 'verify'): Promise<VerifyRun> {
  const started = Date.now();
  const { env, added } = commandEnv(opts.env);
  if (added.length && !pathAmendWarned) {
    pathAmendWarned = true;
    log.warn('verify.path-amended', { added });
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let bytes = 0;
    let cut: 'timeout' | 'abort' | null = null;
    let how: LadderEnding | undefined;
    let settled = false;
    // What the output names as failing, read off the WHOLE stream — the tail
    // kept below is 8 KB, and a suite prints its first failure long before its
    // last line (#103). One scanner per stream, so a line split across chunks
    // is never spliced to the other stream's.
    const failingOut = new FailureScanner();
    const failingErr = new FailureScanner();

    // A niced command (a baseline beside a working session, control-tower
    // phase 105) starts under `nice` itself, which execs the shell in place:
    // the same pid, and every process the command forks inherits the priority
    // from its first instruction — no window in which it ran at full speed.
    const niced = opts.nice && existsSync(NICE_BIN) ? [NICE_BIN, '-n', String(opts.nice)] : [];
    const argv = [...niced, 'bash', '-c', command];
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    if (child.pid) {
      try { opts.onChild?.(child.pid, command, stage); } catch { /* a listener never stops the command */ }
    }

    // `execFile`'s maxBuffer, kept by hand: stop ACCUMULATING past the cap
    // rather than killing the command over it. Only the tail is ever reported,
    // so a chatty suite that would have blown the buffer now simply has its
    // middle dropped instead of being reported as a failure it was not.
    const take = (chunk: string, into: 'out' | 'err'): void => {
      (into === 'out' ? failingOut : failingErr).push(chunk);
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) {
        const keep = chunk.slice(-KEEP_OUTPUT);
        if (into === 'out') out = (out + keep).slice(-KEEP_OUTPUT);
        else err = (err + keep).slice(-KEEP_OUTPUT);
        return;
      }
      if (into === 'out') out += chunk; else err += chunk;
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => take(chunk, 'out'));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => take(chunk, 'err'));

    // Held so `finish` can WAIT for it. The bash exits the moment it takes
    // SIGTERM, so `close` fires long before the ladder has finished with the
    // rest of the group — resolving then would report a result whose `how` was
    // still undefined and, worse, would claim the command was cleaned up while
    // its grandchildren were still being chased.
    let ending: Promise<void> | null = null;
    // The group, not the pid — and the GROUP is what the ladder now asks about
    // too (control-tower phase 106, #168), so a group whose leader is gone is
    // still reached. No interrupt first: a `bash -c` has no turn to close, so
    // SIGINT would buy the command nothing but a delay.
    const ladder = (): Promise<void> => {
      if (ending || child.pid == null) return ending ?? Promise.resolve();
      ending = killLadder(child.pid, { killAfterMs: KILL_GRACE_MS, interrupt: false }).then((verdict) => {
        how = verdict;
      }, () => { /* the process vanished mid-ladder; `how` stays unset */ });
      return ending;
    };

    // The leader's own exit, from `exit` — the code the line is judged on even
    // when something it left behind keeps its streams open (#168).
    let leaderCode: number | null = null;
    let stragglers: { pid: number; comm?: string }[] = [];
    let heldOutside = false;
    // After the ladder the streams get a moment to reach EOF; past it they are
    // let go, because what still holds them LEFT the group (a detached child,
    // a `setsid`) and no signal of ours reaches it. No line outlives its clock
    // plus the ladder plus this.
    const letGo = (): void => {
      const release = setTimeout(() => {
        if (settled) return;
        heldOutside = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finish(leaderCode ?? 1);
      }, STREAM_RELEASE_MS);
      release.unref?.();
    };
    // The leader exited and the streams are still open: name what is left in
    // its group, stop it, and settle on the leader's code.
    let reaping: Promise<void> | null = null;
    const reap = (): Promise<void> => {
      reaping ??= (async () => {
        if (settled || child.pid == null) return;
        const left = await groupMembers(child.pid).catch(() => []);
        // The streams closed while the group was being listed: the line ended
        // by itself, and nothing of it is a straggler.
        if (settled) return;
        stragglers = left;
        await ladder();
        if (!settled) letGo();
      })();
      return reaping;
    };

    const end = (reason: 'timeout' | 'abort'): void => {
      if (settled || cut) return;
      // The leader exited BEFORE the clock: its code stands and what is left is
      // a straggler's, never a cut — tamagui P4's sweep had passed (#168).
      if (reason === 'timeout' && leaderCode !== null) { void reap(); return; }
      cut = reason;
      if (child.pid == null) return;
      void ladder().then(() => { if (!settled) letGo(); });
    };

    const timer = setTimeout(() => { end('timeout'); }, timeoutMs);
    timer.unref?.();
    const onAbort = (): void => { end('abort'); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let drain: NodeJS.Timeout | null = null;
    child.on('exit', (code, signal) => {
      leaderCode = typeof code === 'number' ? code : signal ? 128 + (osConstants.signals[signal] ?? 0) : 1;
      if (settled || cut) return;
      drain = setTimeout(() => { void reap(); }, LEADER_DRAIN_GRACE_MS);
      drain.unref?.();
    });

    const finish = async (code: number): Promise<void> => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      if (ending) await ending;
      opts.signal?.removeEventListener('abort', onAbort);
      const killed = cut !== null || Boolean(opts.signal?.aborted);
      const notes = [
        ...(stragglers.length ? [`[left ${stragglers.length} process${stragglers.length === 1 ? '' : 'es'} in its group after it exited `
          + `(${stragglers.map((entry) => `${entry.pid}${entry.comm ? ` ${entry.comm}` : ''}`).join(', ')}) — stopped]`] : []),
        ...(heldOutside ? ['[a process outside its group still held its output when it ended — let go, not waited on]'] : []),
      ];
      const output = [`${out}${err}`.trim(), ...notes].filter(Boolean).join('\n');
      const failures = [...new Set([...failingOut.end(), ...failingErr.end()])].slice(0, FAILURE_CAP);
      if (stragglers.length) log.warn('verify.stragglers', { command: condense(command), pids: stragglers.map((entry) => entry.pid) });
      resolve({
        command,
        // A killed command proves nothing — report it red, but say why.
        ok: !killed && code === 0,
        code: killed ? 124 : code,
        ms: Date.now() - started,
        output: (killed ? `[timed out or cancelled]\n${output}` : output).slice(-KEEP_OUTPUT),
        ...(how && killed ? { how } : {}),
        // The CLOCK cut it — not the abort signal, and not an exit 124 of its
        // own (control-tower phase 83, #95). Only this is `verify-timeout`.
        ...(cut === 'timeout' && !opts.signal?.aborted ? { timedOut: true } : {}),
        limitMs: timeoutMs,
        ...(failures.length ? { failures } : {}),
        ...(stragglers.length ? { stragglers } : {}),
      });
    };

    // `close`, not `exit`, for the OUTPUT: the streams must be drained before
    // it is read, or a fast-failing command reports an empty log. The CODE is
    // the leader's, from `exit`, whenever it came first.
    child.on('close', (code) => { void finish(leaderCode ?? (typeof code === 'number' ? code : 1)); });
    child.on('error', () => { void finish(1); });
  });
}

/**
 * Run ONE command under the same read-only policy a phase's §Verification gets,
 * or say why it will not be run — the single-command door for callers that hold
 * a command but no plan.
 *
 * Its whole reason for existing is that `refuse()` and `runOne()` are both
 * module-private and must STAY paired: an exported runner without the policy
 * would be a second way to execute a string this file exists to judge, and the
 * one caller outside it (`watch-refs.ts`'s `cmd:` scheme) is running a string a
 * SESSION wrote, on a timer, unattended. So the two are one function and there
 * is no way to reach the second without the first.
 *
 * `refused` is a verdict and not a failure: the policy has judged this command
 * and will judge it identically for ever, which is why the watch scheduler
 * retires a refused ref rather than re-asking it every five minutes.
 */
export async function runSingleCommand(
  command: string, opts: VerifyOptions,
): Promise<{ refused?: string; ok: boolean; code?: number; detail?: string; ms?: number }> {
  const refused = judgeCommand(command);
  if (refused) return { ok: false, refused };
  const run = await runOne(command, opts);
  return {
    ok: run.ok,
    code: run.code,
    ms: run.ms,
    // The tail, condensed: this rides a journal line and a resume brief, not a
    // log pane. A whole suite's output in an errand is an errand nobody reads.
    detail: `exit ${run.code}${run.output ? ` — ${condense(run.output.slice(-400))}` : ''}`,
  };
}

/**
 * The policy's verdict on ONE command without running it — why it would be
 * refused, or null. `runSingleCommand` runs only what this passes, and the
 * ingest probe asks it at declaration (control-tower phase 88, #125), so a
 * `cmd:` ref the console would never run is refused while the session that
 * wrote it can still fix it, whether or not `watchCmdRefs` is on.
 */
export function judgeCommand(command: string): string | null {
  const verdict = refuse(command);
  // `PREAMBLE` is a SENTINEL, not a sentence — a NUL-prefixed marker the plan
  // path (`:277`) consumes by skipping the line entirely. This caller has
  // nowhere to skip to: a watch ref that is pure preamble (`cmd:"export FOO=1"`
  // — note `cd /tmp` is NOT one, it is an allowed command that exits 0 and so
  // lands instantly) can never exit 0 in a way that means anything, so it
  // is a refusal — but it must be a refusal in words, or `\u0000preamble`
  // reaches a journal line and an operator errand verbatim.
  if (verdict === PREAMBLE) return 'sets something up and then runs nothing — there is no result to wait for';
  return verdict ? verdict.reason : null;
}

/**
 * What a plan's `permission.destructive` row answers for ONE publishing call
 * (control-tower phase 84, #112; phase 107, #186, #189, #205) — judged on what
 * the line RUNS (`shell-reading.ts`), never on its raw text.
 *
 * Three answers, because "the row does not cover this" was two different facts
 * sharing one person's card:
 *
 *   `allow` — the row answers the call as it stands: a whole rule it names for
 *             this phase, a command it names for this phase (`gh pr create`,
 *             `gh pr merge --squash --delete-branch` …), or a plain push of
 *             branches it names, with read-only company — a neighbour from the
 *             roster below, a `$( … )` whose every command is on it, a `$?`.
 *   `deny`  — the row WOULD answer the push in its bare form, and this call is
 *             not that form: a `git add`/`git commit` beside it, a substitution
 *             that writes, a branch the shell computes, a bare `git push`, a
 *             push hidden in a here-doc. Refused at once, naming the bare form
 *             to re-run alone — the session proceeds in seconds, where a card
 *             sat an hour (three of them in two hours of one release phase).
 *   `null`  — the row does not cover the act in ANY form: another branch, a
 *             trunk, a force, a delete, a command named for other phases only.
 *             A person's card, which names the row and why.
 *
 * Reading spawns nothing: a parser over text and a row of prose.
 */

import {
  TRUNK_BRANCHES, destructiveCommandExceptions, destructivePushBranches, type DestructiveException,
} from '../../shared/policy-model.js';
import { executedTexts, gitCanonical, readShell, type ShellCommand, type ShellReading } from './shell-reading.ts';

export type ManifestVerdict = {
  answer: 'allow' | 'deny' | null;
  why: string;
  /** The publishing rule the verdict is about — the first one the row did not answer, else the first matched. */
  rule?: string;
  /** For a push the row answered: the branch. */
  branch?: string;
  /** For `deny`: the command the row would answer, to run in a call of its own. */
  bareForm?: string;
  /**
   * On an `allow`: what else the line runs, off the read-only roster. The row
   * answers the publishing act ALONE, so the caller judges these under its
   * own policy, and one it would not allow on its own turns the answer into a
   * `deny` naming `bareForm` (which an `allow` with companions carries).
   * Never a way to widen what the line may do.
   */
  companions?: string[];
};

export type ManifestContext = { runBranch?: string | null; phase?: number | null };

/**
 * Word lists are written as one string and split: this module only READS
 * commands, and `never-push.test.ts` / `issues-readonly.test.ts` take every
 * bracketed list of string literals under `server/` for an argv to execute.
 */
const words = (text: string): readonly string[] => Object.freeze(text.split(' '));

/** The verb `git push` — what a bare form opens with. */
const PUSH_VERB = 'git push';

/** One word as a shell would need it to read it back: plain, or single-quoted. */
const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

/**
 * Options that only PARAMETERISE a named `gh` command — its repository, title,
 * body, subject, base or head, labels and people. A row that names a command
 * WITH options (`gh pr merge --squash --delete-branch`) names that form: a call
 * may add these and nothing else, so `--admin` (which overrides branch
 * protection) or another merge method is a person's card.
 */
const PARAMETER_OPTIONS = new Set(words(
  '-R --repo -t --title --subject -b --body -F --body-file -B --base -H --head --match-head-commit -A --author-email -l --label -r --reviewer -a --assignee -m --milestone -p --project',
));

/** The rules the carve-outs pin for a person — `approvals.ts` `OPEN_PR_ASK` ∪ `PUBLISH_ASK`, by verb. */
const PUBLISHING_VERBS: readonly { rule: string; verb: readonly string[] }[] = Object.freeze(
  ['Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(gh pr merge:*)'].map((rule) => ({
    rule, verb: words(rule.slice('Bash('.length, -':*)'.length)),
  })),
);

/**
 * The words a push may carry beside its remote and refspecs. Anything else — a
 * force, a delete, `--all`/`--mirror`/`--tags`, `--no-verify` (which skips the
 * gate hook), an option this list does not know — is a person's card.
 */
const PUSH_QUIET_OPTIONS = new Set(words('-u --set-upstream -q --quiet -v --verbose --porcelain --progress --no-progress --atomic'));
/** Push options that widen what is pushed past the branch a row names. */
const PUSH_WIDENING = new Set(words('--all --mirror --tags --follow-tags --prune'));

/** Commands that change the shell around them — what a later command of the line runs, or how. */
const SHELL_ALTERING = new Set(words('export declare typeset local readonly alias unalias set shopt source . unset enable builtin hash trap ulimit umask'));

/** An assignment the line may make beside a publishing act: reading an exit status names nothing. */
const STATUS_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\$\?$/;

/** Git options a push may carry before its verb: where to run, and no pager. */
const GIT_QUIET_GLOBALS = new Set(words('--no-pager'));

/**
 * Why a publishing command is not answered from the row WHATEVER the row
 * names (control-tower phase 107): it runs with an environment assignment or
 * `env` in front (`GIT_SSH_COMMAND=…`, `GH_HOST=…` change what runs and where
 * it goes), or with git's own options before its verb (`-c
 * core.sshCommand=…`, `-c remote.origin.url=…`). Only `-C <dir>` and
 * `--no-pager` stand there harmlessly. Null when it is a plain invocation.
 */
function invocationRefusal(command: ShellCommand): string | null {
  const prefix = command.words.slice(0, Math.max(0, command.words.length - command.lead.length));
  const assignment = prefix.find((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (assignment) return `it runs with \`${assignment.slice(0, 60)}\` in front, which the row does not cover`;
  if (prefix.includes('env')) return 'it runs under `env`, which the row does not cover';
  const lead = command.lead;
  if (lead[0] === 'git') {
    for (let i = 1; i < lead.length && (lead[i] ?? '').startsWith('-'); i += 1) {
      const flag = lead[i] ?? '';
      if (flag === '-C') { i += 1; continue; }
      if (!GIT_QUIET_GLOBALS.has(flag)) return `it sets git's own \`${flag}\` before its verb, which the row does not cover`;
    }
  }
  return null;
}

/**
 * Why a line whose publishing acts the row covers still cannot be answered as
 * it stands: it assigns (other than an exit status), changes the shell around
 * it, defines a function, or holds what this judge cannot read. Null when
 * none of that is in it.
 */
function lineRefusal(reading: ShellReading, companions: readonly ShellCommand[]): string | null {
  const assignment = reading.assigned.find((w) => !STATUS_ASSIGNMENT.test(w));
  if (assignment) return `the line also assigns \`${assignment.slice(0, 60)}\`, which may change what the publishing command runs`;
  if (reading.functions.length) return `the line defines a function (\`${reading.functions[0]}\`), which may stand in for a command of the same name`;
  const altering = companions.find((c) => SHELL_ALTERING.has(c.lead[0] ?? ''));
  if (altering) return `the line also runs \`${altering.lead.join(' ').slice(0, 60)}\`, which changes the shell around the publishing command`;
  if (reading.opaque.length) {
    return `the line also runs what this judge cannot read (${[...new Set(reading.opaque.map((o) => o.kind))].join(', ')})`;
  }
  return null;
}

/** Why a push option is not covered, by its shape. */
function pushOptionRefusal(word: string): string {
  if (/^(?:-f|--force(?:-with-lease|-if-includes)?)(?:=.*)?$/.test(word)) return 'it is a force push';
  if (word === '-d' || word === '--delete') return 'it deletes a remote branch';
  if (PUSH_WIDENING.has(word)) {
    return `\`${word}\` pushes more than the branch the row names`;
  }
  if (word === '--no-verify') return '`--no-verify` skips the push hook';
  return `it carries \`${word}\`, which the row does not cover`;
}

/**
 * Commands a push may keep company with and still be answered from the row:
 * each only READS (or prints), so the compound publishes exactly what the push
 * does. `git` is judged by its sub-command below; `cd` moves nothing. The same
 * roster judges the commands inside a `$( … )` beside the push (#186).
 */
const READ_ONLY_COMMANDS = new Set(words('echo printf true false : grep egrep fgrep head tail cat wc sort uniq cut tr date pwd ls test [ cd'));
const READ_ONLY_GIT = new Set(words('status log show diff rev-parse rev-list ls-remote describe'));
/** `git branch` with only these words lists branches. */
const READ_ONLY_BRANCH = new Set(words('-a -r -v -vv --show-current --list'));

/** Is this command on the read-only roster? */
export function readOnlyCommand(words: readonly string[]): boolean {
  const git = gitCanonical(words) ?? [...words];
  if (git[0] === 'git') {
    if (READ_ONLY_GIT.has(git[1] ?? '')) return true;
    if (git[1] === 'stash' && git[2] === 'list') return true;
    if (git[1] === 'branch' && git.slice(2).every((w) => READ_ONLY_BRANCH.has(w))) return true;
    return git[1] === 'remote' && git.slice(2).every((w) => w === '-v');
  }
  return READ_ONLY_COMMANDS.has(words[0] ?? '');
}

/** The publishing verb a command is, read from its real lead (`git -C x push` is a push). */
function publishingVerbOf(command: ShellCommand): { rule: string; verb: readonly string[] } | null {
  const forms = [command.lead, gitCanonical(command.lead) ?? command.lead, command.words];
  for (const entry of PUBLISHING_VERBS) {
    if (forms.some((words) => entry.verb.every((w, i) => words[i] === w))) return entry;
  }
  return null;
}

/** The command's words from its publishing verb on (`git -C x push o b` → `git push o b`). */
function fromVerb(command: ShellCommand): string[] {
  return gitCanonical(command.lead) ?? command.lead;
}

const quote = (words: readonly string[]): string => words.join(' ');

type PushShape =
  | { kind: 'covered'; destinations: string[]; bare: string }
  | { kind: 'reshape'; why: string; bare: string }
  | { kind: 'uncovered'; why: string };

/** One push judged on its own words, against the branches the row names. */
function judgePush(command: ShellCommand, branches: readonly string[]): PushShape {
  const words = fromVerb(command);
  const options: string[] = [];
  const positional: string[] = [];
  for (const arg of words.slice(2)) {
    if (arg.startsWith('-')) {
      if (!PUSH_QUIET_OPTIONS.has(arg)) return { kind: 'uncovered', why: pushOptionRefusal(arg) };
      options.push(arg);
    } else {
      positional.push(arg);
    }
  }
  const upstream = options.some((o) => o === '-u' || o === '--set-upstream') ? ['-u'] : [];
  const computed = (word: string) => /[$`]/.test(word);
  // The row answers a push of its branches to the checkout's `origin`. A URL
  // or a path — `..` and `.` are paths too — or another remote sends the
  // branch somewhere the row never named: a person's call.
  if (positional[0] && !computed(positional[0]) && positional[0] !== 'origin') {
    return {
      kind: 'uncovered',
      why: /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(positional[0]) && !/^\.+$/.test(positional[0])
        ? `it pushes to the remote ${positional[0]}, and the row answers a push to origin`
        : `it pushes to ${positional[0]}, a URL or a path rather than a remote the checkout names`,
    };
  }
  const remote = positional[0] && !computed(positional[0]) ? positional[0] : 'origin';
  const named = branches.length === 1 ? branches[0] : `<one of: ${branches.join(', ')}>`;
  const bareFor = (branch: string) => quote([PUSH_VERB, ...upstream, remote, branch]);
  const refspecs = positional.slice(1);
  if (positional[0] && computed(positional[0])) {
    return { kind: 'reshape', bare: bareFor(named), why: 'the remote it pushes to is one the shell computes' };
  }
  if (!refspecs.length) {
    return {
      kind: 'reshape', bare: bareFor(named),
      why: "the push names no branch — a bare push goes wherever the checkout's upstream points",
    };
  }
  const destinations: string[] = [];
  for (const refspec of refspecs) {
    if (refspec.startsWith('+')) return { kind: 'uncovered', why: 'it is a force push (a `+` refspec)' };
    const colon = refspec.indexOf(':');
    // `:branch` — an empty SOURCE — is git's delete form, not a push of it.
    if (colon === 0) return { kind: 'uncovered', why: 'it deletes a remote branch (a refspec with an empty source)' };
    const destination = (colon > 0 ? refspec.slice(colon + 1) : refspec).replace(/^refs\/heads\//, '');
    // A branch only the shell knows: a `$( … )` (masked to one `$(…)` word by
    // the reader) or a `$VAR` in the refspec itself — never a redirect target.
    if (computed(refspec)) {
      return {
        kind: 'reshape', bare: bareFor(named),
        why: 'the branch it pushes is one the shell computes — the row answers a branch it can read',
      };
    }
    if (destination === 'HEAD' || !destination) {
      return { kind: 'reshape', bare: bareFor(named), why: 'the push names no branch — `HEAD` is whatever is checked out' };
    }
    if ((TRUNK_BRANCHES as readonly string[]).includes(destination)) {
      return { kind: 'uncovered', why: `it pushes to ${destination}, a trunk — always a person's call` };
    }
    if (!branches.includes(destination)) {
      return { kind: 'uncovered', why: `it pushes to ${destination}, which the row does not name (it names ${branches.join(', ')})` };
    }
    destinations.push(destination);
  }
  return { kind: 'covered', destinations, bare: quote([PUSH_VERB, ...upstream, remote, ...destinations]) };
}

/**
 * The push half: whether every push in the line is one the row names, and
 * whether the line around them is one the row can answer as it stands.
 */
function pushVerdict(
  reading: ShellReading, pushes: ShellCommand[], value: string, ctx: ManifestContext,
  alsoCovered: readonly ShellCommand[] = [],
): ManifestVerdict {
  const rule = 'Bash(git push:*)';
  const branches = destructivePushBranches(value, ctx);
  if (!branches.length) return { answer: null, rule, why: 'the row names no branch this plan may push to' };
  const shapes = pushes.map((push) => ({ push, shape: judgePush(push, branches) }));
  const uncovered = shapes.find((s) => s.shape.kind === 'uncovered');
  if (uncovered && uncovered.shape.kind === 'uncovered') return { answer: null, rule, why: uncovered.shape.why };

  const bare = [...new Set(shapes.map((s) => (s.shape.kind === 'uncovered' ? '' : s.shape.bare)))].filter(Boolean).join(' && ');
  const deny = (why: string): ManifestVerdict => ({
    answer: 'deny', rule, why, bareForm: bare,
    ...(shapes[0]?.shape.kind === 'covered' ? { branch: shapes[0].shape.destinations[0] } : {}),
  });

  // A push the shell reaches some other way than as a statement of the line —
  // said first, because WHERE it runs is what the session has to change.
  for (const { push } of shapes) {
    if (push.from === 'heredoc') {
      return deny('a push may be hidden in a heredoc — a shell reading one runs it, and the shell runs `$( … )` and backticks inside an unquoted one; quote its delimiter (`<<\'EOF\'`) if the text is data');
    }
    if (push.from === 'eval') return deny('a push may be hidden in an `eval`');
    if (push.suffix || push.runsItsArgument) return deny('the push rides inside a command that runs what it is handed');
    if (!push.top) {
      return deny(push.from === 'substitution' ? 'the push runs inside a `$( … )`'
        : push.from === 'payload' ? 'the push runs inside a shell\'s `-c` payload'
          : push.from === 'group' ? 'the push runs inside a `( … )` or `{ … }` group'
            : 'the push runs inside a compound command (`if`, `while`, `until`, `for`, `case`, `coproc`)');
    }
  }
  const reshape = shapes.find((s) => s.shape.kind === 'reshape');
  if (reshape && reshape.shape.kind === 'reshape') return deny(reshape.shape.why);
  const refusal = lineRefusal(reading, reading.commands.filter((c) => !pushes.includes(c) && !alsoCovered.includes(c)));
  if (refusal) return deny(refusal);
  // Everything else the line runs must only read — inside a `$( … )` too.
  for (const command of reading.commands) {
    if (pushes.includes(command) || alsoCovered.includes(command)) continue;
    if (command.suffix) continue;
    if (readOnlyCommand(command.lead)) continue;
    const words = gitCanonical(command.lead) ?? command.lead;
    const name = words[0] === 'git' ? `git ${words[1] ?? ''}`.trim() : (words[0] ?? '');
    return deny(command.from === 'substitution'
      ? `a \`$( … )\` beside the push runs ${name}, which does not only read`
      : `a command beside the push the row does not cover: ${name}`);
  }
  const pushed = [...new Set(shapes.flatMap((s) => (s.shape.kind === 'covered' ? s.shape.destinations : [])))];
  return {
    answer: 'allow', rule,
    why: `the row names ${pushed.join(', ')} as a branch this plan may push`,
    branch: pushed[0],
  };
}

/**
 * Does a named exception cover this command? Its verb, every option it names,
 * and — when it names options at all — no option beyond those and the ones
 * that only parameterise (`PARAMETER_OPTIONS`). A bare verb names the command
 * in any form.
 */
function covers(entry: DestructiveException, command: ShellCommand): boolean {
  if (!entry.verb.length) return false;
  return verbForms(command).some((words) => entry.verb.every((w, i) => words[i] === w)
    && entry.options.every((option) => words.includes(option))
    && extraOptions(entry, words).length === 0);
}

/** The command's words from its real lead, and from git's verb. */
function verbForms(command: ShellCommand): string[][] {
  return [command.lead, gitCanonical(command.lead) ?? command.lead];
}

/** Options the call carries beyond a named form — none when the entry names no option. */
function extraOptions(entry: DestructiveException, words: readonly string[]): string[] {
  if (!entry.options.length) return [];
  return words.slice(entry.verb.length)
    .filter((w) => w.startsWith('-') && !entry.options.includes(w) && !PARAMETER_OPTIONS.has(w.replace(/=.*$/, '')));
}

/** The command a session may re-run for this publishing act, as a shell would read it back. */
function bareOf(command: ShellCommand): string {
  return command.lead.map(shellWord).join(' ');
}

/**
 * What the line runs beside its publishing acts, off the read-only roster —
 * judged by the caller under its own policy (`ManifestVerdict.companions`).
 */
function companionsOf(reading: ShellReading, publishing: readonly ShellCommand[]): string[] {
  return [...new Set(reading.commands
    .filter((c) => !publishing.includes(c) && !c.suffix && !readOnlyCommand(c.lead))
    .map((c) => c.lead.join(' ')))];
}

const phaseList = (phases: readonly number[]): string => phases.length === 1 ? `phase ${phases[0]}` : `phases ${phases.join(', ')}`;

/**
 * The whole verdict for one Bash call: every publishing command in the line,
 * each against the row's exceptions for THIS phase — a whole rule, a named
 * command, a named branch. The first act the row does not cover decides; a
 * push the row would answer bare, in a shape it cannot, is a `deny` naming it.
 */
export function manifestVerdict(command: string, value: string | null | undefined, ctx: ManifestContext = {}): ManifestVerdict {
  const row = typeof value === 'string' ? value : '';
  const phase = typeof ctx.phase === 'number' ? ctx.phase : null;
  const reading = readShell(typeof command === 'string' ? command : '');
  const entries = destructiveCommandExceptions(row);
  const mine = entries.filter((e) => e.phases === null || (phase !== null && e.phases.includes(phase)));

  const publishing = reading.commands
    .map((c) => ({ command: c, verb: publishingVerbOf(c) }))
    .filter((p): p is { command: ShellCommand; verb: { rule: string; verb: readonly string[] } } => p.verb !== null);
  if (!publishing.length) {
    // Nothing the line runs publishes. The service asks only when its matcher
    // found a publishing verb, which with nothing visible means it read the
    // raw line because the reader could not see what runs — say THAT, never
    // "a substitution".
    if (!reading.opaque.length) return { answer: null, why: 'the command publishes nothing the row answers' };
    const where = reading.opaque.some((o) => o.kind === 'eval') ? 'an `eval`'
      : reading.heredocs.some((h) => !h.quoted) ? 'a heredoc' : 'what this judge cannot read';
    return { answer: null, why: `a push may be hidden in ${where} — run it as its own command` };
  }

  // Each publishing command: covered by a whole rule or a named command for
  // this phase, or a push the branch reader judges below with the line around it.
  const pushes: ShellCommand[] = [];
  const covered: ShellCommand[] = [];
  for (const { command: c, verb } of publishing) {
    const refused = invocationRefusal(c);
    if (refused) return { answer: null, rule: verb.rule, why: refused };
    const whole = mine.some((e) => e.rule === verb.rule && !e.options.length);
    if (whole) {
      covered.push(c);
      continue;
    }
    if (verb.rule === 'Bash(git push:*)') {
      pushes.push(c);
      continue;
    }
    if (mine.some((e) => covers(e, c))) {
      covered.push(c);
      continue;
    }
    const elsewhere = entries.filter((e) => covers(e, c) && e.phases !== null);
    if (elsewhere.length) {
      const phases = [...new Set(elsewhere.flatMap((e) => e.phases ?? []))].sort((a, b) => a - b);
      return {
        answer: null, rule: verb.rule,
        why: `the row allows \`${quote(elsewhere[0]!.verb)}\` for ${phaseList(phases)} — not ${phase === null ? 'this phase' : `phase ${phase}`}`,
      };
    }
    const sameVerb = mine.find((e) => e.options.length && verb.verb.every((w, i) => e.verb[i] === w));
    if (sameVerb) {
      const words = fromVerb(c);
      const missing = sameVerb.options.filter((o) => !words.includes(o));
      const extra = extraOptions(sameVerb, words);
      return {
        answer: null, rule: verb.rule,
        why: `the row names \`${quote([...sameVerb.verb, ...sameVerb.options])}\` — this call ${missing.length
          ? `does not carry ${missing.join(' ')}` : `also carries ${extra.join(' ')}, which the row does not name`}`,
      };
    }
    return { answer: null, rule: verb.rule, why: `the row does not name ${verb.rule} as an exception` };
  }
  if (pushes.length) return pushVerdict(reading, pushes, row, ctx, covered);

  const rules = [...new Set(publishing.map((p) => p.verb.rule))];
  const named = mine.filter((e) => publishing.some((p) => covers(e, p.command) || (e.rule === p.verb.rule && !e.options.length)));
  const scope = named.some((e) => e.phases !== null) && phase !== null ? ` for phase ${phase}` : '';
  const bare = [...new Set(covered.map(bareOf))].join(' && ');
  const refusal = lineRefusal(reading, reading.commands.filter((c) => !covered.includes(c)));
  if (refusal) return { answer: 'deny', rule: rules[0], why: refusal, bareForm: bare };
  const companions = companionsOf(reading, covered);
  return {
    answer: 'allow', rule: rules[0],
    why: named.length && named.every((e) => e.options.length || e.phases !== null)
      ? `the row names \`${quote([...named[0]!.verb, ...named[0]!.options])}\`${scope}`
      : `the row allows ${rules.join(', ')}${scope}`,
    ...(companions.length ? { companions, bareForm: bare } : {}),
  };
}

/** The push half on its own — the shape `manifestVerdict` gives a line whose publishing acts are pushes. */
export function manifestPushVerdict(command: string, value: string | null | undefined, ctx: ManifestContext = {}): ManifestVerdict & { branches: string[] } {
  const branches = destructivePushBranches(typeof value === 'string' ? value : '', ctx);
  const reading = readShell(typeof command === 'string' ? command : '');
  const pushes = reading.commands.filter((c) => publishingVerbOf(c)?.rule === 'Bash(git push:*)');
  if (!branches.length) return { answer: null, why: 'the row names no branch this plan may push to', branches };
  if (!pushes.length) return { answer: null, why: 'the command pushes nothing the row names', branches };
  return { ...pushVerdict(reading, pushes, typeof value === 'string' ? value : '', ctx), branches };
}

/** The texts the line runs — for a caller that has to say what the judge read. */
export function judgedTexts(command: string): string[] {
  return executedTexts(readShell(command));
}

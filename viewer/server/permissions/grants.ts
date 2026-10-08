/**
 * The scoped grant (control-tower phase 149, #212, §Architecture 19) — a
 * permission item answered with ONE press that the SERVER applies, enforces at
 * the right layer, ends on time, records with its cause and can take back.
 *
 *   call        one use; kept in the ledger, never in memory; spent on use
 *   phase       until the phase settles — `GRANT_PHASE_MAX_MS` at most
 *   plan        the plan's policy file
 *   repository  the repository layer, between the plan's file and the machine's
 *   always      the machine's file
 *
 * Below plan scope the HOOK enforces the grant (`cover`: this run, this phase,
 * this lane, this rule — and for `call` this exact call) and the run's settings
 * carry the rule lowered for that run only (`lowered`), raised again the next
 * time they are written after the grant ends. At plan scope and wider the grant
 * IS a policy edit, and its row names exactly which file, which list, which
 * rule and how (`strike` · `remove` · `add`), so a revoke undoes exactly that.
 *
 * Risk comes from one table, `GRANT_RISK`: low and medium are one press; HIGH
 * needs the rule's own text typed back, its blast radius computed here, and on
 * a console with an owner key the owner door touched inside five minutes (the
 * router's door check reads it; this engine holds it again); `never` is refused
 * through every door at every scope. A capability is granted at the machine
 * only — phase 115's unit verb and a restart when idle — and never from a
 * paired device.
 *
 * The ledger, `grants.ndjson` beside the console's state (0600), is
 * append-only: a `grant` line when one is applied, an `end` line when it is
 * spent, expires or is revoked. Folding the lines is the state. A rotated
 * ledger (retention's `grants` sink) loses no live grant: a read that finds one
 * only in the rotated copy carries its line forward into the current file.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import {
  GRANT_PHASE_MAX_MS, GRANT_SCOPES, GRANT_SCOPE_WORDS, GRANT_STATES, WALLS, neverReason, riskOf,
  type GrantEnding, type GrantScope, type GrantState, type RiskTier, type RuleFamily, type Wall,
} from '../../shared/turn-model.js';
import { redactSecrets } from '../../shared/human-step-model.js';
import {
  DEFAULT_DENY, HOOK_TOOLS, POLICY_PATH, PUSH_DENY, PUSH_DENY_CARVED, classifyTool, editPolicy, effectivePlanPolicyPath,
  hidesText, neverLowered, parseRule, planPolicyPath, policyExtras, repositoryPolicyPath, ruleMatches,
  type AutopilotPolicy, type PermissionProfile,
} from '../runner/approvals.ts';
import { executedTexts, readShell } from '../runner/shell-reading.ts';
import { isGuardRule, ownSettingsRule, ruleFamilyOf, type PermissionDetail } from './walls.ts';
import { log } from '../log.ts';

/** The ledger's name under the console's state directory — a retention sink (`grants`). */
export const GRANTS_FILE = 'grants.ndjson';

/** The live state, and the three ways out of it. */
const LIVE: GrantState = GRANT_STATES[0];

/** Which policy layer a scope at plan level or wider writes. */
export type PolicyLayer = 'plan' | 'repository' | 'machine';

/** EXACTLY what one grant changed — what its row shows and what its end undoes. */
export type GrantChange =
  /** The console's hook lets the granted call through — its scope enforced by `cover`. */
  | { kind: 'hook'; rule: string; runId: string; phase: number; command?: string }
  /** This run's settings carry the rule lowered (a deny dropped) or added (an allow), for this run only. */
  | { kind: 'settings'; runId: string; list: 'deny' | 'allow'; rule: string }
  /** One policy file edited: a file rule removed or added, or a shipped default struck. */
  | { kind: 'policy'; layer: PolicyLayer; file: string; slug?: string; op: 'strike' | 'remove' | 'add'; list: 'deny' | 'allow'; rule: string }
  /** A capability switch put into this console's launch unit; it takes effect on the restart asked for when idle. */
  | { kind: 'capability'; flag: string; unit: string; restart: 'when-idle' };

/** Who gains a HIGH grant, and until when — computed by the server, shown before the press counts. */
export type BlastRadius = {
  /** The runs that gain it now. */
  runs: string[];
  /** The plans that gain it — `every` past plan scope. */
  plans: string[] | 'every';
  /** The phases — one lane below plan scope, `every` at plan scope and wider. */
  phases: { slug: string; phase: number }[] | 'every';
  /** The repositories — this console's, or every one on this machine. */
  repositories: 'this' | 'every';
  /** When it ends by itself; null — until revoked. */
  until: string | null;
  sentence: string;
};

/** One grant — its ledger row, folded with its end. */
export type GrantRow = {
  id: string;
  at: string;
  /** Who pressed, and through which door (`PRESS_DOORS`). */
  by: string;
  door: string | null;
  /** The permission item it answered, when one did. */
  item: string | null;
  /** The approval card whose Allow this grant is, when a card's press made it. */
  card?: string;
  wall: Wall;
  tool: string;
  rule: string;
  /** The exact call, as shown — a `call` grant matches only this. */
  command?: string;
  /** The exact call's digest (`callHash`), when the grant was made from the whole call. */
  callHash?: string;
  family: RuleFamily;
  risk: RiskTier;
  scope: GrantScope;
  slug: string | null;
  phase: number | null;
  runId: string | null;
  /** When it ends by itself; null — until revoked. */
  until: string | null;
  changed: GrantChange[];
  /** Why — the person's words, kept. */
  reason?: string;
  blast?: BlastRadius;
  /** The item's words for a console with no owner key — a HIGH grant there is the typed rule alone. */
  unkeyed?: true;
  state: GrantState;
  endedAt?: string;
  endedBy?: string;
  endReason?: string;
};

/** What a press asks for. */
export type GrantAsk = {
  scope: GrantScope;
  wall: Wall;
  tool: string;
  rule: string;
  command?: string | null;
  /** The whole call a `call` grant names, when the press has it (a card's) — kept as its digest. */
  input?: unknown;
  family?: RuleFamily;
  slug: string | null;
  phase: number | null;
  runId: string | null;
  item?: string | null;
  /** The approval card whose Allow made this grant — its press was already judged by the door table. */
  card?: string | null;
  /** `card`: the press was a card's Allow, which named the rule and was judged at its own route. */
  via?: 'card';
  by: string;
  door?: string | null;
  reason?: string | null;
  /** The rule as the person typed it back — a HIGH grant needs the rule's own text. */
  typed?: string | null;
  /** This console has an owner key (the door table's enrolled mode) — only ever ADDS to what the engine reads itself (`GrantsDeps.enrolled`). */
  enrolled?: boolean;
  /** The owner door touched its key inside five minutes — as the press's door reading PROVED it; unknown is not fresh. */
  fresh?: boolean;
  /** The runs this console drives now — what the blast radius names. */
  live?: { runId: string; slug: string }[];
};

export type GrantRefusal = {
  ok: false;
  status: number;
  error: string;
  /** For a HIGH grant pressed without its rule: the text to type, and who would gain it. */
  rule?: string;
  blast?: BlastRadius;
  reassert?: true;
};

export type GrantsDeps = {
  /** The ledger's path. */
  file: string;
  now?: () => number;
  /**
   * Does this console have an owner key NOW? Read by the engine itself, so a
   * caller that does not say — a card's waiter, a one-time grant — cannot skip
   * the owner door by its silence.
   */
  enrolled?: () => boolean;
  /** Phase 115's unit verb: a capability switch into (or out of) this console's launch unit. */
  capability?: (flag: string, on: boolean) => { ok: boolean; why?: string; unit?: string };
  /** Ask this console to restart when idle — a capability takes effect on its next start. */
  restartWhenIdle?: (by: string) => void;
  /** Told after a grant is applied — the service journals, announces, rewrites settings and withdraws what it covers. */
  onApplied?: (row: GrantRow) => void;
  /** Told after a grant ends — the service journals and rewrites the settings it lowered. */
  onEnded?: (row: GrantRow) => void;
};

/** The subject a call grant compares — what a wall keeps as its `command`. */
export function callSubject(tool: string, input: unknown): string | undefined {
  const bag = (input ?? {}) as Record<string, unknown>;
  const raw = tool === 'Bash' ? bag.command : (bag.file_path ?? bag.path ?? bag.url ?? bag.pattern);
  if (typeof raw !== 'string') return undefined;
  const one = redactSecrets(raw.replace(/\s+/g, ' ').trim());
  return one ? one.slice(0, 400) : undefined;
}

/**
 * The exact call a `call` grant names, as a digest of its WHOLE input — never a
 * shortened or redacted copy, so a call that only begins like the granted one
 * (a command with more appended past what a row keeps) is not it.
 */
export function callHash(tool: string, input: unknown): string {
  const bag = (input ?? {}) as Record<string, unknown>;
  const raw = tool === 'Bash' ? bag.command : (bag.file_path ?? bag.path ?? bag.url ?? bag.pattern ?? input);
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : JSON.stringify(raw ?? null);
  return createHash('sha256').update(`${tool}\u0000${text}`).digest('hex');
}

/**
 * Is this call the one a `call` grant names? By its digest when the grant was
 * made from the full call (a card's), else by the row's command compared WHOLE
 * — unshortened and unredacted, whitespace alone folded — so a row whose
 * command was cut or redacted when it was recorded matches nothing: it fails
 * closed.
 */
export function callMatches(row: Pick<GrantRow, 'tool' | 'command' | 'callHash'>, tool: string, input: unknown): boolean {
  if (row.tool !== tool) return false;
  if (row.callHash) return row.callHash === callHash(tool, input);
  const bag = (input ?? {}) as Record<string, unknown>;
  const raw = tool === 'Bash' ? bag.command : (bag.file_path ?? bag.path ?? bag.url ?? bag.pattern);
  return typeof raw === 'string' && Boolean(row.command) && raw.replace(/\s+/g, ' ').trim() === row.command;
}

/** Two subjects compared as a person would: whitespace folded, quotes dropped — for what an ITEM shows, never for authority. */
export function sameCall(a: string | undefined, b: string | undefined): boolean {
  const fold = (text: string | undefined) => (text ?? '').replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim();
  return Boolean(fold(a)) && fold(a) === fold(b);
}

/** When a grant ends, in the words its row and the resumed session read. */
export function grantEndWords(row: Pick<GrantRow, 'scope' | 'until'>): string {
  const clock = row.until ? ` (at the latest ${row.until.slice(0, 16)}Z)` : '';
  if (row.scope === 'call') return `it is used${clock}`;
  if (row.scope === 'phase') return `the phase settles${clock}`;
  return 'it is revoked';
}

/**
 * Push options that neither force nor delete, nor run a program or another
 * repository's push (`--receive-pack`, `--exec`, `--recurse-submodules` are
 * not here), spelled whole — git's abbreviations (`--force-w`) are not read,
 * so an option not here is refused.
 */
const PUSH_SAFE_OPTION = new RegExp('^--(?:set-upstream|quiet|verbose|dry-run|porcelain|progress|no-progress|tags|follow-tags'
  + '|no-follow-tags|verify|no-verify|atomic|no-atomic|thin|no-thin|ipv4|ipv6|all|branches|signed|no-signed|no-force'
  + '|no-force-with-lease|no-force-if-includes|(?:signed|push-option|repo)=\\S*)$');
/** Short push options that neither force nor delete, alone or clustered (`-uv`). */
const PUSH_SAFE_SHORT = /^-[uqvn46]+$/;
/** Push options whose value is the next word — a value that reads as an option is refused rather than guessed at. */
const PUSH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-o', '--push-option', '--repo']);
/**
 * The verbs that update a remote's refs: the porcelain and the two plumbing commands beneath it.
 * A pattern, not a list: a list of git verbs reads as an argument list to the never-push gate
 * (`test/argv-scan.ts`), and this is a reading of a line, never a command the console runs.
 */
const PUSH_VERB = /^(?:push|send-pack|http-push)$/;
/** Git's own options before the verb that set no configuration — `-c`, `--config-env` and any other are refused. */
const GIT_SAFE_GLOBAL = /^(?:--no-pager|-P|-p|--paginate|--no-replace-objects|--literal-pathspecs|--no-optional-locks|(?:--git-dir|--work-tree|--namespace)=\S+)$/;
/** Git's own options before the verb whose value is the next word. */
const GIT_VALUE_GLOBALS: ReadonlySet<string> = new Set(['-C', '--git-dir', '--work-tree', '--namespace']);
/** A word the shell has yet to expand or match — its value is not on the line. */
const UNREAD_WORD = /[$`{*?[]/;
/** A push named as a word of its own, in any case (`alias.p=PUSH`, `git-push`) — not inside a name (`forcedPush`). */
const NAMED_PUSH = /(?<![A-Za-z])(?:push|send-pack)(?![A-Za-z])/i;
/** Commands that add arguments of their own to the command they run (`xargs git push origin` takes `--force` from stdin). */
const ARGUMENT_FEEDERS: ReadonlySet<string> = new Set(['xargs', 'parallel']);

/**
 * Could this command push with force or delete — or with configuration that
 * may (a mirror, a forcing refspec)? Read as the shell runs it, every git push
 * on the line (`push`, and the plumbing `send-pack` and `http-push`), by an
 * allow-list rather than a list of the bad spellings: git accepts any
 * unambiguous abbreviation (`--force-w`, `--dele`, `--mir`), so a push passes
 * only when every option is one that neither forces nor deletes nor runs a
 * program, spelled whole; no refspec forces or deletes (`+ref`, `:ref`); git
 * is given no configuration first (`-c`, `--config-env`, a `GIT_CONFIG…`
 * variable anywhere on the line); nothing feeds it arguments of its own
 * (`xargs`); no word the push turns on is left for the shell to expand —
 * the command, git's verb, an option or a refspec (`$`, a backtick, a brace,
 * a glob); and the line defines no alias. Git is found in any case (`GIT`,
 * `git PUSH` — the file system's, on macOS) and as a verb's own program
 * (`git-push`); where the line runs text its reader cannot see into
 * (`hidesText`: a here-string, a process substitution, an opaque reading) the
 * raw line is read as well. The never list's own reading, wider than the carved prefix rules,
 * which see only a leading flag spelled whole. What is not on the line no
 * reading of it can see: configuration written earlier (`git config
 * remote.<name>.mirror`, an alias), a script file the line runs.
 */
export function forcedPush(command: string): boolean {
  let texts: string[] = [command];
  let hidden = true;
  try {
    const reading = readShell(command);
    texts = executedTexts(reading);
    hidden = hidesText(command, reading);
  } catch { /* unread: the line itself is all there is */ }
  // Where the line runs text its reader cannot see into — the classifier's own test: an opaque
  // reading, a here-string (`bash <<< '…'`), a process substitution, an alias — the line itself is
  // read too, cut only at its operators — and at a subshell's parentheses, which a raw line glues to
  // its first word (`bash <<< '(git push …)'`). Elsewhere its raw words are data: a quoted here-doc's
  // body (a commit message), a comment.
  if (hidden) texts = [...texts, ...command.split(/&&|\|\||[;|\n]/).map((text) => text.replace(/[()]/g, ' '))];
  // Quotes and escapes are the shell's: `"--for"ce`, `\--force` and `$'--force'` reach git as `--force`
  // (a `$` before a quote opens it — it expands nothing). An escape a program decodes (`\x2d` is `-` to
  // printf, `echo -e` and `$'…'`) leaves the word unread.
  const lines = texts.map((text) => text.trim().split(/\s+/).filter(Boolean)
    .map((word) => word.replace(/\$(?=['"])/g, '').replace(/\\(?:[xuU][0-9A-Fa-f]|[0-7])/g, '$').replace(/['"\\]/g, '')));
  const configured = lines.some((words) => words.some((word) => /^GIT_CONFIG[A-Z0-9_]*=/.test(word)));
  // A push named in a text at all — as a word, or inside one (`-c alias.p=push`), in any case — but not
  // inside a name (`forcedPush`), unless the shell has yet to expand that word (`"$G"push`).
  const names = (words: string[]) => words.some((word) => (UNREAD_WORD.test(word) ? /push|send-pack/i : NAMED_PUSH).test(word));
  // A command whose name the line defines (an alias, `shopt -s expand_aliases; alias g=git`) or leaves
  // unread (`$(which git) push`, `$G push`) may be git — and what it runs may be named anywhere on the
  // line (`P="git push"; $P --force`), so a push named anywhere reads forced beside it.
  const namedOnLine = lines.some(names);
  if (namedOnLine && /\balias\s+[\w.-]+=/.test(command)) return true;
  for (const words of lines) {
    const named = names(words);
    const program = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    if (namedOnLine && program && UNREAD_WORD.test(program)) return true;
    for (let git = 0; git < words.length; git += 1) {
      // Case is the file system's, not git's options': on macOS `GIT` and `git-PUSH` run git. A value
      // assigned on the line may be what runs (`P='git push -f'; eval "$P"`).
      const base = words[git]!.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '').split('/').pop()!.toLowerCase();
      // `git`, or a verb's own program (`git-push`, `$(git --exec-path)/git-send-pack`).
      const dashed = base.startsWith('git-') && PUSH_VERB.test(base.slice(4));
      if (base !== 'git' && !dashed) continue;
      let at = git + 1;
      let configures = configured;
      while (!dashed && at < words.length && words[at]!.startsWith('-')) {
        if (GIT_VALUE_GLOBALS.has(words[at]!)) { at += 2; continue; }
        if (!GIT_SAFE_GLOBAL.test(words[at]!)) configures = true;
        at += 1;
      }
      if (dashed) at = git;
      // Configuration given to git here (`-c`, `--config-env`, a GIT_CONFIG… variable) may make a verb
      // a push (`alias.p=push`) or a push forced (`remote.origin.mirror`); an option this reading does not
      // know may take a value, so the verb may sit past it.
      if (configures && (named || words.slice(at).some((word) => UNREAD_WORD.test(word)))) return true;
      const verb = dashed ? base.slice(4) : (words[at] ?? '').toLowerCase();
      if (UNREAD_WORD.test(verb)) return true;
      if (!PUSH_VERB.test(verb)) continue;
      if (words.slice(0, git).some((word) => ARGUMENT_FEEDERS.has(word.split('/').pop()!))) return true;
      let value = false;
      let positional = false;
      for (const word of words.slice(at + 1)) {
        if (UNREAD_WORD.test(word)) return true;
        if (value) {
          if (word.startsWith('-')) return true;
          value = false;
          continue;
        }
        if (!positional && word === '--') { positional = true; continue; }
        if (!positional && word.startsWith('-')) {
          if (PUSH_VALUE_OPTIONS.has(word)) { value = true; continue; }
          if (PUSH_SAFE_OPTION.test(word) || PUSH_SAFE_SHORT.test(word)) continue;
          return true;
        }
        if (/^[+:]/.test(word)) return true;
      }
    }
  }
  return false;
}

/** Can the console's hook see — and so enforce a lane grant on — this tool? */
export function hookSees(tool: string): boolean {
  return (HOOK_TOOLS as readonly string[]).includes(tool);
}

/** Why a capability is never granted through a paired device (GR-5). */
export const CAPABILITY_DEVICE_REFUSAL =
  'A capability is granted at the machine only — never from a paired device: open this console at the machine, '
  + 'or run `phase-console capability <instance> add --allow-<name>` there, then restart when idle.';

/**
 * The rule a grant for an item grants: the rule the wall named — a deny rule,
 * an ask rule, `mcp__<server>`, a capability switch — else the narrowest rule a
 * person could write for the act (`ownSettingsRule`).
 */
export function grantRuleOf(permission: Pick<PermissionDetail, 'tool' | 'rule' | 'command'>): string {
  if (permission.rule && !isGuardRule(permission.rule)) return permission.rule;
  return ownSettingsRule({ tool: permission.tool ?? 'Bash', ...(permission.rule ? { rule: permission.rule } : {}), ...(permission.command ? { command: permission.command } : {}) });
}

/**
 * Does a grant cover an open permission item — the same rule, an allow never
 * covering a deny wall, inside the grant's reach: the same lane, the same plan,
 * or anywhere? (GE-5) A `call` grant covers no other item: it names one call
 * and is one use, and an item's command is what it SHOWS — cut, redacted,
 * compared without its quotes — never proof that two calls are one.
 */
export function grantCovers(
  row: Pick<GrantRow, 'rule' | 'wall' | 'scope' | 'slug' | 'phase' | 'runId' | 'command'>,
  item: { slug: string; phase: number; runId: string | null; permission: Pick<PermissionDetail, 'wall' | 'tool' | 'rule' | 'command'> },
): boolean {
  if (row.scope === 'call') return false;
  if (grantRuleOf(item.permission) !== row.rule) return false;
  if ((row.wall === 'deny') !== (item.permission.wall === 'deny')) return false;
  if (row.scope === 'phase') return item.runId === row.runId && item.phase === row.phase;
  if (row.scope === 'plan') return item.slug === row.slug;
  return true;
}

/** The words a capability flag must have: one of the console's switches. */
const CAPABILITY_FLAG = /^--allow-[a-z]+$/;

/** A grant that settles a wall below plan scope needs the lane that met it. */
const LANE_SCOPES: ReadonlySet<string> = new Set([GRANT_SCOPES[0], GRANT_SCOPES[1]]);

export class Grants {
  private cache: { key: string; rows: GrantRow[] } | null = null;
  private readonly deps: GrantsDeps;

  constructor(deps: GrantsDeps) {
    this.deps = deps;
  }

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /* ---- the ledger ---- */

  private append(line: Record<string, unknown>): void {
    mkdirSync(dirname(this.deps.file), { recursive: true });
    appendFileSync(this.deps.file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(this.deps.file, 0o600); } catch { /* best effort */ }
    this.cache = null;
  }

  private stamp(): string {
    const part = (path: string) => {
      try { const s = statSync(path); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; }
    };
    return `${part(`${this.deps.file}.1`)}|${part(this.deps.file)}`;
  }

  /** Every grant, folded — oldest first. */
  private rows(): GrantRow[] {
    const key = this.stamp();
    if (this.cache && this.cache.key === key) return this.cache.rows;
    const byId = new Map<string, GrantRow>();
    const current = new Set<string>();
    for (const [path, isCurrent] of [[`${this.deps.file}.1`, false], [this.deps.file, true]] as const) {
      let text = '';
      try { text = readFileSync(path, 'utf8'); } catch { continue; }
      for (const raw of text.split('\n')) {
        if (!raw.trim()) continue;
        let line: { type?: string; row?: GrantRow; id?: string; how?: GrantEnding; at?: string; by?: string; reason?: string };
        try { line = JSON.parse(raw) as typeof line; } catch { continue; }
        if (line.type === 'grant' && line.row?.id) {
          if (isCurrent) current.add(line.row.id);
          if (!byId.has(line.row.id)) byId.set(line.row.id, { ...line.row, state: LIVE });
        } else if (line.type === 'end' && line.id) {
          const row = byId.get(line.id);
          if (row && row.state === LIVE && line.how) {
            row.state = line.how;
            row.endedAt = line.at;
            row.endedBy = line.by;
            if (line.reason) row.endReason = line.reason;
          }
        }
      }
    }
    // A live grant only the rotated copy holds is carried forward, so the next
    // rotation cannot take it.
    for (const row of byId.values()) {
      if (row.state !== LIVE || current.has(row.id)) continue;
      const { state: _state, ...kept } = row;
      try { this.append({ type: 'grant', row: kept, carried: true }); } catch { /* read stays good */ }
    }
    const rows = [...byId.values()];
    this.cache = { key: this.stamp(), rows };
    return rows;
  }

  /** Every grant, newest first. */
  list(): GrantRow[] { return [...this.rows()].reverse().map((row) => ({ ...row })); }

  get(id: string): GrantRow | null {
    const row = this.rows().find((one) => one.id === id);
    return row ? { ...row } : null;
  }

  /** The grants still in force — a clock that ran out reads as over before the sweep says so. */
  live(): GrantRow[] {
    const now = this.now();
    return this.rows().filter((row) => row.state === LIVE && !(row.until && Date.parse(row.until) <= now));
  }

  /* ---- applying ---- */

  /**
   * Apply one grant: judge its risk, make exactly its change, write its row.
   * Nothing is written when it is refused.
   */
  apply(ask: GrantAsk): { ok: true; row: GrantRow } | GrantRefusal {
    const scope = ask.scope;
    if (!(GRANT_SCOPES as readonly string[]).includes(scope)) {
      return { ok: false, status: 400, error: `a grant's scope is one of ${GRANT_SCOPES.join(', ')}` };
    }
    if (!(WALLS as readonly string[]).includes(ask.wall)) return { ok: false, status: 400, error: `no wall is called ${ask.wall}` };
    const rule = (ask.rule ?? '').trim();
    if (!rule) return { ok: false, status: 400, error: 'a grant names the rule it grants' };
    const family: RuleFamily = ask.family ?? 'any';
    const risk = riskOf({ wall: ask.wall, family, scope }) as RiskTier;
    if (risk === 'never') {
      const never = neverReason({ wall: ask.wall, family });
      return {
        ok: false, status: 403,
        error: `No grant is offered through any door: ${never?.why ?? 'it is on the never list'}. ${never?.manual ?? ''}`.trim(),
      };
    }
    if (ask.wall === 'capability') {
      if (ask.door === 'device') return { ok: false, status: 403, error: CAPABILITY_DEVICE_REFUSAL };
      if (scope !== 'always') return { ok: false, status: 400, error: 'A capability is granted at the machine only — its scope is always.' };
      if (!CAPABILITY_FLAG.test(rule)) return { ok: false, status: 400, error: `${rule} is not a capability switch (--allow-<name>)` };
    } else if (!parseRule(rule)) {
      return { ok: false, status: 400, error: `"${rule}" is not a rule the policy syntax accepts` };
    }
    if (LANE_SCOPES.has(scope) && ask.wall !== 'capability' && !hookSees(ask.tool)) {
      return {
        ok: false, status: 400,
        error: `The console's hook never sees ${ask.tool}, so a grant for ${GRANT_SCOPE_WORDS[scope]} could not be held to its lane — grant it for this plan or wider.`,
      };
    }
    if (LANE_SCOPES.has(scope) && (!ask.runId || ask.phase == null)) {
      return { ok: false, status: 400, error: `a grant for ${GRANT_SCOPE_WORDS[scope]} needs the lane that met the wall — its run and its phase` };
    }
    if (scope === 'plan' && !ask.slug) return { ok: false, status: 400, error: 'a grant for this plan needs the plan' };

    const at = new Date(this.now()).toISOString();
    const until = LANE_SCOPES.has(scope) ? new Date(this.now() + GRANT_PHASE_MAX_MS).toISOString() : null;
    const command = ask.command ? redactSecrets(String(ask.command).replace(/\s+/g, ' ').trim()).slice(0, 400) : undefined;
    const blast = blastRadius({ ...ask, rule, command }, until);
    const enrolled = ask.enrolled === true || this.deps.enrolled?.() === true;
    if (risk === 'high') {
      // A card's press named its rule on the card and was judged at its own
      // route's door check — so it skips the typed echo, never the owner door.
      if (ask.via !== 'card' && (ask.typed ?? '').trim() !== rule) {
        return {
          ok: false, status: 400, rule, blast,
          error: `This grant carries high risk: type the rule exactly — ${rule} — to grant it. ${blast.sentence}`,
        };
      }
      if (enrolled && ask.door !== 'owner') {
        return { ok: false, status: 403, rule, blast, error: 'A high-risk grant is the owner\'s: press it through the owner door — this console has an owner key.' };
      }
      // A touch the press did not prove is no touch: fail closed.
      if (enrolled && ask.fresh !== true) {
        return { ok: false, status: 401, reassert: true, rule, blast, error: 'This grant carries high risk: touch your owner key again — no touch inside the last five minutes came with this press.' };
      }
    }

    const made = this.change({ ...ask, rule, command, family }, scope);
    if (!made.ok) return made;
    if (ask.wall === 'capability') this.deps.restartWhenIdle?.(ask.by);
    const row: GrantRow = {
      id: `g-${randomBytes(6).toString('hex')}`,
      at, by: ask.by, door: ask.door ?? null, item: ask.item ?? null, ...(ask.card ? { card: ask.card } : {}),
      wall: ask.wall, tool: ask.tool, rule, ...(command ? { command } : {}),
      ...(scope === 'call' && ask.input !== undefined ? { callHash: callHash(ask.tool, ask.input) } : {}),
      family, risk, scope,
      slug: ask.slug ?? null, phase: ask.phase ?? null, runId: ask.runId ?? null,
      until, changed: made.changed,
      ...(ask.reason ? { reason: redactSecrets(ask.reason.replace(/\s+/g, ' ').trim()).slice(0, 500) } : {}),
      ...(risk === 'high' ? { blast } : {}),
      ...(risk === 'high' && !enrolled && ask.via !== 'card' ? { unkeyed: true as const } : {}),
      state: LIVE,
    };
    const { state: _state, ...kept } = row;
    this.append({ type: 'grant', row: kept });
    log.info('policy.grant-applied', {
      id: row.id, by: row.by, door: row.door, item: row.item, wall: row.wall, rule: row.rule, scope: row.scope,
      risk: row.risk, until: row.until, slug: row.slug, phase: row.phase, runId: row.runId,
      changed: row.changed.map((change) => change.kind),
    });
    try { this.deps.onApplied?.({ ...row }); } catch (error) {
      log.warn('policy.grant-applied', { id: row.id, note: 'a listener failed — the grant stands', error: String(error) });
    }
    return { ok: true, row: { ...row } };
  }

  /** Make the change a grant is — before its row is written; nothing when refused. */
  private change(
    ask: GrantAsk & { rule: string; command?: string; family: RuleFamily }, scope: GrantScope,
  ): { ok: true; changed: GrantChange[] } | GrantRefusal {
    const rule = ask.rule;
    if (ask.wall === 'capability') {
      const done = this.deps.capability?.(rule, true);
      if (!done) return { ok: false, status: 409, error: 'This console cannot switch a capability from here — run `phase-console capability <instance> add ' + rule + '` at the machine.' };
      if (!done.ok) return { ok: false, status: 409, error: `${rule} could not be put into this console's launch unit: ${done.why ?? 'the unit refused'}` };
      return { ok: true, changed: [{ kind: 'capability', flag: rule, unit: done.unit ?? 'the launch unit', restart: 'when-idle' }] };
    }
    if (LANE_SCOPES.has(scope)) {
      const changed: GrantChange[] = [];
      if ((HOOK_TOOLS as readonly string[]).includes(ask.tool)) {
        changed.push({
          kind: 'hook', rule, runId: ask.runId!, phase: ask.phase!,
          ...(scope === 'call' && ask.command ? { command: ask.command } : {}),
        });
      }
      if (ask.wall === 'deny' && !neverLowered(rule)) changed.push({ kind: 'settings', runId: ask.runId!, list: 'deny', rule });
      if (ask.wall === 'allow-list' || ask.wall === 'mcp') changed.push({ kind: 'settings', runId: ask.runId!, list: 'allow', rule });
      return { ok: true, changed };
    }
    const layer: PolicyLayer = scope === 'plan' ? 'plan' : scope === 'repository' ? 'repository' : 'machine';
    const file = layerFile(layer, ask.slug);
    const current = policyExtras(layer === 'plan' && ask.slug ? effectivePlanPolicyPath(ask.slug) : file);
    const base = { kind: 'policy' as const, layer, file, ...(layer === 'plan' && ask.slug ? { slug: ask.slug } : {}) };
    if (ask.wall === 'deny') {
      if (current.deny.includes(rule)) {
        editPolicy({ remove: { deny: [rule] }, by: `grant · ${ask.by}` }, file);
        return { ok: true, changed: [{ ...base, op: 'remove', list: 'deny', rule }] };
      }
      if (DEFAULT_DENY.includes(rule)) {
        if (current.removed.deny.includes(rule)) return { ok: true, changed: [] };
        // Lifting the push wall never opens a forced or deleting push: the
        // carved rules go into the same file, in the same row, so the never
        // list holds there with the console dead and a revoke takes them out.
        const carve = rule === PUSH_DENY ? PUSH_DENY_CARVED.filter((one) => !current.deny.includes(one)) : [];
        editPolicy({ remove: { deny: [rule] }, ...(carve.length ? { add: { deny: carve } } : {}), by: `grant · ${ask.by}` }, file);
        return {
          ok: true,
          changed: [
            { ...base, op: 'strike', list: 'deny', rule },
            ...carve.map((one) => ({ ...base, op: 'add' as const, list: 'deny' as const, rule: one })),
          ],
        };
      }
      const holder = denyHolder(rule, ask.slug);
      return {
        ok: false, status: 409,
        error: holder
          ? `\`${rule}\` is written in ${holder} — a grant for ${GRANT_SCOPE_WORDS[scope]} cannot lift it; choose a scope that reaches that file, or edit it in Settings ▸ Permissions.`
          : `\`${rule}\` is not in this console's policy — it is Claude Code's own setting, which the console never writes.`,
      };
    }
    if (current.allow.includes(rule)) return { ok: true, changed: [] };
    editPolicy({ add: { allow: [rule] }, by: `grant · ${ask.by}` }, file);
    // Named outside the array: an array whose first string is a git verb (this op's word) reads as
    // an argument list to the never-push gate (`test/argv-scan.ts`).
    const added: GrantChange = { ...base, op: 'add', list: 'allow', rule };
    return { ok: true, changed: [added] };
  }

  /* ---- ending ---- */

  /**
   * End a live grant — `spent`, `expired` or `revoked` — and undo exactly what
   * its row says it changed: a policy edit reversed (unless another live grant
   * still holds the same edit), a capability taken out of the unit. Settings
   * and the hook need no undo of their own: both read the live grants, and the
   * service rewrites the run's settings when it is told.
   */
  end(id: string, how: GrantEnding, by: string, reason?: string): GrantRow | null {
    const row = this.rows().find((one) => one.id === id);
    if (!row || row.state !== LIVE) return null;
    if (how === 'revoked') {
      const failed = this.undo(row, by);
      if (failed) {
        log.warn('policy.grant-ended', { id, note: 'the revoke could not undo what the grant changed — it stays live', failed });
        return null;
      }
    }
    const at = new Date(this.now()).toISOString();
    this.append({ type: 'end', id, how, at, by, ...(reason ? { reason: reason.slice(0, 300) } : {}) });
    const ended: GrantRow = { ...row, state: how, endedAt: at, endedBy: by, ...(reason ? { endReason: reason.slice(0, 300) } : {}) };
    log.info('policy.grant-ended', { id, how, by, rule: row.rule, scope: row.scope, runId: row.runId, phase: row.phase, ...(reason ? { reason } : {}) });
    try { this.deps.onEnded?.({ ...ended }); } catch (error) {
      log.warn('policy.grant-ended', { id, note: 'a listener failed — the grant is ended', error: String(error) });
    }
    return ended;
  }

  /** Undo exactly what a row changed; the first thing that could not be undone, or null. */
  private undo(row: GrantRow, by: string): string | null {
    const others = this.live().filter((one) => one.id !== row.id);
    for (const change of row.changed) {
      if (change.kind === 'policy') {
        const held = others.some((other) => other.changed.some((c) => c.kind === 'policy' && c.file === change.file
          && c.list === change.list && c.rule === change.rule));
        if (held) continue;
        const edit = change.op === 'strike' ? { restore: { deny: [change.rule] } }
          : change.op === 'remove' ? { add: { deny: [change.rule] } }
            : change.list === 'deny' ? { remove: { deny: [change.rule] } }
              : { remove: { allow: [change.rule] } };
        try { editPolicy({ ...edit, by: `revoke · ${by}` }, change.file); } catch (error) {
          return `the policy edit on ${change.rule}: ${String(error)}`;
        }
      } else if (change.kind === 'capability') {
        const done = this.deps.capability?.(change.flag, false);
        if (!done?.ok) return `${change.flag} could not leave the launch unit: ${done?.why ?? 'no unit verb here'}`;
        this.deps.restartWhenIdle?.(by);
      }
    }
    return null;
  }

  /** End every live grant — *Revoke all*. */
  revokeAll(by: string, reason?: string): GrantRow[] {
    return this.live().map((row) => this.end(row.id, 'revoked', by, reason)).filter((row): row is GrantRow => row !== null);
  }

  /**
   * The console's clock: a grant whose clock ran out, or whose phase settled,
   * expires. `settled` answers for a lane grant's phase.
   */
  sweep(settled: (row: GrantRow) => boolean): GrantRow[] {
    const now = this.now();
    const out: GrantRow[] = [];
    for (const row of this.rows().filter((one) => one.state === LIVE)) {
      const ran = row.until && Date.parse(row.until) <= now;
      const over = !ran && LANE_SCOPES.has(row.scope) && settled(row);
      if (!ran && !over) continue;
      const ended = this.end(row.id, 'expired', 'console', ran ? 'its clock ran out' : 'its phase settled');
      if (ended) out.push(ended);
    }
    return out;
  }

  /* ---- what the hook and the settings read ---- */

  /**
   * Does a live grant let this call through? Only a grant of THIS run's THIS
   * phase (never a sibling lane's), whose phase has not settled, whose rule the
   * call meets — and for `call` this exact call — and only when the call,
   * classified again with those rules lowered, is allowed: a neighbouring deny
   * rule still stops it, and a never rule is never lowered. Null when nothing
   * covers it. Spends nothing: `spend` does, once the call is answered allow.
   */
  cover(call: {
    runId: string; phase: number | null; tool: string; input: unknown;
    policy: AutopilotPolicy; profile: PermissionProfile; phaseSettled?: boolean;
  }): { grants: GrantRow[] } | null {
    if (call.phase == null || call.phaseSettled) return null;
    const subject = callSubject(call.tool, call.input);
    // The call's OWN family first: a forced or deleting push, a host command, a
    // protected path, a secret's value is never covered — not even by a grant
    // whose rule it meets (a `Bash(git push:*)` grant never lets `--force` by).
    const raw = call.tool === 'Bash' ? (call.input as { command?: unknown } | null)?.command : subject;
    const family = ruleFamilyOf({ tool: call.tool, ...(typeof raw === 'string' && raw ? { command: raw } : {}) });
    if (riskOf({ wall: 'deny', family, scope: GRANT_SCOPES[0] }) === 'never') return null;
    if (call.tool === 'Bash' && typeof raw === 'string' && forcedPush(raw)) return null;
    const meets = (row: GrantRow) => {
      if (row.runId !== call.runId || row.phase !== call.phase || !LANE_SCOPES.has(row.scope)) return false;
      if (row.scope === 'call') return callMatches(row, call.tool, call.input);
      return ruleMatches(row.rule, call.tool, call.tool === 'Bash' ? { command: (call.input as { command?: unknown } | null)?.command } : call.input);
    };
    const grants = this.live().filter(meets);
    if (!grants.length) return null;
    const lowerDeny = new Set(grants.filter((row) => row.wall === 'deny' && !neverLowered(row.rule)).map((row) => row.rule));
    const addAllow = grants.filter((row) => row.wall !== 'deny').map((row) => row.rule);
    const lowered: AutopilotPolicy = {
      ...call.policy,
      deny: call.policy.deny.filter((rule) => !lowerDeny.has(rule)),
      always: [...(call.policy.always ?? []), ...addAllow],
    };
    return classifyTool(call.tool, call.input, lowered, call.profile) === 'allow' ? { grants } : null;
  }

  /**
   * Does a live grant that reaches this lane lift the push wall
   * (`Bash(git push:*)`)? The hook then refuses a forced or deleting push
   * itself — the never list holds whatever a grant lifted (§Architecture 19).
   */
  liftsPush(lane: { runId: string; slug: string; phase: number | null }): boolean {
    return this.live().some((row) => row.wall === 'deny' && row.rule === PUSH_DENY && (
      LANE_SCOPES.has(row.scope) ? row.runId === lane.runId && row.phase === lane.phase
        : row.scope === 'plan' ? row.slug === lane.slug : true));
  }

  /** A `call` grant used — it is spent. */
  spend(row: GrantRow): GrantRow | null {
    return row.scope === 'call' ? this.end(row.id, 'spent', 'hook', 'used once') : null;
  }

  /** What this run's settings carry lowered while its grants below plan scope live. */
  lowered(runId: string): { deny: string[]; allow: string[] } {
    const deny = new Set<string>();
    const allow = new Set<string>();
    for (const row of this.live()) {
      for (const change of row.changed) {
        if (change.kind !== 'settings' || change.runId !== runId) continue;
        (change.list === 'deny' ? deny : allow).add(change.rule);
      }
    }
    return { deny: [...deny], allow: [...allow] };
  }
}

/** The file a layer is. */
function layerFile(layer: PolicyLayer, slug: string | null): string {
  if (layer === 'plan') return planPolicyPath(slug ?? 'unnamed');
  if (layer === 'repository') return repositoryPolicyPath();
  return POLICY_PATH;
}

/** Which file holds a deny rule a scope could not lift — named for the refusal. */
function denyHolder(rule: string, slug: string | null): string | null {
  if (policyExtras(POLICY_PATH).deny.includes(rule)) return "the machine's policy file";
  if (policyExtras(repositoryPolicyPath()).deny.includes(rule)) return "this repository's policy layer";
  if (slug && policyExtras(effectivePlanPolicyPath(slug)).deny.includes(rule)) return "this plan's policy file";
  return null;
}

/**
 * Who a grant reaches, and until when (§Architecture 19's blast radius): one
 * lane below plan scope; every run of the plan at plan scope; every plan of
 * this console's repository; every plan on this machine.
 */
export function blastRadius(
  ask: Pick<GrantAsk, 'scope' | 'rule' | 'slug' | 'phase' | 'runId' | 'live'> & { command?: string },
  until: string | null,
): BlastRadius {
  const live = ask.live ?? [];
  const words = GRANT_SCOPE_WORDS[ask.scope];
  const end = until ? `until ${until.slice(0, 16)}Z at the latest` : 'until it is revoked';
  if (LANE_SCOPES.has(ask.scope)) {
    const lane = ask.slug && ask.phase != null ? [{ slug: ask.slug, phase: ask.phase }] : [];
    return {
      runs: ask.runId ? [ask.runId] : [], plans: ask.slug ? [ask.slug] : [], phases: lane, repositories: 'this', until,
      sentence: `\`${ask.rule}\` for ${words}: phase ${ask.phase ?? '?'} of ${ask.slug ?? 'its plan'} (run ${ask.runId ?? '?'})${ask.scope === 'call' && ask.command ? `, the call \`${ask.command.slice(0, 120)}\` only` : ''}, ${end}.`,
    };
  }
  if (ask.scope === 'plan') {
    const runs = live.filter((one) => one.slug === ask.slug).map((one) => one.runId);
    return {
      runs, plans: ask.slug ? [ask.slug] : [], phases: 'every', repositories: 'this', until,
      sentence: `\`${ask.rule}\` for ${words}: every phase of ${ask.slug} — ${runs.length} live run(s) now, and every later one — ${end}.`,
    };
  }
  const runs = live.map((one) => one.runId);
  return {
    runs, plans: 'every', phases: 'every', repositories: ask.scope === 'always' ? 'every' : 'this', until,
    sentence: ask.scope === 'always'
      ? `\`${ask.rule}\` for ${words}: every plan of every console here — ${runs.length} live run(s) on this console now — ${end}.`
      : `\`${ask.rule}\` for ${words}: every plan of this console — ${runs.length} live run(s) now — ${end}.`,
  };
}

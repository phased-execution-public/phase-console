/**
 * Approvals: pausing an unattended run to ask a person.
 *
 * ## What actually holds, measured rather than assumed
 *
 * Claude Code's `http` PreToolUse hook **fails open**. Probed against a real
 * session with nothing listening on the hook URL: the tool call went straight
 * through, no error, no block. Probed with the broker answering `deny`: the
 * call was blocked and the session adapted. Both are true, and the first one
 * decides the architecture.
 *
 * So this module builds settings in two layers that must not be confused:
 *
 *   **`permissions.deny` — the wall.** Evaluated inside the CLI with no
 *   network involved, verified to hold with the broker unreachable. Everything
 *   that must never happen unattended lives here. Nothing can approve past it;
 *   a person runs those commands themselves, deliberately.
 *
 *   **`ask` + the HTTP hook — the workflow.** For work that *may* proceed with
 *   a human's say-so. The hook parks the session, shows evidence, and waits.
 *   It is a convenience with a nice phone interface, and if the console dies it
 *   silently stops existing — which is exactly why nothing dangerous may depend
 *   on it alone.
 *
 * A bare "Deploy? [y/n]" would automate the ceremony of approval and delete its
 * substance, so every card carries the evidence a person would have gone and
 * looked up: the command, the phase, the diff, the verification output.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { log } from '../log.ts';
import { toolStanding } from '../../shared/cli-tools.js';
import { POLICY_ADVISORY_KINDS } from '../../shared/ops-vocab.js';
import { POLL_STATUS_TOOLS } from '../../shared/poll-loop.js';
import { INSTANCE, INSTANCE_STATE_DIR, notifyCommand } from '../config.ts';
import {
  DEFAULT_PERMISSION_PROFILE, PERMISSION_PROFILES, PROFILE_LABELS,
} from '../../shared/run-settings.js';
import type { QuestionAnsweredBy, RelayMechanism } from '../../shared/relay-model.js';

/* ------------------------------------------------------------------ *
 * The two lists
 * ------------------------------------------------------------------ */

/**
 * Never, whatever anyone clicks. These reach a remote, spend money, destroy
 * data, or take the guard rails off — and an unattended agent has no business
 * doing any of them at 3am on the strength of a tap on a phone.
 *
 * Deliberately conservative and deliberately generic: this file ships in a
 * public skill, so repository-specific rules belong in the operator's own
 * `autopilot.json` rather than here.
 */
export const DEFAULT_DENY = [
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(git clean:*)',
  'Bash(sudo:*)',
  'Bash(terraform apply:*)',
  'Bash(terraform destroy:*)',
  'Bash(npm publish:*)',
  'Bash(pnpm publish:*)',
  'Bash(yarn publish:*)',
  'Bash(docker push:*)',
  'Bash(kubectl delete:*)',
  'Bash(kubectl apply:*)',
  'Bash(shutdown:*)',
  'Bash(reboot:*)',
  'Bash(mkfs:*)',
  'Bash(dd:*)',
];

/**
 * The verbs that write state SEVERAL WORKING TREES SHARE (SHR-1, MIR-2).
 *
 * 🔴 A linked worktree is not an isolated repository. Every tree of one
 * repository shares the object database, `refs/stash`, and `.git/config` —
 * measured, all three — so:
 *
 *  - `git stash` in a lane pushes onto the stack another lane (and the
 *    operator's own shell) pops from. The skill's own boot prompt warns a
 *    session never to use bare `stash` for exactly this reason.
 *  - `git config core.hooksPath …` rewrites the hooks for every tree at once,
 *    because the common config is shared.
 *  - `git submodule update` inside a mirror's ROOT mount DETACHES the sibling
 *    submodule mount — so `validateMirror` answers false, the run refuses
 *    `worktree-failed`, and the whole mirror degrades permanently (MIR-2).
 *  - `git worktree`, `git checkout` and `git switch` move a tree off the branch
 *    the console's lock, its carve-out and its merge-back all name.
 *
 * All six were forbidden in prose — four times, in three documents and a boot
 * prompt — and enforced nowhere at all.
 */
export const SHARED_STATE_ASK = [
  'Bash(git stash:*)',
  'Bash(git config:*)',
  'Bash(git worktree:*)',
  'Bash(git submodule:*)',
  'Bash(git checkout:*)',
  'Bash(git switch:*)',
];

/**
 * Filing, commenting on and closing an issue — outward-facing acts, like a push.
 *
 * A session that spots a defect outside its phase should be able to say so, and
 * the issues estate (decision 18) is how; but an issue is visible to everyone
 * who reads the repository, and the deal for anything a run makes visible is
 * the same one `OPEN_PR_ASK` has: one human tap. Pinned through every profile
 * for that reason and not because they are dangerous.
 */
export const ISSUE_ASK = [
  'Bash(gh issue create:*)',
  'Bash(gh issue comment:*)',
  'Bash(gh issue close:*)',
];

/**
 * The ask rules a PROFILE may not empty.
 *
 * `trusted` and `bypass` exist to stop asking about the everyday steps of the
 * work — a commit, an install, a migration. They were never meant to hand a
 * session the verbs that reach OUT of its own tree, and nothing said so: a
 * `trusted` run's ask list was emptied wholesale, so the six shared-state verbs
 * and the three issue verbs were auto-allowed on exactly the runs nobody is
 * watching.
 *
 * It is a DEFAULT, not a second wall. `deny` is the wall. Everything here is
 * struck by name through the policy file like any other shipped rule, and a pin
 * that survived a named strike would be the one rule an operator could not
 * remove — which is the shape the deny half was deliberately moved away from.
 * The pin keeps a rule the policy HOLDS; it never adds one back.
 */
export const ALWAYS_ASK: readonly string[] = Object.freeze([...SHARED_STATE_ASK, ...ISSUE_ASK]);

/**
 * Allowed, but only with a person in the loop. These are the everyday
 * irreversible-ish steps of real work — a commit, a migration, a dependency
 * install — that a run should be able to reach, but not on its own.
 */
export const DEFAULT_ASK = [
  'Bash(git commit:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr merge:*)',
  'Bash(npm install:*)',
  'Bash(pnpm add:*)',
  'Bash(alembic upgrade:*)',
  'Bash(psql:*)',
  'Bash(ssh:*)',
  'WebFetch',
  // The hook matcher has always covered WebSearch; the ask list did not, so it
  // was silently auto-allowed while its sibling raised a card.
  'WebSearch',
  // The shared-`.git` verbs and the issue verbs — see `ALWAYS_ASK`, which is
  // what keeps these six raising a card under `trusted` and `bypass` too.
  ...SHARED_STATE_ASK,
  ...ISSUE_ASK,
];

/**
 * Read-only work a phase does constantly, pre-approved so it never round-trips
 * to the hook.
 *
 * These ride at CLI scope, and permission rules **merge** across scopes rather
 * than override — so this adds to whatever the repository already allows, never
 * replaces it. That matters because a repository's own `.claude/settings.json`
 * allow rules are ignored until someone has accepted the workspace trust prompt
 * there, and a session that has lost them still has to be able to look around.
 */
export const DEFAULT_ALLOW = [
  // The three task tools together, not one of them. `TodoWrite` was here from
  // the start and its two successors were not, so on any CLI that provisions
  // `TaskCreate`/`TaskUpdate` a session's every task write round-tripped to the
  // hook — for a call that writes a list into a panel and touches nothing.
  'Read', 'Glob', 'Grep', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'NotebookRead',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(git branch:*)', 'Bash(git rev-parse:*)', 'Bash(git ls-files:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
  'Bash(find:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(jq:*)', 'Bash(pwd:*)',
  'Bash(echo:*)', 'Bash(which:*)', 'Bash(node --version:*)', 'Bash(python3 --version:*)',
];

export type AutopilotPolicy = {
  deny: string[];
  ask: string[];
  allow: string[];
  /**
   * Rules the operator explicitly allowed — from a card's "Always…" button or
   * the Settings editor — which outrank `ask`.
   *
   * Evaluation is otherwise deny → ask → allow with first match winning and
   * specificity irrelevant, so a plain `allow` rule can never cancel an `ask`
   * rule: `Bash(git commit:*)` is on both lists and `ask` is reached first.
   * That would make "Always allow this" a button that writes a rule and
   * changes nothing, which is worse than not offering it. These are checked
   * immediately after `deny`, so the operator's own decision wins over the
   * built-in ask list and still loses to the wall.
   */
  always?: string[];
};

/* ------------------------------------------------------------------ *
 * The rule taxonomy
 * ------------------------------------------------------------------ */

/**
 * The tools whose calls actually reach the PreToolUse hook — the `matcher` in
 * `buildSettings` below. A rule about anything else is real, but it is enforced
 * by the CLI's own permission engine and this console never sees it, which is
 * a distinction the editor has to be able to show.
 *
 * The status tools ride along for the poll-loop guard (autopilot-token-drain
 * phase 2): a session polling with `ListAgents` never reached this console, so
 * nothing could stop it. They are read-only and cheap to answer, and the list
 * is the guard's own (`shared/poll-loop.js`), never a copy.
 */
export const HOOK_TOOLS = [
  'Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'AskUserQuestion', ...POLL_STATUS_TOOLS,
];

/** Tools whose *path* rules Claude Code does not consult at all. */
const PATH_RULES_IGNORED = ['Write', 'NotebookEdit', 'Glob'];

export type RuleForm =
  | 'bare' | 'prefix' | 'glob' | 'literal' | 'param'
  | 'path' | 'domain' | 'mcp' | 'agent' | 'cd';

export type ParsedRule = {
  raw: string;
  tool: string;
  spec?: string;
  form: RuleForm;
  /** `hook` = this console classifies it. `cli-only` = real, but enforced by the
   *  CLI. `ignored` = accepted by the syntax and silently does nothing. */
  support: 'hook' | 'cli-only' | 'ignored';
  note?: string;
};

/** The part of a tool call a rule is written against. */
function subjectOf(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const key = toolName === 'Bash' ? 'command'
    : toolName === 'WebFetch' || toolName === 'WebSearch' ? 'url'
      : toolName === 'Agent' ? 'subagent_type'
        : toolName === 'Cd' ? 'path'
          : 'file_path';
  const value = record[key]
    ?? record.command ?? record.file_path ?? record.path ?? record.url ?? record.pattern;
  return typeof value === 'string' ? value : '';
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `*` spans anything. Used for command globs, where there are no segments. */
function globPattern(glob: string): string {
  return glob.split('*').map(escape).join('.*');
}

/**
 * Path globs, where `**` crosses separators and `*` does not — `Cd(~/code/*)`
 * is one segment deep and `Cd(~/code/**)` is any depth, and conflating them
 * would silently widen every path rule anyone writes.
 */
function pathPattern(glob: string): string {
  return glob
    .split('**').map((part) => part.split('*').map(escape).join('[^/]*'))
    .join('.*');
}

/**
 * Normalise the documented path prefixes to something matchable.
 *
 * `//abs` is an absolute path, `~/x` is under home, `./x` is relative to the
 * working directory, and a bare name with no separator means the file anywhere
 * — `Read(.env)` is `Read(**​/.env)`, which is the form that actually protects
 * a secret. A single leading slash is "relative to the settings file", whose
 * location this console does not know, so it is matched as a suffix and
 * labelled approximate rather than silently treated as absolute.
 */
function normalisePath(spec: string, home: string): string {
  const path = spec.trim();
  if (path.startsWith('//')) return path.slice(1);
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`;
  if (path.startsWith('./')) return `**/${path.slice(2)}`;
  if (!path.includes('/')) return `**/${path}`;
  if (path.startsWith('/')) return `**${path}`;
  return `**/${path}`;
}

function pathMatches(spec: string, subject: string, home: string): boolean {
  if (!subject) return false;
  const pattern = normalisePath(spec, home);
  return new RegExp(`^${pathPattern(pattern)}$`).test(subject);
}

/** A tool-name pattern, which may be a glob or an MCP server prefix. */
function toolNameMatches(pattern: string, toolName: string): boolean {
  if (pattern === toolName || pattern === '*') return true;
  if (pattern.includes('*')) return new RegExp(`^${globPattern(pattern)}$`).test(toolName);
  // `mcp__server` covers every tool that server exposes.
  if (pattern.startsWith('mcp__') && !pattern.slice(5).includes('__')) {
    return toolName.startsWith(`${pattern}__`);
  }
  return false;
}

/** `key:value`, where the key is a real identifier — not a command prefix. */
const PARAM = /^([A-Za-z_][\w]*):(.*)$/s;

/**
 * Read one rule, or return null if it is not a rule at all.
 *
 * The form matters as much as the match: the editor has to be able to say "this
 * one is enforced here", "this one is the CLI's job", and "this one parses and
 * does nothing" — and the last category is the one that silently costs people
 * an afternoon.
 */
export function parseRule(raw: string, known?: ReadonlySet<string>): ParsedRule | null {
  const rule = raw.trim();
  if (!rule || rule.length > 200) return null;

  let tool = rule;
  let spec: string | undefined;
  const open = rule.indexOf('(');
  if (open !== -1) {
    if (!rule.endsWith(')')) return null;
    tool = rule.slice(0, open).trim();
    spec = rule.slice(open + 1, -1);
  }
  if (!/^[A-Za-z_*][\w*]*$/.test(tool)) return null;

  const isMcp = tool.startsWith('mcp__');
  const hooked = HOOK_TOOLS.includes(tool);
  const at = (form: RuleForm, support: ParsedRule['support'], note?: string): ParsedRule =>
    ({ raw: rule, tool, spec, form, support, note });

  // Two shapes the syntax accepts that can never match (TRS-12): a tool the
  // CLI does not provide — `git(:*)` is a COMMAND written where a tool goes —
  // and, below, a prefix rule whose prefix is empty. Both parse, both were
  // shown as enforced, and the same blind spot would void a deny rule.
  const standing = toolStanding(tool, known);
  if (standing === 'none') {
    return at(spec === undefined ? 'bare' : spec.endsWith(':*') ? 'prefix' : 'literal', 'ignored',
      `${tool} is not a tool Claude Code provides — a rule names a tool (Bash, Edit, WebFetch, mcp__<server>…), never a command`);
  }
  const unseen = standing === 'unseen' ? ` — no session on this console has offered a tool named ${tool}` : '';

  if (spec === undefined || spec === '*') {
    if (isMcp) return at('mcp', 'cli-only', 'MCP calls do not reach this console’s hook');
    return at('bare', hooked ? 'hook' : 'cli-only',
      hooked ? undefined : `${tool} calls do not reach this console’s hook`);
  }

  // The documented trap: it looks like a parameter rule and is simply dropped.
  if (tool === 'Bash' && /^command:/.test(spec)) {
    return at('param', 'ignored', 'Bash(command:…) is not a rule Claude Code honours — write Bash(<prefix>:*)');
  }
  if (PATH_RULES_IGNORED.includes(tool) && !PARAM.test(spec)) {
    return at('path', 'ignored', `${tool}(…) path rules are never consulted — only Read(…) and Edit(…) are`);
  }

  // Before the `:*` prefix form, which `domain:*` would otherwise satisfy —
  // and a domain rule read as a command prefix matches nothing at all.
  if ((tool === 'WebFetch' || tool === 'WebSearch') && spec.startsWith('domain:')) {
    return at('domain', 'hook');
  }
  // `:*` is a command prefix and is only meaningful at the end — and only
  // with a prefix: `Bash(:*)` tests `subject === '' || subject.startsWith(' ')`,
  // which no real command satisfies.
  if (spec === ':*') {
    return at('prefix', 'ignored', `${tool}(:*) has an empty prefix and matches nothing — write ${tool}(<prefix>:*)`);
  }
  if (spec.endsWith(':*') && !isMcp) {
    return at('prefix', hooked ? 'hook' : 'cli-only',
      hooked ? undefined : `${tool} calls do not reach this console’s hook${unseen}`);
  }
  if (tool === 'Read' || tool === 'Edit') {
    return at('path', tool === 'Edit' ? 'hook' : 'cli-only',
      tool === 'Read' ? 'Read calls do not reach this console’s hook' : undefined);
  }
  if (tool === 'Cd') return at('cd', 'cli-only', 'Cd is enforced by the CLI, not by this hook');
  if (tool === 'Agent' && !PARAM.test(spec)) {
    return at('agent', 'cli-only', 'Agent calls do not reach this console’s hook');
  }
  if (PARAM.test(spec)) {
    return at('param', hooked ? 'hook' : 'cli-only',
      hooked ? undefined : `${tool} calls do not reach this console’s hook`);
  }
  if (isMcp) return at('mcp', 'cli-only', 'MCP calls do not reach this console’s hook');
  return at(spec.includes('*') ? 'glob' : 'literal', hooked ? 'hook' : 'cli-only',
    hooked ? undefined : `${tool} calls do not reach this console’s hook`);
}

/**
 * Does a permission rule cover this call?
 *
 * `Tool` matches every use of that tool; `Tool(prefix:*)` matches on a command
 * prefix — at a word boundary, because `Bash(ls:*)` is `Bash(ls *)` and `lsof`
 * is not `ls`. Getting that wrong silently widens the built-in allow list,
 * which is the direction that matters.
 */
export function ruleMatches(
  rule: string, toolName: string, input: unknown, home = homedir(),
): boolean {
  const parsed = parseRule(rule);
  if (!parsed || parsed.support === 'ignored') return false;
  if (!toolNameMatches(parsed.tool, toolName)) return false;
  if (parsed.form === 'bare' || parsed.form === 'mcp') return true;

  const spec = parsed.spec as string;

  if (parsed.form === 'param') {
    const found = PARAM.exec(spec);
    if (!found) return false;
    const value = (input as Record<string, unknown> | null)?.[found[1]];
    if (value === undefined || value === null) return false;
    return new RegExp(`^${globPattern(found[2])}$`).test(String(value));
  }

  if (parsed.form === 'domain') {
    const subject = subjectOf(toolName, input);
    if (!subject) return false;
    let host: string;
    try { host = new URL(subject).hostname; } catch { return false; }
    const want = spec.slice('domain:'.length).trim();
    if (want === '*') return true;
    if (want.startsWith('*.')) return host.endsWith(want.slice(1));
    return host === want;
  }

  const subject = subjectOf(toolName, input);
  if (!subject) return false;

  if (parsed.form === 'path' || parsed.form === 'cd') return pathMatches(spec, subject, home);
  if (parsed.form === 'agent') return subject === spec;
  if (parsed.form === 'prefix') {
    const prefix = spec.slice(0, -2);
    return subject === prefix || subject.startsWith(`${prefix} `);
  }
  if (parsed.form === 'glob') return new RegExp(`^${globPattern(spec)}$`).test(subject);
  return subject === spec || subject.startsWith(`${spec} `);
}

/**
 * Rules that parse but do nothing, so the policy page can say so — including
 * (since phase 12) an empty-prefix rule and one naming a tool the CLI does
 * not provide. `known` is the set of tool names this console has seen a
 * session offer, so a tool newer than the shipped list is never called inert.
 */
export function inertRules(policy: AutopilotPolicy, known?: ReadonlySet<string>): ParsedRule[] {
  const seen = new Set<string>();
  const out: ParsedRule[] = [];
  for (const rule of [...policy.deny, ...policy.ask, ...policy.allow, ...(policy.always ?? [])]) {
    if (seen.has(rule)) continue;
    seen.add(rule);
    const parsed = parseRule(rule, known);
    if (!parsed) out.push({ raw: rule, tool: '', form: 'literal', support: 'ignored', note: 'not a rule this syntax accepts' });
    else if (parsed.support === 'ignored') out.push(parsed);
  }
  return out;
}

/** What the policy page and the boot log say about a policy that cannot do its job. */
export type PolicyAdvisoryKind = (typeof POLICY_ADVISORY_KINDS)[number];
export type PolicyAdvisory = {
  kind: PolicyAdvisoryKind;
  /** `ask-empty`: the struck ask rules; `deny-struck`: the struck deny rules. */
  rules: string[];
  /** One sentence for a banner or a log line. */
  message: string;
};

/**
 * The two states TRS-9 found live and unannounced: a merged ask list with
 * nothing on it (the profile picker then offers three postures that are one),
 * and a shipped deny rule struck out of the wall that holds with the console
 * dead. Pure over the merge and the strikes; the service emits it once per
 * boot and `GET /api/policy` carries it until acknowledged.
 */
export function policyAdvisory(policy: AutopilotPolicy, struck: PolicyRemovals): PolicyAdvisory[] {
  const out: PolicyAdvisory[] = [];
  if (policy.ask.length === 0) {
    out.push({
      kind: 'ask-empty',
      rules: [...struck.ask],
      message: struck.ask.length
        ? `The effective ask list is empty — every shipped ask rule is struck (${struck.ask.length}), so no run on any profile asks about anything; Guarded and Trusted are the same posture here.`
        : 'The effective ask list is empty, so no run on any profile asks about anything; Guarded and Trusted are the same posture here.',
    });
  }
  if (struck.deny.length) {
    out.push({
      kind: 'deny-struck',
      rules: [...struck.deny],
      message: `${struck.deny.length} shipped deny rule${struck.deny.length === 1 ? ' is' : 's are'} struck out of the wall that holds with the console dead: ${struck.deny.join(', ')}.`,
    });
  }
  return out;
}

/** The editor's refusal: rules that would parse and never match. */
export class PolicyRuleError extends Error {
  readonly rules: { raw: string; note: string }[];
  constructor(rules: { raw: string; note: string }[]) {
    super(`${rules.length === 1 ? 'A rule' : `${rules.length} rules`} would never match: ${rules.map((r) => `${r.raw} (${r.note})`).join('; ')}`);
    this.name = 'PolicyRuleError';
    this.rules = rules;
  }
}

/**
 * Every command a shell line would actually run.
 *
 * Prefix rules match the start of a command, so `git add x && git commit -m y`
 * begins with `git add` and slips past a `Bash(git commit:*)` rule entirely.
 * That is not a corner case — it is how anyone naturally writes it, and a real
 * run committed straight through the ask list this way. Worse, the same hole
 * applies to the deny rules: `cd /tmp && git push` begins with `cd`.
 *
 * The CLI's own matching is what it is and we cannot change it. What we can do
 * is look at each segment ourselves, so the hook is stricter than the rule list
 * it was given rather than exactly as leaky.
 */
export function commandSegments(command: string): string[] {
  const segments = command
    .split(/&&|\|\||[;\n|]/)
    .map((part) => unwrapSubshell(part.trim()))
    .filter(Boolean);
  // A wrapped command is still that command: `nohup git push` must hit the
  // same deny rule `git push` does.
  const out = new Set(segments);
  for (const segment of segments) {
    const inner = stripWrappers(segment);
    if (inner) out.add(inner);
  }
  return [...out];
}

/**
 * Strip the parentheses a subshell leaves on a segment.
 *
 * `(cd sub && npm publish)` splits into `(cd sub` and `npm publish)`, and the
 * trailing bracket is not cosmetic: a prefix rule matched at a word boundary
 * sees `npm publish)`, which is not `npm publish`, and the deny rule misses.
 * Only *unbalanced* brackets are dropped, so `echo $(date)` keeps its own.
 */
function unwrapSubshell(segment: string): string {
  let text = segment.replace(/^\(\s*/, '');
  while (text.endsWith(')')) {
    const opens = (text.match(/\(/g) ?? []).length;
    const closes = (text.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    text = text.slice(0, -1).trimEnd();
  }
  return text;
}

/**
 * Wrappers Claude Code looks through when it matches a rule.
 *
 * The list is exactly the one it documents, and its edges are the point:
 * `npx`, `docker exec` and `devbox run` are NOT on it, so `npx some-publisher`
 * is matched as `npx` and a rule about the thing it runs never fires. Nothing
 * here can fix that — but the console can at least be honest about it, which is
 * what `WRAPPERS_NOT_STRIPPED` is for.
 */
const WRAPPERS = ['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob', 'xargs'];
export const WRAPPERS_NOT_STRIPPED = ['npx', 'docker exec', 'devbox run'];

/**
 * Peel the wrappers off a command, or return null if there were none.
 *
 * `xargs` only when bare: `xargs rm` runs `rm`, but `xargs -I{} sh -c …` is a
 * different animal and pretending to see through it would be a guess.
 */
export function stripWrappers(command: string): string | null {
  let rest = command.trim();
  let peeled = false;
  for (;;) {
    const found = /^([A-Za-z_][\w-]*)\s+(.*)$/s.exec(rest);
    if (!found) break;
    const [, head, tail] = found;
    if (!WRAPPERS.includes(head)) break;
    // `timeout 30s cmd` / `nice -n 5 cmd`: drop the wrapper's own arguments.
    if (head === 'xargs' && /^-/.test(tail)) break;
    let next = tail;
    while (/^-\S*\s+/.test(next) || /^\d+[smhd]?\s+/.test(next)) next = next.replace(/^\S+\s+/, '');
    if (!next) break;
    rest = next;
    peeled = true;
  }
  return peeled ? rest : null;
}

/**
 * Shapes that must never resolve to a silent yes.
 *
 * Each one runs a command this console cannot see: `watch` re-runs it forever,
 * `setsid` detaches it from the session, `flock` hands it a lock and a shell,
 * and `find -exec` runs it once per matched file. Matching the outer command
 * tells you nothing about what actually executes, so they get a card rather
 * than the benefit of the doubt.
 */
const NEVER_AUTO = /^(watch|setsid|flock)\b|(^|\s)find\s+.*\s-exec\b/;

export function neverAutoApproves(command: string): boolean {
  return commandSegments(command).some((segment) => NEVER_AUTO.test(segment));
}

/** How many words deep to look inside a wrapper. Long enough for any real one. */
const WRAPPED_WORDS = 40;

/**
 * Candidate payloads hidden inside a wrapper `stripWrappers` refuses to peel.
 *
 * `watch`, `setsid`, `flock` and `find -exec` are deliberately not peelable:
 * their arguments vary enough that a formal strip would be a guess, and a guess
 * that answers "safe" is the worst possible answer. But refusing to guess left
 * the wall unable to see a denied command hidden one word in — `flock /tmp/l
 * git push` matched no deny rule, because rules match the START of a command.
 *
 * So this does the one thing that cannot make the wall weaker: it offers every
 * suffix of the line as a candidate. A rule matching any of them is a rule that
 * would have matched the payload had it been written on its own. It can only
 * ever turn an allow into a deny — never the reverse.
 */
export function wrappedPayloads(command: string): string[] {
  const words = command.trim().split(/\s+/).slice(0, WRAPPED_WORDS);
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) out.push(words.slice(i).join(' '));
  return out;
}

/**
 * The QUESTION CLASS (zero-touch-console phase 13, TRS-1): calls that are a
 * question for a person rather than a request for permission.
 *
 * The audit's first finding was that no profile could ask anything: `trusted`
 * and `bypass` empty the ask list by construction, so the classifier could
 * answer only allow or deny and "needs a decision" and "is denied" became one
 * event. A profile cuts the VOLUME of permission cards; it must never remove
 * the capability to ask, so this list is consulted right after the deny wall
 * from its own constant — never carried in `ask`, where a profile, a strike or
 * a written allow rule could empty it. What answers a `hold` is the relay
 * (`server/relay.ts`, phase 14) on a run whose relay is armed, and the policy
 * table everywhere else (the `ambiguity` row — `Service.holdQuestion`). Rules
 * in the ordinary grammar, so a later question-shaped tool is one entry.
 */
export const QUESTION_CLASS = ['AskUserQuestion'];

/**
 * What the classifier answers: the three words the hook has always used, and
 * `hold` for the question class. `hold` never reaches the wire — see
 * `Decision`.
 */
export type ToolVerdict = Decision | 'ask';

/** Everything a rule may match about one call: the input, and each command a shell line would run. */
function callSubjects(toolName: string, input: unknown): unknown[] {
  const subjects: unknown[] = [input];
  const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
  if (typeof command === 'string') {
    for (const segment of commandSegments(command)) subjects.push({ command: segment });
  }
  return subjects;
}

/** The first of `rules` that matches this call, or null. */
function firstMatch(rules: readonly string[], toolName: string, input: unknown): string | null {
  const subjects = callSubjects(toolName, input);
  return rules.find((rule) => subjects.some((subject) => ruleMatches(rule, toolName, subject))) ?? null;
}

/** The `QUESTION_CLASS` rule this call matches, or null. */
export function questionRule(toolName: string, input: unknown): string | null {
  return firstMatch(QUESTION_CLASS, toolName, input);
}

/** One question as the journal records it. */
export type QuestionRecord = { question: string; options: string[]; multiSelect: boolean };

/**
 * The questions an `AskUserQuestion` call carries, bounded for the journal —
 * the question text, its option labels, and whether several may be chosen.
 * A call carries one to four; anything that is not that shape reads as none.
 * The audit's one real question left no console record at all (TRS-6).
 */
export function questionsOf(input: unknown): QuestionRecord[] {
  const list = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return [];
  const out: QuestionRecord[] = [];
  for (const entry of list.slice(0, 4)) {
    const q = entry as { question?: unknown; options?: unknown; multiSelect?: unknown } | null;
    if (typeof q?.question !== 'string') continue;
    const options = Array.isArray(q.options)
      ? q.options
        .map((option) => (typeof option === 'string' ? option : (option as { label?: unknown } | null)?.label))
        .filter((label): label is string => typeof label === 'string')
        .slice(0, 8)
        .map((label) => label.slice(0, 80))
      : [];
    out.push({ question: q.question.slice(0, 300), options, multiSelect: q.multiSelect === true });
  }
  return out;
}

/**
 * What to do with one tool call, before any human is involved.
 *
 * The filter the first real run proved was missing. The PreToolUse hook fires
 * on every matching tool, so without it a phase parks on `find docs -type f`
 * and waits for someone to tap Allow on a read-only listing. A supervisor that
 * asks about everything is one nobody reads, and a queue nobody reads is worse
 * than no queue: it trains the answer "yes".
 */
export function classifyTool(
  toolName: string, input: unknown, policy: AutopilotPolicy,
  profile: PermissionProfile = 'guarded',
): ToolVerdict {
  const subjects = callSubjects(toolName, input);
  const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
  const hits = (rules: readonly string[]) =>
    rules.some((rule) => subjects.some((subject) => ruleMatches(rule, toolName, subject)));

  // The wall first, and nothing gets past it — not an operator's own rule, not
  // a profile, not a tap on a phone.
  if (hits(policy.deny)) return 'deny';
  // Then a question — on EVERY profile, before anything a profile or an
  // operator's own allow list can reach (TRS-1). A question is not a
  // permission, so no permission word answers it.
  if (hits(QUESTION_CLASS)) return 'hold';
  // Then what this operator deliberately allowed, which is the only thing that
  // can outrank the built-in ask list. See `AutopilotPolicy.always`.
  if (hits(policy.always ?? [])) return 'allow';
  if (hits(policy.ask)) return 'ask';
  // A command whose real payload is hidden inside a wrapper gets a person,
  // never a default yes — but only where a person is what this run asked for.
  //
  // `profilePolicy` empties the ask list for trusted and bypass, and this
  // fallback sat below it answering 'ask' regardless: on a bypass run, where
  // nobody is watching by definition, the card went up, waited out the hook's
  // full hour, and timed out into a deny. The CLI renders that deny with its
  // own canned wording — "The user doesn't want to proceed with this tool use"
  // — so a standing configuration read as a person refusing the work, and the
  // run parked. A profile that says "stop asking me" has to reach here too.
  if (typeof command === 'string' && neverAutoApproves(command)) {
    if (profile === 'guarded') return 'ask';
    // Letting the wrapper run is a decision about who is watching, never about
    // the wall — so before the benefit of the doubt is given, the deny list gets
    // a second look at what the wrapper is carrying. See `wrappedPayloads`.
    if (hitsHidden(command, toolName, policy.deny)) return 'deny';
  }
  return 'allow';
}

/** Whether any rule matches something a wrapper is carrying. See `wrappedPayloads`. */
export function hitsHidden(command: string, toolName: string, rules: string[]): boolean {
  const payloads = wrappedPayloads(command);
  return rules.some((rule) => payloads.some((c) => ruleMatches(rule, toolName, { command: c })));
}

/**
 * The deny rule that stopped a call, for saying so out loud.
 *
 * `classifyTool` answers what to do; this answers which line of policy decided
 * it, which is what turns "not approved" into something an operator can go and
 * edit. Returns null when nothing in the deny list matches.
 */
export function matchedDenyRule(
  toolName: string, input: unknown, policy: AutopilotPolicy,
): string | null {
  const subjects: unknown[] = [input];
  const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
  if (typeof command === 'string') {
    for (const segment of commandSegments(command)) subjects.push({ command: segment });
  }
  const direct = policy.deny.find(
    (rule) => subjects.some((subject) => ruleMatches(rule, toolName, subject)),
  );
  if (direct) return direct;
  // A deny reached by looking inside a wrapper still has to be able to name
  // itself, or the reply says "blocked by the deny list" and cannot say which
  // line — the one thing the operator will ask next.
  if (typeof command !== 'string') return null;
  const payloads = wrappedPayloads(command);
  return policy.deny.find(
    (rule) => payloads.some((c) => ruleMatches(rule, toolName, { command: c })),
  ) ?? null;
}

/* ------------------------------------------------------------------ *
 * Profiles: how much this run may do without being asked
 * ------------------------------------------------------------------ */

export { PERMISSION_PROFILES, PROFILE_LABELS, DEFAULT_PERMISSION_PROFILE };
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export function isPermissionProfile(value: unknown): value is PermissionProfile {
  return typeof value === 'string' && (PERMISSION_PROFILES as readonly string[]).includes(value);
}

// PROFILE_LABELS is re-exported above from `shared/run-settings.js`, which
// owns the wording — three tables held it and two of them disagreed.

/**
 * The policy one profile actually runs under.
 *
 * Only the ask list moves. `deny` is the wall and is identical in all three —
 * a profile that could widen it would make the wall a preference, and the whole
 * reason `deny` is trustworthy is that it is enforced by the CLI with this
 * console unreachable.
 *
 * `alwaysAsk` survives the emptying: the openPr carve-out (below) needs its
 * two rules to raise a card even under `trusted`, because a push and a PR are
 * the run's one world-visible act and the deal is one human tap.
 */
export function profilePolicy(
  policy: AutopilotPolicy, profile: PermissionProfile,
  opts?: { alwaysAsk?: readonly string[] },
): AutopilotPolicy {
  if (profile === 'guarded') return policy;
  // `ALWAYS_ASK` unconditionally, plus whatever this call pins on top (the
  // openPr carve-out's two). FILTERED from the policy rather than added to it:
  // a pin keeps a rule the policy holds, so an operator's named strike still
  // removes it and an upgrade's new rule still applies.
  const pinned = new Set([...ALWAYS_ASK, ...(opts?.alwaysAsk ?? [])]);
  return { ...policy, ask: policy.ask.filter((rule) => pinned.has(rule)) };
}

/* ------------------------------------------------------------------ *
 * The openPr carve-out: the one deliberate hole in the push wall
 * ------------------------------------------------------------------ */

/** The deny rule the carve-out moves to ask — and only this exact rule. */
export const PUSH_DENY = 'Bash(git push:*)';

/**
 * What replaces it. The destructive push shapes stay walled: the carve-out
 * exists so a finished plan can publish ONE new branch, not so anything can
 * rewrite or delete what a remote already has.
 */
export const PUSH_DENY_CARVED = [
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
  'Bash(git push --delete:*)',
  'Bash(git push origin --delete:*)',
];

/** The asks that survive every profile while the carve-out is on. */
export const OPEN_PR_ASK = ['Bash(git push:*)', 'Bash(gh pr create:*)'];

/**
 * The LANDING session's two acts (many-plans-one-repo phase 8): a plan whose
 * `Land:` word is `pr` or `trunk` boards a session after each phase to open
 * the pull request — and, under `trunk`, merge it. Pinned through every
 * profile for the reason `OPEN_PR_ASK` is: one human tap per world-visible
 * act, unless the plan's `permission.destructive` row excepts it by name.
 *
 * `git push` is deliberately NOT here. The push is the console's own act
 * (`pushRef`, the one argv in `runner/worktree.ts`), done before the session
 * is boarded; the session is told so and the wall keeps refusing it.
 */
export const PUBLISH_ASK = ['Bash(gh pr create:*)', 'Bash(gh pr merge:*)'];

/**
 * The publishing ask a call matches — one of the rules the two carve-outs pin
 * for a person — or null (zero-touch-console phase 13, TRS-4).
 *
 * The carve-out's whole deal is one human tap to publish, and auto-grant (ON
 * by default) answered it 189 times with nobody asked and nothing announced.
 * `Service.decideToolUse` asks this before auto-grant is allowed to answer:
 * a match raises a real card unless the plan's `permission.destructive` row
 * names the rule as an exception (`destructiveExceptions`), and a grant under
 * such an exception is announced. Beside `neverAutoApproves` rather than
 * inside it: that predicate is about what a wrapper HIDES, and the classifier
 * consults it for its wrapper fallback; a publishing verb hides nothing.
 */
export function publishingRule(toolName: string, input: unknown): string | null {
  return firstMatch([...new Set([...OPEN_PR_ASK, ...PUBLISH_ASK])], toolName, input);
}

/**
 * The effective policy for one run, carve-out and profile applied together.
 *
 * Scoped to a run, never to the console: only a run started with
 * `gitMode: 'new-branch'` and PR-on-completion gets it, which is the narrowest
 * shape that lets the final phase actually push its branch. The residual risk
 * is stated in the docs — with this console dead, that run's CLI-side deny no
 * longer contains bare `git push` — and force/delete pushes stay denied at
 * both layers regardless.
 */
export function carvedPolicy(
  policy: AutopilotPolicy, profile: PermissionProfile, openPrCarveOut: boolean,
  /**
   * The plan lands by pull request (`Land: pr`/`trunk` on any phase): the
   * landing session's `gh pr create` and `gh pr merge` are pinned asks under
   * every profile. Nothing comes off the wall for it — the push stays the
   * console's.
   */
  publishCarveOut = false,
): AutopilotPolicy {
  if (!openPrCarveOut && !publishCarveOut) return profilePolicy(policy, profile);
  const pinned = [
    ...(openPrCarveOut ? OPEN_PR_ASK : []),
    ...(publishCarveOut ? PUBLISH_ASK : []),
  ];
  const carved: AutopilotPolicy = {
    ...policy,
    // Conditional on the wall actually standing: a carve-out narrows a rule
    // the policy holds, it never resurrects one the operator struck. With the
    // push wall struck, swapping in the force-push denials would quietly
    // re-add per run what a named, journaled edit removed for good. Only the
    // openPr carve-out touches the wall at all.
    deny: openPrCarveOut && policy.deny.includes(PUSH_DENY)
      ? [...policy.deny.filter((rule) => rule !== PUSH_DENY), ...PUSH_DENY_CARVED]
      : policy.deny,
    // The "one human tap to publish" asks are about the RUN shape, not the
    // wall — pinned whether or not the wall stands.
    ask: [...new Set([...policy.ask, ...pinned])],
  };
  return profilePolicy(carved, profile, { alwaysAsk: pinned });
}

const POLICY_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'phase-console',
);
const POLICY_FILE = join(POLICY_DIR, 'autopilot.json');

/**
 * One plan's own rules, beside the global ones.
 *
 * "Always allow this" almost always means "in this plan" — a repository's
 * deploy verb is safe to commit through in the plan that owns it and is not
 * safe everywhere. A per-plan file makes that the cheap answer instead of
 * making the global list the only place to say anything.
 */
export function planPolicyPath(slug: string, dir = POLICY_DIR, instance = INSTANCE.id): string {
  return join(dir, 'plans', pathSafe(instance), `${pathSafe(slug)}.json`);
}

/**
 * Where a plan's rules lived before consoles had identities.
 *
 * Read as a fallback, never written. Two projects that both have a plan called
 * `migration` used to share one policy file — "always allow this deploy verb"
 * said in one repository silently applied in the other, which is precisely the
 * kind of quiet widening a policy file exists to prevent. Keying by instance
 * fixes it going forward; reading the old path keeps every rule an operator has
 * already written working until they next edit it, at which point it is
 * rewritten to the keyed location and belongs to one project.
 */
export function legacyPlanPolicyPath(slug: string, dir = POLICY_DIR): string {
  return join(dir, 'plans', `${pathSafe(slug)}.json`);
}

/**
 * A slug or an instance id as one path segment, and nothing else.
 *
 * Both reach this from a URL or a registry file, so each decides a filename and
 * nothing more. Separators are gone before any dot handling, so nothing can
 * climb out of the directory; the dots are then collapsed as well, because a
 * name containing `..` invites the next reader to wonder whether it can.
 */
function pathSafe(value: string): string {
  return value
    .replace(/[^\w.-]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .slice(0, 80) || 'unnamed';
}

export type PolicyScope = 'plan' | 'global';

/**
 * The operator's own rules, merged on top of the defaults. A repository with
 * its own dangerous verbs — a deploy task, a box-mutating Taskfile target —
 * adds them here; the public skill never needs to know about them.
 *
 * Merged, never replaced: a policy file that forgot `git push` must not
 * quietly become a policy that permits it.
 */
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

/**
 * Shipped defaults the operator has struck — recorded by name rather than by
 * replacing the default lists, so an upgrade that ships a NEW default rule
 * still applies it (a copied-then-edited list would freeze the defaults at
 * whatever version the first edit saw).
 *
 * `deny` is on this shape since 2026-08-06, a deliberate reversal: the shipped
 * deny list used to be unstrikeable from a browser ("the wall"), and what that
 * produced in practice was a parked plan behind a push the operator wanted
 * made, with no remedy on the screen that showed the problem. A deny strike is
 * still the widest edit this file can express, so it stays named, attributed,
 * scoped, journaled, and reversible — and the UI confirms it before writing.
 * What did NOT change: strikes are by name, so upgrades still land every
 * default they do not name, and profiles still never move deny.
 */
export type PolicyRemovals = { deny: string[]; ask: string[]; allow: string[] };

export type PolicyFileExtras = AutopilotPolicy & {
  removed: PolicyRemovals;
  /**
   * Whether this scope answers permission asks itself — the auto-grant scalar.
   *
   * Absent means "this scope says nothing" and the next scope speaks: the plan
   * file falls through to the global file, the global file to the shipped
   * default (ON). A scalar, not a list: there is nothing to merge or strike,
   * only a value one scope states. Lives beside the lists so the same file,
   * the same door and the same journal cover who may act unasked AND who
   * answers the asks. See `autoApproveFor`.
   */
  autoApprove?: boolean;
};

/** Just the operator's own edits, unmerged — what the file actually holds. */
export function policyExtras(file = POLICY_FILE): PolicyFileExtras {
  let extra: Partial<AutopilotPolicy & { removed?: Partial<PolicyRemovals>; autoApprove?: unknown }> = {};
  try { extra = JSON.parse(readFileSync(file, 'utf8')) as typeof extra; }
  catch { /* no policy file is the normal case */ }
  return {
    deny: strings(extra.deny),
    ask: strings(extra.ask),
    allow: strings(extra.allow),
    // Boolean or absent — anything else a hand-edit produced reads as silence.
    ...(typeof extra.autoApprove === 'boolean' ? { autoApprove: extra.autoApprove } : {}),
    removed: {
      deny: strings(extra.removed?.deny),
      ask: strings(extra.removed?.ask),
      allow: strings(extra.removed?.allow),
    },
  };
}

export function loadPolicy(file = POLICY_FILE): AutopilotPolicy {
  return mergePolicy([policyExtras(file)]);
}

/**
 * The rules one plan runs under: the defaults, the operator's global file, then
 * the plan's own — the later ones only ever adding.
 */
export function loadPolicyFor(
  slug: string | null, globalFile = POLICY_FILE, dir = POLICY_DIR,
): AutopilotPolicy {
  const extras = [policyExtras(globalFile)];
  if (slug) extras.push(policyExtras(effectivePlanPolicyPath(slug, dir)));
  return mergePolicy(extras);
}

/**
 * Which shipped defaults are STRUCK, across the same scopes `loadPolicyFor`
 * merges — the removals, as opposed to their effect.
 *
 * `mergePolicy` has computed these since strikes shipped and has only ever
 * subtracted them, so the only way to see one was to diff the effective list
 * against the shipped one and infer. That is a fine thing for a person to do
 * once and a bad thing for a UI to do on every render, and it is worse than
 * bad for the deny half: since 2026-08-06 a browser may strike a shipped DENY
 * rule, which widens what every future run may do, and a permissions page that
 * can only infer such a strike is a page that cannot state it plainly.
 */
export function struckFor(
  slug: string | null, globalFile = POLICY_FILE, dir = POLICY_DIR,
): { deny: string[]; ask: string[]; allow: string[] } {
  const extras = [policyExtras(globalFile)];
  if (slug) extras.push(policyExtras(effectivePlanPolicyPath(slug, dir)));
  const flat = (pick: (e: PolicyFileExtras) => string[]) => [...new Set(extras.flatMap(pick))];
  return {
    deny: flat((e) => e.removed.deny),
    ask: flat((e) => e.removed.ask),
    allow: flat((e) => e.removed.allow),
  };
}

/**
 * The plan-policy file actually in force: the keyed one if it exists, else the
 * legacy unkeyed one.
 *
 * Never both. Merging them would resurrect a rule the operator had already
 * edited away in the keyed copy, which is the one direction a policy file must
 * never move on its own.
 */
export function effectivePlanPolicyPath(slug: string, dir = POLICY_DIR): string {
  const keyed = planPolicyPath(slug, dir);
  return existsSync(keyed) ? keyed : legacyPlanPolicyPath(slug, dir);
}

/** Who answers a permission ask at each scope, and what that resolves to. */
export type AutoApproveResolution = {
  /** The answer in force once every silent scope has fallen through. */
  effective: boolean;
  /** What the global file itself says — null when it says nothing. */
  global: boolean | null;
  /** What the plan's file says — null when it says nothing, or no slug. */
  plan: boolean | null;
};

/**
 * Resolve the auto-grant scalar: plan file, then global file, then the shipped
 * default — ON. The phase level outranks all three and is resolved by the
 * caller (`Service.decideToolUse`), because it lives on the run record, not in
 * a policy file. Scope-aware where `loadPolicyFor` is deliberately not: the
 * merged policy flattens who said what, and the editor needs provenance — "off,
 * from this plan" and "off, everywhere" are different facts to show.
 */
export function autoApproveFor(
  slug: string | null, globalFile = POLICY_FILE, dir = POLICY_DIR,
): AutoApproveResolution {
  const global = policyExtras(globalFile).autoApprove ?? null;
  const plan = slug ? policyExtras(effectivePlanPolicyPath(slug, dir)).autoApprove ?? null : null;
  return { effective: plan ?? global ?? true, global, plan };
}

function mergePolicy(extras: PolicyFileExtras[]): AutopilotPolicy {
  const flat = (pick: (e: PolicyFileExtras) => string[]) => extras.flatMap(pick);
  const written = flat((e) => e.allow);
  // Struck shipped defaults, at any contributing scope: a global strike hides
  // the default everywhere, a plan strike only where that plan's file was
  // merged in. All three lists filter the same way — a struck deny is the
  // widest of them, and everything downstream (profiles, the carve-out, the
  // settings handed to children) consumes this merge, so the strike holds
  // everywhere at once or nowhere at all.
  const struckDeny = new Set(flat((e) => e.removed.deny));
  const struckAsk = new Set(flat((e) => e.removed.ask));
  const struckAllow = new Set(flat((e) => e.removed.allow));
  return {
    deny: [...new Set([...DEFAULT_DENY.filter((r) => !struckDeny.has(r)), ...flat((e) => e.deny)])],
    ask: [...new Set([...DEFAULT_ASK.filter((r) => !struckAsk.has(r)), ...flat((e) => e.ask)])],
    allow: [...new Set([...DEFAULT_ALLOW.filter((r) => !struckAllow.has(r)), ...written])],
    // Only what a person actually wrote outranks the ask list — never the
    // built-in allow list, which exists so a phase can look around and would
    // cancel half the ask rules if it were given that power.
    always: [...new Set(written)],
  };
}

export const POLICY_PATH = POLICY_FILE;
export const POLICY_DIRECTORY = POLICY_DIR;

/** A rule the syntax accepts. Anything else never reaches a file. */
const validRules = (list: string[]) => list
  .map((rule) => rule.trim())
  .filter((rule) => parseRule(rule) !== null);

/**
 * Edit one policy file: add rules, remove rules, at one scope.
 *
 * **This widens as well as tightens, which reverses an earlier choice.** The
 * old rule was that a browser could only ever make a run more careful, and the
 * reasoning was sound: the worst case of a stray click should be a run that
 * stops to ask about something it needn't have. What that produced in practice
 * was ten `git commit` cards in one run and a person tapping Allow without
 * reading — which is the failure the strict version was supposed to prevent,
 * arriving by a different road. A queue nobody reads trains the answer "yes".
 *
 * So widening is allowed, and every widening is: named (the exact rule string
 * is shown before it is written), attributed (`by`), scoped (this plan by
 * default, everywhere only if asked), journaled, and reversible from the same
 * screen. Since 2026-08-06 that includes the shipped deny list — see
 * `PolicyRemovals` for the reversal and its terms. A struck deny rule is the
 * widest edit expressible here, because it also leaves the CLI-side settings
 * every child runs under: the layer that holds with the console dead moves
 * with it. That is the point, and the risk, in one sentence — which is why the
 * browser confirms a shipped-deny strike before sending it.
 */
export function editPolicy(
  edit: {
    add?: { deny?: string[]; ask?: string[]; allow?: string[] };
    /** Tool names this console has seen sessions offer — a rule naming one is never inert. */
    known?: ReadonlySet<string>;
    remove?: { deny?: string[]; ask?: string[]; allow?: string[] };
    /**
     * Return these parts to stock: the operator's own rules come out AND their
     * strikes against shipped defaults are forgiven, in one named act — for
     * all three lists alike.
     */
    reset?: ('deny' | 'ask' | 'allow')[];
    /**
     * Forgive individual strikes: the named shipped defaults apply again,
     * WITHOUT becoming file rules — an add would render them as the
     * operator's own, and a restored default is nobody's edit.
     */
    restore?: { deny?: string[]; ask?: string[]; allow?: string[] };
    /**
     * Set (true/false) or clear (null → inherit) the auto-grant scalar this
     * file holds. Scalars ride `set` rather than the list machinery: there is
     * nothing to strike or restore, only a value this scope states or stays
     * silent on. Omitting `set` PRESERVES the stored value — see below.
     */
    set?: { autoApprove?: boolean | null };
    by?: string;
  },
  file = POLICY_FILE,
): AutopilotPolicy {
  const current = policyExtras(file);
  // Refused before anything is read or written (phase 12, TRS-12): a rule
  // the editor accepted and the hook never matched is a widening the
  // operator believes is in force. Junk the syntax rejects is still dropped
  // — it was never a rule — but a rule that PARSES and matches nothing is a
  // rule somebody meant, and the answer is a refusal naming why.
  const inert: { raw: string; note: string }[] = [];
  for (const list of ['deny', 'ask', 'allow'] as const) {
    for (const rule of strings(edit.add?.[list])) {
      const parsed = parseRule(rule, edit.known);
      if (parsed?.support === 'ignored') inert.push({ raw: parsed.raw, note: parsed.note ?? 'matches nothing' });
    }
  }
  if (inert.length) throw new PolicyRuleError(inert);
  const resets = new Set(strings(edit.reset));
  const drop = (list: string[], removals: string[]) => {
    const gone = new Set(removals.map((rule) => rule.trim()));
    return list.filter((rule) => !gone.has(rule.trim()));
  };

  /**
   * A removal means one of two things, decided here so the × on a chip is one
   * gesture: a rule the FILE holds is dropped from it; a rule that is a
   * SHIPPED default is struck by name instead — recorded in `removed`,
   * filtered out at merge time, resurrected by `restore` or `reset`. The same
   * two branches for all three lists; deny joined them in the 2026-08-06
   * reversal (see `PolicyRemovals`).
   */
  const removedDeny = strings(edit.remove?.deny).map((r) => r.trim());
  const removedAsk = strings(edit.remove?.ask).map((r) => r.trim());
  const removedAllow = strings(edit.remove?.allow).map((r) => r.trim());
  const strikes = {
    deny: removedDeny.filter((r) => DEFAULT_DENY.includes(r) && !current.deny.includes(r)),
    ask: removedAsk.filter((r) => DEFAULT_ASK.includes(r) && !current.ask.includes(r)),
    allow: removedAllow.filter((r) => DEFAULT_ALLOW.includes(r) && !current.allow.includes(r)),
  };
  // Two ways back from a strike, both forgiving it: `restore` names the
  // default and nothing else changes; an `add` of the same rule also
  // un-strikes, because a strike sitting beside an add would win silently.
  const unstruckDeny = new Set([
    ...validRules(strings(edit.add?.deny)),
    ...strings(edit.restore?.deny).map((r) => r.trim()),
  ]);
  const unstruckAsk = new Set([
    ...validRules(strings(edit.add?.ask)),
    ...strings(edit.restore?.ask).map((r) => r.trim()),
  ]);
  const unstruckAllow = new Set([
    ...validRules(strings(edit.add?.allow)),
    ...strings(edit.restore?.allow).map((r) => r.trim()),
  ]);

  const removed: PolicyRemovals = {
    deny: resets.has('deny')
      ? []
      : [...new Set([...current.removed.deny, ...strikes.deny])].filter((r) => !unstruckDeny.has(r)),
    ask: resets.has('ask')
      ? []
      : [...new Set([...current.removed.ask, ...strikes.ask])].filter((r) => !unstruckAsk.has(r)),
    allow: resets.has('allow')
      ? []
      : [...new Set([...current.removed.allow, ...strikes.allow])].filter((r) => !unstruckAllow.has(r)),
  };

  const part = (
    name: 'deny' | 'ask' | 'allow',
  ): string[] => {
    if (resets.has(name)) return validRules(strings(edit.add?.[name]));
    return [...new Set([
      ...drop(current[name], strings(edit.remove?.[name])),
      ...validRules(strings(edit.add?.[name])),
    ])];
  };

  // The scalar the lists never touch. An absent `set` PRESERVES what the file
  // holds — without this branch every rule edit would silently erase the
  // operator's auto-grant choice on its way through the rewrite below.
  const autoApprove = edit.set && 'autoApprove' in edit.set
    ? (edit.set.autoApprove === null ? undefined : edit.set.autoApprove)
    : current.autoApprove;

  const next: AutopilotPolicy & { removed?: PolicyRemovals; autoApprove?: boolean } = {
    deny: part('deny'),
    ask: part('ask'),
    allow: part('allow'),
    ...(autoApprove !== undefined ? { autoApprove } : {}),
    // Written only when it says something — most policy files never strike a
    // default, and an empty key would read as a feature they used.
    ...(removed.deny.length || removed.ask.length || removed.allow.length ? { removed } : {}),
  };

  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  log.info('policy.updated', {
    file,
    by: edit.by ?? 'unknown',
    added: {
      deny: strings(edit.add?.deny).length,
      ask: strings(edit.add?.ask).length,
      allow: strings(edit.add?.allow).length,
    },
    removed: {
      deny: strings(edit.remove?.deny).length,
      ask: strings(edit.remove?.ask).length,
      allow: strings(edit.remove?.allow).length,
    },
    struckDefaults: { deny: strikes.deny.length, ask: strikes.ask.length, allow: strikes.allow.length },
    ...(edit.set ? { set: edit.set } : {}),
    ...(resets.size ? { reset: [...resets] } : {}),
    now: { deny: next.deny.length, ask: next.ask.length, allow: next.allow.length },
  });
  return next;
}

/**
 * Add rules to the operator's policy file — the tightening-only path, kept
 * because it is what the existing `POST /api/policy` contract promises.
 */
export function addPolicyRules(
  rules: { deny?: string[]; ask?: string[] }, file = POLICY_FILE,
): AutopilotPolicy {
  return editPolicy({ add: { deny: strings(rules.deny), ask: strings(rules.ask) } }, file);
}

/**
 * The ask rule that actually matched a call, or null when none did — an ask
 * reached through a wrapper shape rather than a rule, or a rule edited out from
 * under a live card.
 *
 * What a card and a grant record as `matched` (zero-touch-console phase 13,
 * LFC-9): the audit's 189 auto-grants carried only the SUGGESTED rule, so "which
 * line of policy asked" was unanswerable afterwards for every one of them.
 */
export function matchedAskRule(toolName: string, input: unknown, policy: AutopilotPolicy): string | null {
  return firstMatch(policy.ask, toolName, input);
}

/**
 * The rule a card should offer to write.
 *
 * Derived from the ask rule that actually stopped the call, so accepting it
 * cancels exactly the thing that just interrupted — no more, and nothing that
 * merely resembles it. Only when nothing matched (a profile switch, a rule
 * edited underneath a live card) does it fall back to naming the tool and the
 * first two words of the command, which is the narrowest honest guess.
 */
export function suggestedRule(toolName: string, input: unknown, policy: AutopilotPolicy): string {
  const matched = matchedAskRule(toolName, input, policy);
  if (matched) return matched;
  const command = toolName === 'Bash' ? (input as { command?: unknown } | null)?.command : null;
  if (typeof command === 'string') {
    const head = commandSegments(command)[0] ?? command;
    const words = head.trim().split(/\s+/).slice(0, 2).join(' ');
    return words ? `Bash(${words}:*)` : 'Bash';
  }
  return toolName;
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

/**
 * What settles a CARD: only two, on purpose. A card is a permission question,
 * and these are the two words the PreToolUse hook honours. The docs also
 * describe `defer`, but this hook fails open, and an unrecognised decision is
 * indistinguishable from no answer at all — the difference between "wait for
 * me" and "go ahead unsupervised" would come down to a spelling. `deny` is the
 * behaviour actually measured against a live session, so a timeout denies and
 * says it timed out.
 */
export type CardDecision = 'allow' | 'deny';

/**
 * What the console decides about one tool call: a card's two words, `hold`
 * and `defer`.
 *
 * `hold` — the question class (`QUESTION_CLASS`, TRS-1), a call that is a
 * question for a person rather than a permission. A decision the CONSOLE makes
 * and never a word the CLI receives: on a run whose relay is armed the relay
 * answers it (`server/relay.ts`, zero-touch-console phase 14); otherwise the
 * policy table does, and the hook is told `deny` with that answer as its reason
 * (`Service.holdQuestion`).
 *
 * `defer` — phase 1's spike S3 measured it honoured on CLI 2.1.270: a
 * `PreToolUse` `defer` ends the session with `stop_reason: tool_deferred` and
 * the call kept as `deferred_tool_use`, and `claude -p --resume` fires the same
 * hook again for the same `tool_use_id`, where `allow` + `updatedInput` runs it.
 * The relay says it for exactly one thing — a question whose window is still
 * open when the console is going away (`Relay.deferOpen`) — so the question
 * outlives the process instead of dying with its socket. Never a card's word:
 * the card's own vocabulary stays `CardDecision`.
 */
export type Decision = CardDecision | 'hold' | 'defer';

/**
 * Why a card recovered after a restart cannot be answered (TRS-11) — the
 * machine-readable half of what used to be one word, `expired`, which said
 * nothing about whether anything was left to receive an answer.
 *
 *   session-gone — no session of the asking run survived the restart.
 *   token-lost   — one survived, but its hook token could not be read back
 *                  from the run's settings file, so its later calls arrive
 *                  unauthorised (and this hook fails open).
 *   asker-gone   — a verification or gate card: the runner that raised it
 *                  stopped with the console, and the phase raises it again
 *                  when the run resumes.
 *   reoffered    — a standing offer (the ladder's `widen-rule`): the healer
 *                  offers it again on its next pass.
 *   hook-closed  — a relayed QUESTION (phase 14) whose window was open when the
 *                  console died without deferring it: the hook call that asked
 *                  closed with the console. The console's answer is still
 *                  recorded at boot — the substitute — and it answers the
 *                  session if the session asks the same question again.
 */
export const UNANSWERABLE_REASONS = Object.freeze(
  ['session-gone', 'token-lost', 'asker-gone', 'reoffered', 'hook-closed'] as const,
);
export type UnanswerableReason = (typeof UNANSWERABLE_REASONS)[number];

/** What a recovered card says about each reason, in a person's words. */
const UNANSWERABLE_DETAIL: Readonly<Record<UnanswerableReason, string>> = Object.freeze({
  'session-gone': 'the console restarted before this was answered, and no session of that run survived it '
    + '— nothing is left to receive an answer',
  'token-lost': 'a session of that run survived the restart, but its hook token could not be read back '
    + 'from the run’s settings file — its later calls reach this console unauthorised, and the hook fails open',
  'asker-gone': 'the console restarted before this was answered; the runner that raised it stopped with '
    + 'the console, and the phase raises it again when the run resumes',
  reoffered: 'a standing offer the console restarted under; the healer offers it again on its next pass',
  'hook-closed': 'the console stopped while this question was open and could not defer it, so the hook call that '
    + 'asked closed with it — the console answered it at boot, and that answer is given if the session asks again',
});

export type Evidence = { label: string; body: string };

/** One question of a relayed call, as the relay reads it (`server/relay.ts`). */
export type QuestionItem = {
  /** `shared/relay-model.js` `questionKey` — what rules match and the repeated-key rule compares. */
  key: string;
  /** The question's text exactly as the CLI sent it: the `answers` map is keyed by it. */
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
};

/** One answer on a question card: the option label, who chose it and, for a rule, which one. */
export type QuestionAnswer = { label: string; by: QuestionAnsweredBy; at: string; ruleId?: string; who?: string };

/**
 * The relay's part of a `question` card (zero-touch-console phase 14): how the
 * question arrived, the questions it carries (a call carries 1 to 4), the
 * answers so far — a person may answer some inside the window and the console
 * the rest — and, when the console went away with the window open, the deferral
 * that keeps the call answerable across the restart.
 */
export type ApprovalQuestion = {
  mechanism: RelayMechanism;
  tool: string;
  /** Carried by a `PreToolUse` body only — and what a `defer` names. */
  toolUseId?: string;
  sessionId?: string;
  /** The run's profile when it asked — what a relay rule is matched against, at raise and at boot. */
  profile?: PermissionProfile;
  items: QuestionItem[];
  answers: Record<string, QuestionAnswer>;
  deferred?: { toolUseId: string; at: string; why: string };
};

export type Approval = {
  id: string;
  runId: string;
  slug: string;
  phase: number | null;
  /**
   * `verify` is not a permission question. It asks a person to confirm a check
   * the runner could not make itself — a browser step, a look at a dashboard —
   * so no hook is blocked on the far end and it can afford to wait far longer.
   */
  kind: 'gate' | 'tool' | 'verify' | 'question';
  /**
   * A card no session is holding a hook open for — the ladder's `widen-rule`
   * offer (phase 9, TRS-10): the phase is PARKED behind it, the run may be
   * stopped, and `disarm(runId)` — which answers a run's cards `deny` when its
   * loop ends — leaves it standing. Settled by the same `settle()` a click
   * reaches; the offering side holds the promise.
   */
  standing?: true;
  title: string;
  detail: string;
  evidence: Evidence[];
  tool?: { name: string; input: unknown; cwd?: string };
  /**
   * The rule the card offers to write, shown before anything is written.
   * "Always allow this" without saying what "this" turns into is how a policy
   * file grows rules nobody can account for.
   */
  suggestedRule?: string;
  /**
   * The ask rule that actually matched the call (`matchedAskRule`), or null when
   * none did — a wrapper shape. The audit's 189 grants carried only the
   * SUGGESTED rule, so which line of policy asked was unknowable (LFC-9).
   * Absent on a card from before 5.0.0.
   */
  matched?: string | null;
  createdAt: string;
  expiresAt: string;
  /**
   * `unanswerable` replaced `expired` in 5.0.0 (TRS-11): a card recovered after
   * a restart is either answerable again (`pending`, with `recovered`) or says
   * WHY it is not (`unanswerable`).
   */
  status: 'pending' | CardDecision | 'unanswerable';
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  /** Set on a card the console restarted under and kept answerable: when it was restored, and when it was first raised. */
  recovered?: { at: string; from: string };
  /** Set on a recovered card nothing can answer any more: the reason, and the words for it. */
  unanswerable?: { reason: UnanswerableReason; detail: string };
  /**
   * `kind: 'question'` only — a question a session raised on a run whose relay
   * is armed (phase 14): the questions, the answers, the deferral. The window is
   * the card's own `expiresAt`; the relay answers 5 s before it.
   */
  question?: ApprovalQuestion;
};

type Settled = { decision: CardDecision; by: string; reason?: string };

type Waiting = { approval: Approval; settle: (decision: CardDecision, by: string, reason?: string) => void; timer: NodeJS.Timeout };

/**
 * How long a standing `widen-rule` card waits for a person before it reads as
 * denied and the phase's errand stands instead (phase 9, TRS-10). Twelve
 * hours: the phase is parked either way, nothing spends, and an offer a person
 * finds the next morning is still an offer.
 */
export const WIDEN_ANSWER_BY_MS = 12 * 60 * 60 * 1000;

/**
 * The hook's own timeout governs how long the session waits. Answer a little
 * before it, so the decision is ours and reads as a decision — not as the
 * silence that fails open.
 *
 * **It is NOT a gate** (chapter 09 DOC-3, row 19; the belief deleted in phase
 * 14). A hook that times out, errors, answers non-2xx or closes with the
 * console does not block anything: the call continues through the CLI's normal
 * permission flow, and under `bypassPermissions` that means it runs. So an
 * answer that arrives late is advisory at best, and anything that must not run
 * is a DENY RULE, which the CLI enforces with this console unreachable — never
 * this number. The relay's question window (60 s, answered at 55 s) sits far
 * inside it for the same reason: the answer has to be a decision, early.
 *
 * **An hour, not ten minutes.** At ten, a real overnight run put up ten `git
 * commit` cards and one of them was refused because nobody was awake — and a
 * denied commit at minute ten is the worst outcome available: the work is done,
 * the tree is dirty, and the session is told "no" for a reason that is really
 * "you were asleep". The limit is checked, not guessed: the CLI validates a
 * hook's `timeout` as `number().positive().optional()` **seconds with no upper
 * bound** (read out of the 2.1.220 binary), so an hour is honoured rather than
 * silently clamped back to a value we would then answer after.
 *
 * The socket has to survive it too, which is why `server/index.ts` sets its own
 * `requestTimeout`: Node would otherwise destroy a request this old, and a
 * destroyed hook request is silence, and silence fails open.
 */
export const HOOK_TIMEOUT_SECONDS = 3600;
const ANSWER_BY_MS = (HOOK_TIMEOUT_SECONDS - 20) * 1000;

/**
 * Said to the session, and to the person, when a card ran out of time. It no
 * longer says "answer the card": a card that timed out is settled, and the
 * sentence promised a button that no longer existed.
 */
export const TIMEOUT_REASON = 'nobody answered in time — the phase is parked, not failed; '
  + 'retry the phase to be asked again';

/* ------------------------------------------------------------------ *
 * Telling someone, when nobody is looking at the tab
 * ------------------------------------------------------------------ */

/**
 * Run the operator's own notifier, if they set one.
 *
 * The console can raise a browser notification, and that covers the case where
 * a tab is open somewhere. It does not cover the case the whole design is for:
 * the run is unattended and so is the operator. `PHASE_CONSOLE_NOTIFY` is a
 * command — `terminal-notifier`, a curl to a webhook, an `ntfy` publish — given
 * the title as `$1` and the body as `$2`.
 *
 * Deliberately an environment variable and NOT a browser-settable preference:
 * it runs a command on this machine, and nothing reachable from a web page
 * should be able to choose which. Failures are logged and never propagated —
 * a broken notifier must not be able to stop a run.
 */
export function notifyOutOfBand(title: string, body: string, env = process.env): void {
  // The environment first, then the machine profile's `notifyCommand` (FLT-3):
  // a file only a shell writes, so the rule above still holds.
  const command = notifyCommand(env);
  if (!command) return;
  try {
    execFile(command, [title, body], { timeout: 10_000 }, (error) => {
      if (error) log.warn('notify.failed', { command, error: error.message });
    });
  } catch (error) {
    log.warn('notify.failed', { command, error });
  }
}

/* ------------------------------------------------------------------ *
 * Surviving a restart
 * ------------------------------------------------------------------ */

const PENDING_FILE = join(INSTANCE_STATE_DIR, 'approvals', 'pending.json');

/**
 * Pending approvals, on disk.
 *
 * A card lived only in memory, so restarting the console with a phase parked
 * on "these checks need a person" erased the question and the evidence
 * gathered for it — the phase came back as `interrupted` and what it had been
 * asking was simply gone.
 *
 * What is restored is answerable only where an answer can still land
 * (`Approvals.recover`, TRS-11): the promise a decision would have resolved
 * died with the process, and so did the hook socket on the far end — a card
 * offering Allow and Deny to something nobody is listening to would be the same
 * lie as a Pause button that changes nothing. So a recovered card comes back
 * either answerable, because a session of its run survived with its token
 * adopted and may ask the same thing again, or `unanswerable` with a reason
 * from `UNANSWERABLE_REASONS` — never the old `expired`, which said neither.
 */
function writePending(pending: Approval[], file: string): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
  } catch (error) {
    log.warn('approvals.persist', { error });
  }
}

export function readPending(file = PENDING_FILE): Approval[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Approval[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The two moments worth telling somebody about, and they are not the same one.
 *
 * `notify` fires when a card is **raised** — before any decision exists, which
 * is exactly what makes it useful and what `test/approvals.test.ts` pins.
 * `resolved` fires when the question is **answered**, by whatever answered it:
 * a click here, a tap on a phone, the timeout, or the run ending underneath it.
 *
 * Without the second one a decision was true only in the browser that made it.
 * Every other client kept showing a card that had already been settled, and
 * pressing it produced a 404 — a phantom that outlived the thing it referred
 * to. Broadcasting resolution is what makes one queue seen from three places
 * one queue.
 */
export type ApprovalHooks = {
  notify?: (approval: Approval) => void;
  resolved?: (approval: Approval) => void;
  /**
   * The run journal's half of the story (zero-touch-console phase 13, TRS-7):
   * a card RAISED, every ending — a person, `disarm()`, the timeout — and a
   * grant, each told once, so the service can write the `phase.approval-*`
   * twin onto the run that asked. The log carries `approval.*`; a raise used
   * to be on no run at all.
   */
  record?: (event: ApprovalEvent, approval: Approval) => void;
  /**
   * A `question` card the broker is about to end on its own — the run ending
   * under it (`disarm`) — handed to the relay instead (phase 14), which defers
   * the call when it can and answers it by rule when it cannot. Return true
   * when the relay took it; false (or no hook) settles it the old way.
   */
  questionEnding?: (approval: Approval, why: string) => boolean;
};

/** The three moments a card has on the run's journal. */
export type ApprovalEvent = 'raised' | 'decided' | 'auto-granted';

/**
 * How many cards this console has raised, and since when (TRS-5).
 *
 * The audit found the "Permission needed" channel had carried 0 of 602
 * notifications, and nothing could say whether that meant "nobody needed
 * asking" or "nothing could ask". A count with its start date turns "0 cards
 * in N days" into something visible. Per instance, beside `pending.json`.
 */
export type ApprovalCounts = {
  /** Cards put in front of a person — tool, gate and verification cards, standing offers included. */
  raised: number;
  /** Asks the console answered itself under a standing auto-grant setting. */
  autoGranted: number;
  /** When this console started counting. */
  since: string;
  /** The most recent raise, or null when there has never been one. */
  lastRaisedAt: string | null;
};

/**
 * What `recover` is told about one card: answerable, or the reason it is not.
 *
 * `settle` is the relay's (phase 14): a question card it answered AT BOOT —
 * deferred, so the answer still lands when the session resumes — is answerable
 * and already decided, so it is filed settled rather than put back in the queue
 * for a person who was never going to see a 60 s window that closed hours ago.
 */
export type RecoveryVerdict =
  | { answerable: true; settle?: { decision: CardDecision; by: string; reason?: string } }
  | { unanswerable: UnanswerableReason; detail?: string };

/**
 * Appended to a card kept answerable across a restart, because the truth about
 * the call that raised it is not what a person would assume: the hook request
 * closed with the console, and a closed hook connection is a non-blocking
 * error to the CLI — the call has already gone ahead or been refused.
 */
export const RECOVERED_NOTE = 'Recovered after the console restarted: the hook call that raised this card '
  + 'closed with the console, so that call has already gone ahead or been refused by the CLI. Your answer '
  + 'is recorded, and it answers the session if it asks the same thing again.';

/** The key a recovered answer is kept under — one run, one phase, one exact call. */
function answerKey(runId: string, phase: number | null, toolName: string, input: unknown): string {
  let body: string;
  try { body = JSON.stringify(input) ?? ''; } catch { body = String(input); }
  return JSON.stringify([runId, phase ?? null, toolName, body]);
}

/** A per-run token as `arm` mints it: 32 random bytes, base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class Approvals {
  private waiting = new Map<string, Waiting>();
  private history: Approval[] = [];
  /**
   * One token per live run, keyed by run id.
   *
   * A single token was correct while a single run could exist. With a pool it
   * is a fail-open hole and a quiet one: run A finishing called `disarm()`,
   * which cleared the only token there was, and run B's next hook call arrived
   * unauthorised — and an unauthorised hook call is a failed hook call, and
   * this hook fails open. Run B would have carried on with no supervisor at
   * all, showing nothing wrong anywhere.
   */
  private tokens = new Map<string, { bytes: Buffer; text: string }>();
  private counter = 0;
  private notify: (approval: Approval) => void;
  private resolved: (approval: Approval) => void;
  private recordHook: (event: ApprovalEvent, approval: Approval) => void;
  /** Late-bound: the relay is built after the broker. See `ApprovalHooks.questionEnding`. */
  questionEnding: ((approval: Approval, why: string) => boolean) | null;
  private file: string;
  private countsFile: string;
  private tally: ApprovalCounts;
  /** Cards an earlier console left outstanding, filed at construction and judged by `recover`. */
  private recoveredAtBoot: Approval[] = [];
  /** A person's answer on a recovered card, kept for the one call it was about. See `takeRecoveredAnswer`. */
  private recoveredAnswers = new Map<string, Settled & { at: string }>();

  /**
   * The bare-function form is the original contract and still means "notify on
   * creation", so every existing caller and test reads unchanged.
   */
  constructor(hooks: ((approval: Approval) => void) | ApprovalHooks = {}, file = PENDING_FILE) {
    const named = typeof hooks === 'function' ? {} : hooks;
    this.notify = (typeof hooks === 'function' ? hooks : hooks.notify) ?? (() => {});
    this.resolved = named.resolved ?? (() => {});
    this.recordHook = named.record ?? (() => {});
    this.questionEnding = named.questionEnding ?? null;
    this.file = file;
    this.countsFile = join(dirname(file), 'counter.json');
    this.tally = this.readCounts();
    // Anything an earlier console was still asking about, filed as record with
    // the reason that holds when nothing else is known: the session is gone.
    // `recover()` — which the service calls once it can read which sessions
    // survived — may put a card back in the queue or name a truer reason.
    for (const approval of readPending(file)) {
      const filed: Approval = {
        ...approval,
        status: 'unanswerable',
        unanswerable: { reason: 'session-gone', detail: UNANSWERABLE_DETAIL['session-gone'] },
        reason: approval.reason ?? UNANSWERABLE_DETAIL['session-gone'],
      };
      this.history.push(filed);
      this.recoveredAtBoot.push(filed);
    }
    if (this.recoveredAtBoot.length) writePending([], file);
  }

  /** Keep the on-disk copy in step with what is genuinely outstanding. */
  private flush(): void {
    writePending([...this.waiting.values()].map((w) => w.approval), this.file);
  }

  /** Tell the journal side, never at the cost of the decision. */
  private fire(event: ApprovalEvent, approval: Approval): void {
    try { this.recordHook(event, approval); } catch { /* a journal listener must never block a decision */ }
  }

  /* ---- the counter ---- */

  private readCounts(): ApprovalCounts {
    try {
      const parsed = JSON.parse(readFileSync(this.countsFile, 'utf8')) as Partial<ApprovalCounts>;
      if (typeof parsed.since === 'string' && Number.isFinite(Date.parse(parsed.since))) {
        const whole = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 ? value as number : 0);
        return {
          raised: whole(parsed.raised),
          autoGranted: whole(parsed.autoGranted),
          since: parsed.since,
          lastRaisedAt: typeof parsed.lastRaisedAt === 'string' ? parsed.lastRaisedAt : null,
        };
      }
    } catch { /* never counted yet, or unreadable: start now */ }
    const fresh: ApprovalCounts = { raised: 0, autoGranted: 0, since: new Date().toISOString(), lastRaisedAt: null };
    this.writeCounts(fresh);
    return fresh;
  }

  private writeCounts(counts: ApprovalCounts): void {
    try {
      mkdirSync(dirname(this.countsFile), { recursive: true });
      const tmp = `${this.countsFile}.tmp.${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(counts, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, this.countsFile);
    } catch (error) {
      log.warn('approvals.persist', { file: this.countsFile, error });
    }
  }

  private count(what: 'raised' | 'autoGranted', at: string): void {
    this.tally = {
      ...this.tally,
      [what]: this.tally[what] + 1,
      ...(what === 'raised' ? { lastRaisedAt: at } : {}),
    };
    this.writeCounts(this.tally);
  }

  /** How many cards this console has raised and auto-granted, and since when. */
  counts(): ApprovalCounts { return { ...this.tally }; }

  /* ---- the per-run token ---- */

  /**
   * Mint a token for one run. The hook endpoint is unauthenticated otherwise —
   * anything on this machine could POST to it — so the token is what ties a
   * request to the run we started, and it dies with the run.
   */
  arm(runId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.tokens.set(runId, { bytes: Buffer.from(token), text: token });
    return token;
  }

  /**
   * Re-arm a run's EXISTING token without minting one (TRS-11).
   *
   * A child that outlives its console loaded its `Authorization` header at
   * startup and cannot reload it; a console that comes back and mints afresh
   * leaves every later hook call from that child unauthorised — and an
   * unauthorised hook call is a failed hook call, and this hook fails open. So
   * a restart reads the token back out of the settings file the child is
   * holding (`tokenFromSettingsFile`) and adopts it. Refuses a malformed token,
   * and refuses to replace a DIFFERENT token already armed for the run.
   */
  adoptToken(runId: string, token: string): boolean {
    if (!TOKEN_RE.test(token)) return false;
    const armed = this.tokens.get(runId);
    if (armed) return armed.text === token;
    this.tokens.set(runId, { bytes: Buffer.from(token), text: token });
    return true;
  }

  /**
   * The token this run is already using.
   *
   * Rewriting the settings file mid-run — which is how a profile change reaches
   * the next phase — must NOT mint a new one. The running child loaded its
   * `Authorization` header at startup and cannot reload it; a fresh token would
   * make its next hook call unauthorised, and an unauthorised hook call is a
   * failed hook call, and this hook fails open. The profile switch would
   * silently turn the supervisor off.
   */
  liveToken(runId?: string | null): string | null {
    if (runId) return this.tokens.get(runId)?.text ?? null;
    // No id: the one armed run, if there is exactly one. Ambiguity answers
    // null rather than guessing — handing run B's token to run A's settings
    // file would authorise its hook calls under the wrong run.
    return this.tokens.size === 1 ? [...this.tokens.values()][0].text : null;
  }

  /**
   * Retire one run's token, and answer the cards it left up.
   *
   * Scoped to a run: disarming A must leave B verifying. Called with no id it
   * still means everything, which is what a console shutdown wants.
   */
  disarm(runId?: string | null): void {
    if (runId) this.tokens.delete(runId);
    else this.tokens.clear();
    // Anything still waiting is answered rather than left hanging: a session
    // blocked on a dead broker would sit there until the hook timed out. Only
    // this run's cards, though — another run's are still answerable, and
    // settling them would deny a live session's work on its neighbour's behalf.
    for (const [id, entry] of [...this.waiting]) {
      if (runId && entry.approval.runId !== runId) continue;
      // A standing offer is not a session's question: the phase is parked
      // behind it and the run may already be stopped, so a loop ending is not
      // "nobody will ever answer". It lives on its own clock (phase 9).
      if (entry.approval.standing) continue;
      // A relayed question is the relay's to end (phase 14): it defers the call
      // when the hook can carry that, and answers it by rule when it cannot — a
      // `deny` here would be the silence the relay exists to replace.
      if (entry.approval.kind === 'question') {
        let taken = false;
        try { taken = this.questionEnding?.(entry.approval, 'run ended') ?? false; } catch { taken = false; }
        if (taken) continue;
      }
      this.settle(id, 'deny', 'run ended', 'the run ended before this was decided');
    }
  }

  /** Constant-time, so a wrong token leaks nothing about the right one. */
  verify(header: string | undefined): boolean {
    return this.runIdFor(header) !== null;
  }

  /**
   * WHICH run a hook call belongs to, rather than merely whether it is genuine.
   *
   * The whole point under a pool: two live runs, one hook endpoint, and a call
   * classified under the wrong run's profile is a bug that appears only when
   * two things run at once and is close to unreadable when it does.
   *
   * Every token is compared even after a match, and each comparison is
   * constant-time. Returning early on the first hit would make the reply time
   * a measure of *which* run matched — a weaker leak than the token itself,
   * but a free one to avoid.
   */
  runIdFor(header: string | undefined): string | null {
    if (!header || !this.tokens.size) return null;
    const presented = Buffer.from(header.replace(/^Bearer\s+/i, ''));
    let found: string | null = null;
    for (const [runId, token] of this.tokens) {
      if (presented.length !== token.bytes.length) continue;
      if (timingSafeEqual(presented, token.bytes)) found ??= runId;
    }
    return found;
  }

  armed(): boolean { return this.tokens.size > 0; }

  /** Which runs currently have a token. Used by the restart/shutdown inventory. */
  armedRuns(): string[] { return [...this.tokens.keys()]; }

  /* ---- the queue ---- */

  /**
   * Put one card in the queue, with the ONE settle closure every ending passes
   * through — a click, a tap on another device, `disarm()` when a run ends with
   * cards still up, and the timeout.
   *
   * The decision record lives inside the closure for exactly that reason
   * (TRS-7): it used to hang off the public `settle()`, which the timeout never
   * called, so the six cards that expired unanswered were the six with no
   * decision record — the endings nobody was watching carried the least
   * evidence. Shared by `request`, `offer` and `recover`, so a restored card
   * ends the same way a fresh one does.
   */
  private enqueue(approval: Approval, after?: (settled: Settled) => void): void {
    const settle = (decision: CardDecision, by: string, reason?: string) => {
      const entry = this.waiting.get(approval.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.waiting.delete(approval.id);
      approval.status = decision;
      approval.decidedAt = new Date().toISOString();
      approval.decidedBy = by;
      approval.reason = reason;
      this.remember(approval);
      this.flush();
      log.info('approval.decided', {
        id: approval.id, decision, by, runId: approval.runId, phase: approval.phase, kind: approval.kind,
        waitedMs: Math.max(0, Date.parse(approval.decidedAt) - Date.parse(approval.createdAt)),
        ...(approval.recovered ? { recovered: true } : {}),
      });
      this.fire('decided', approval);
      try { this.resolved(approval); } catch { /* a listener must never block a decision */ }
      after?.({ decision, by, reason });
    };
    // Unreferenced: the listening socket is what keeps this process alive, and
    // a pending approval must never be the reason it cannot exit.
    //
    // It still answers `deny`, and it has to: the hook fails open, so saying
    // nothing is saying yes, unsupervised, to the one call nobody watched.
    // What changes is what happens next — `by: 'timeout'` parks the run
    // instead of letting the session treat a refusal as a verdict and work
    // around it. See `Service.decideToolUse`.
    const timer = setTimeout(
      () => settle('deny', 'timeout', TIMEOUT_REASON),
      Math.max(0, Date.parse(approval.expiresAt) - Date.now()),
    ).unref();
    this.waiting.set(approval.id, { approval, settle, timer });
    this.flush();
  }

  /**
   * Park until somebody decides, or until we are nearly out of the hook's
   * patience. Answering just before the hook's own timeout matters: our answer
   * is a decision, its timeout is silence, and silence lets the call through.
   */
  request(
    request: Omit<Approval, 'id' | 'createdAt' | 'expiresAt' | 'status'>,
    answerByMs = ANSWER_BY_MS,
  ): { approval: Approval; decided: Promise<Settled> } {
    const id = `${Date.now().toString(36)}-${++this.counter}`;
    const approval: Approval = {
      ...request,
      id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + answerByMs).toISOString(),
      status: 'pending',
    };
    const decided = new Promise<Settled>((resolve) => { this.enqueue(approval, resolve); });
    this.count('raised', approval.createdAt);
    log.info('approval.requested', { id, runId: approval.runId, phase: approval.phase, title: approval.title });
    this.fire('raised', approval);
    try { this.notify(approval); } catch { /* a notifier must never block a decision */ }
    return { approval, decided };
  }

  settle(id: string, decision: CardDecision, by: string, reason?: string): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    entry.settle(decision, by, reason);
    return true;
  }

  /**
   * Change a card that is still up and write the queue to disk — the relay's
   * partial answers and its deferral (phase 14), which have to survive a restart
   * exactly as the card itself does. False when the card is not pending.
   */
  update(id: string, mutate: (approval: Approval) => void): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    mutate(entry.approval);
    this.flush();
    return true;
  }

  /**
   * Offer a STANDING card — `request()` with `standing: true`, for an ask no
   * session is holding a hook open for (the ladder's `widen-rule` rung, phase
   * 9): the phase is parked behind it, the run may be stopped, and the loop
   * ending must not answer it `deny`. Settled by the same `settle()` a click
   * or a tap reaches; the offering side holds `decided` and acts on it.
   */
  offer(
    request: Omit<Approval, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'standing'>,
    answerByMs = WIDEN_ANSWER_BY_MS,
  ): { approval: Approval; decided: Promise<Settled> } {
    return this.request({ ...request, standing: true }, answerByMs);
  }

  /** Is this card still up? The settlement sweep asks before scoring a `widen-rule` rung. */
  isPending(id: string): boolean { return this.waiting.has(id); }

  /**
   * Mint an already-settled card: the audit trail without the pipe.
   *
   * Auto-grant's vehicle. The ask still HAPPENED — the classifier said ask and
   * the hook is holding — but the console's standing setting answers it, so
   * the card is born decided: no pending entry, no pending-file write, no
   * timer. `notify` fires only when the caller says so — a grant under a
   * plan's publishing exception is announced (TRS-4), every other grant is
   * not, because that hook is the "get a person" channel. `resolved` always
   * fires, which is what tells every open page a decision now exists. History
   * caps at 200 like any settled card; the durable audit is the run journal's
   * `phase.approval-auto-granted` entry.
   */
  grant(
    request: Omit<Approval, 'id' | 'createdAt' | 'expiresAt' | 'status'>,
    by: string,
    reason: string,
    opts: { notify?: boolean } = {},
  ): Approval {
    const id = `${Date.now().toString(36)}-${++this.counter}`;
    const now = new Date().toISOString();
    const approval: Approval = {
      ...request,
      id,
      createdAt: now,
      expiresAt: now,
      status: 'allow',
      decidedAt: now,
      decidedBy: by,
      reason,
    };
    this.remember(approval);
    this.count('autoGranted', now);
    log.info('approval.auto-granted', {
      id, runId: approval.runId, phase: approval.phase, title: approval.title, matched: approval.matched ?? null,
    });
    this.fire('auto-granted', approval);
    try { this.resolved(approval); } catch { /* a listener must never block a decision */ }
    if (opts.notify) {
      try { this.notify(approval); } catch { /* a notifier must never block a decision */ }
    }
    return approval;
  }

  /* ---- surviving a restart ---- */

  /**
   * Judge the cards an earlier console left outstanding (TRS-11).
   *
   * Called once the caller can tell which sessions survived — the service does
   * it on `open`, after adopting the surviving runs' tokens. An ANSWERABLE card
   * goes back into the queue with a fresh answer window and `recovered`
   * stamped, and its detail says plainly what became of the call that raised it
   * (`RECOVERED_NOTE`); a person's answer is recorded like any decision and kept
   * for the one call it was about (`takeRecoveredAnswer`). Every other card
   * stays on the record, `unanswerable` with the reason the verdict names —
   * never `expired`. Idempotent: a card is judged once.
   */
  recover(verdictOf: (card: Approval) => RecoveryVerdict): { answerable: number; unanswerable: Partial<Record<UnanswerableReason, number>> } {
    const cards = this.recoveredAtBoot.splice(0);
    const outcome: { answerable: number; unanswerable: Partial<Record<UnanswerableReason, number>> } = { answerable: 0, unanswerable: {} };
    for (const card of cards) {
      let verdict: RecoveryVerdict;
      try { verdict = verdictOf(card); } catch { verdict = { unanswerable: 'session-gone' }; }
      if ('answerable' in verdict && verdict.settle) {
        // Answered at boot and still deliverable (a deferred question, phase
        // 14): on the record as decided, never back in a queue whose window a
        // person could not have seen. `approval.decided` is written like any
        // ending, with `recovered`, so the journal twin names the boot answer.
        const now = new Date().toISOString();
        card.status = verdict.settle.decision;
        card.decidedAt = now;
        card.decidedBy = verdict.settle.by;
        card.reason = verdict.settle.reason;
        card.recovered = { at: now, from: card.createdAt };
        delete card.unanswerable;
        log.info('approval.decided', {
          id: card.id, decision: card.status, by: card.decidedBy, runId: card.runId, phase: card.phase, kind: card.kind,
          waitedMs: Math.max(0, Date.parse(now) - Date.parse(card.createdAt)), recovered: true,
        });
        this.fire('decided', card);
        outcome.answerable += 1;
        continue;
      }
      if ('answerable' in verdict) {
        const index = this.history.indexOf(card);
        if (index >= 0) this.history.splice(index, 1);
        const now = Date.now();
        const restored: Approval = {
          ...card,
          status: 'pending',
          expiresAt: new Date(Math.max(Date.parse(card.expiresAt) || 0, now + ANSWER_BY_MS)).toISOString(),
          recovered: { at: new Date(now).toISOString(), from: card.createdAt },
          detail: card.detail.includes(RECOVERED_NOTE) ? card.detail : `${card.detail} ${RECOVERED_NOTE}`.trim(),
        };
        delete restored.unanswerable;
        delete restored.reason;
        delete restored.decidedAt;
        delete restored.decidedBy;
        this.enqueue(restored, (settled) => {
          // A person's answer is kept for the call it was about; the window
          // running out again answers nothing a session could ask.
          if (settled.by === 'timeout' || restored.kind !== 'tool' || !restored.tool) return;
          this.recoveredAnswers.set(
            answerKey(restored.runId, restored.phase, restored.tool.name, restored.tool.input),
            { ...settled, at: new Date().toISOString() },
          );
        });
        outcome.answerable += 1;
        continue;
      }
      const reason = verdict.unanswerable;
      card.unanswerable = { reason, detail: verdict.detail ?? UNANSWERABLE_DETAIL[reason] };
      card.reason = card.unanswerable.detail;
      outcome.unanswerable[reason] = (outcome.unanswerable[reason] ?? 0) + 1;
    }
    if (cards.length) log.info('approvals.recovered', { count: cards.length, ...outcome });
    return outcome;
  }

  /**
   * A person's answer on a recovered card, for the exact call it was about —
   * one run, one phase, one tool, one input — or null. One-shot: taking it
   * spends it, so an answer cannot quietly become a standing rule.
   */
  takeRecoveredAnswer(runId: string, phase: number | null, toolName: string, input: unknown): (Settled & { at: string }) | null {
    const key = answerKey(runId, phase, toolName, input);
    const found = this.recoveredAnswers.get(key) ?? null;
    if (found) this.recoveredAnswers.delete(key);
    return found;
  }

  pending(): Approval[] { return [...this.waiting.values()].map((w) => w.approval); }
  recent(limit = 50): Approval[] { return this.history.slice(-limit); }
  all(): Approval[] { return [...this.pending(), ...this.recent()]; }

  private remember(approval: Approval): void {
    this.history.push(approval);
    if (this.history.length > 200) this.history.shift();
  }
}

/**
 * The run token a settings file carries — what its child loaded at startup —
 * or null when there is no file, or no hook in it that names one (TRS-11).
 * Reads the hooks `buildSettings` writes; PreToolUse and Stop carry the same
 * token.
 */
export function tokenFromSettingsFile(runId: string, dir = join(INSTANCE_STATE_DIR, 'settings')): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, `run-${runId}.json`), 'utf8')) as {
      hooks?: Record<string, { hooks?: { headers?: Record<string, unknown> }[] }[]>;
    };
    for (const event of ['PreToolUse', 'Stop', 'PermissionRequest']) {
      for (const group of parsed.hooks?.[event] ?? []) {
        for (const hook of group.hooks ?? []) {
          const header = hook.headers?.Authorization;
          if (typeof header !== 'string') continue;
          const token = header.replace(/^Bearer\s+/i, '').trim();
          if (TOKEN_RE.test(token)) return token;
        }
      }
    }
  } catch { /* no file, or not one this console wrote */ }
  return null;
}

/* ------------------------------------------------------------------ *
 * The settings handed to each child
 * ------------------------------------------------------------------ */

export type SettingsOptions = {
  runId: string;
  token: string;
  /** Where this console is listening — the child posts its hook calls here. */
  origin: string;
  policy?: AutopilotPolicy;
  /** How much this run may do unasked. Only `bypass` changes the child's argv. */
  profile?: PermissionProfile;
  /** New-branch runs that will open a PR: bare `git push` moves deny → ask. */
  openPrCarveOut?: boolean;
  /** Plans that land by pull request: the landing session's `gh pr create`/`gh pr merge` are pinned asks. */
  publishCarveOut?: boolean;
  /**
   * The relay is armed for this run (phase 14): a `PermissionRequest` `http`
   * hook rides beside `PreToolUse`. Only ever true on a `relay: last-resort`
   * run whose CLI read at or above `RELAY_CLI_FLOOR` from `system/init` — a
   * relay-off run registers none, because `--permission-prompts none` does NOT
   * switch the hook off (phase 1, spike S2).
   */
  relay?: boolean;
  /**
   * This plan's sessions may be sent messages (the plan's `**Messaging:**`
   * line, on unless it says otherwise).
   *
   * It writes `crossSessionInbound: "accept"`, and that is a decision phase 1
   * forced rather than a preference. Decision 14 assumed the console could post
   * into a session's inbox PAST a `hold`, because it holds that session's own
   * `CLAUDE_CODE_MESSAGING_TOKEN` and so counts as an "own child". Arm S-C
   * measured it: it cannot. The documented own-child exception is conditioned
   * on NO `crossSessionInbound` value applying, and a value from `--settings`
   * applies — so the token buys nothing, and there is no setting under which
   * the CLI both holds peers and lets the console through.
   *
   * So the console takes responsibility for what reaches the session instead —
   * the MARK RULE: every message it delivers is framed (`frameMessage`) as
   * information from a peer with no authority, tagged `[[msg:<id>]]`, and
   * budgeted. `accept` without that framing would be an open door; the framing
   * is what makes the door safe, and it is why the two shipped together.
   */
  messaging?: boolean;
};

/**
 * The tools the `PreToolUse` hook is asked about. `AskUserQuestion` since
 * phase 14: on a run with a permission host the tool is offered, and the hook
 * is where the relay answers it (`allow` + `updatedInput`, spike S1). A run
 * without a host is never offered the tool, so the entry costs it nothing.
 */
export const PRE_TOOL_USE_MATCHER = HOOK_TOOLS.join('|');

export function buildSettings(opts: SettingsOptions): Record<string, unknown> {
  const policy = carvedPolicy(
    opts.policy ?? loadPolicy(), opts.profile ?? 'guarded', opts.openPrCarveOut ?? false,
    opts.publishCarveOut ?? false,
  );
  return {
    // The one settings key that is not about permissions: whether a PEER may
    // put a message into this session's inbox. See `SettingsOptions.messaging`
    // for why `accept` is the only workable value and what pays for it.
    // Omitted entirely when messaging is off, so the CLI's own default stands
    // rather than this console asserting a value it has no opinion about.
    ...(opts.messaging ? { crossSessionInbound: 'accept' } : {}),
    permissions: {
      // `allow` rides along because permission rules merge across scopes: it
      // adds to what the repository already permits and cannot take anything
      // away. Only `deny` and `allow` go to the CLI.
      allow: policy.allow,
      // Only `deny` goes to the CLI. It is the layer that holds with the console
      // dead — verified, not assumed.
      //
      // `ask` deliberately does NOT: there is nobody at a terminal to prompt in
      // `-p` mode, so an ask rule resolves to a refusal the session cannot get
      // past. A real run stalled exactly there — `notes/one.md` written, commit
      // refused, the session politely waiting for a prompt that would never
      // appear. Asking a human is the hook's job, because the hook is the only
      // part of this that can actually reach one.
      deny: policy.deny,
    },
    hooks: {
      PreToolUse: [
        {
          // Only the tools that can reach outside this repo are worth a round
          // trip; matching everything would put a network hop in front of every
          // Read and turn a phase into a slideshow.
          matcher: PRE_TOOL_USE_MATCHER,
          hooks: [
            {
              type: 'http',
              url: `${opts.origin}/hooks/pre-tool-use`,
              headers: { Authorization: `Bearer ${opts.token}` },
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
      // The relay's transport (phase 14, spike S2): with a permission host
      // attached, every call that reaches the permission step is put to the
      // host AND to this hook at once, and the first decision wins. The host is
      // presence-only and never answers first, so this hook must answer every
      // call — hence every tool, not a list. Same token, same hour: the relay
      // answers a question at 55 s and anything else at once.
      ...(opts.relay ? {
        PermissionRequest: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'http',
                url: `${opts.origin}/hooks/permission-request`,
                headers: { Authorization: `Bearer ${opts.token}` },
                timeout: HOOK_TIMEOUT_SECONDS,
              },
            ],
          },
        ],
      } : {}),
      // The closeout contract, enforced at the one moment it can still be
      // acted on: a session about to end its turn with neither a handoff on
      // the board nor a declared outcome is told exactly what to do instead
      // of exiting into a halt. Same fail-open philosophy as the hook above —
      // the console being unreachable means the CLI proceeds, and the
      // runner's own exit-time check remains the load-bearing layer. Never a
      // safety mechanism: `deny` above is that, and profiles still never
      // move it.
      Stop: [
        {
          hooks: [
            {
              type: 'http',
              url: `${opts.origin}/hooks/stop`,
              headers: { Authorization: `Bearer ${opts.token}` },
              timeout: HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Write the settings where only this user can read them.
 *
 * `--settings` takes a file or a JSON string, and a string would put the run
 * token in argv, which `ps` shows to every account on the machine. A 0600 file
 * in the state directory does not.
 */
export function writeSettingsFile(runId: string, settings: Record<string, unknown>): string {
  const dir = join(INSTANCE_STATE_DIR, 'settings');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `run-${runId}.json`);
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // writeFileSync's mode is only applied on create; an existing file keeps its
  // own, so set it explicitly rather than trusting the happy path.
  chmodSync(path, 0o600);
  return path;
}

/**
 * Delete every per-run settings file that does not belong to a run in `keep`.
 *
 * The sibling of `pruneMcpConfigs`, swept by the same two callers, and here for
 * the same reason: the comment above says a settings STRING would put the run
 * token in argv where `ps` shows it to the machine, and the file is how that is
 * avoided — but nothing ever deleted the file, so the token it carries simply
 * moved from a process listing to a permanent one. Best effort, never throws.
 */
export function pruneSettingsFiles(keep: Iterable<string>): string[] {
  const live = new Set([...keep].map((runId) => `run-${runId}.json`));
  return sweepSettings((name) => !live.has(name));
}

/** One run's settings file. The runner's own sweep — see `dropMcpConfigsFor`. */
export function dropSettingsFileFor(runId: string): string[] {
  return sweepSettings((name) => name === `run-${runId}.json`);
}

function sweepSettings(shouldDelete: (name: string) => boolean): string[] {
  const dir = join(INSTANCE_STATE_DIR, 'settings');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];   // never created, or already gone
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.startsWith('run-') || !shouldDelete(name)) continue;
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch (error) {
      log.warn('run.settings.prune-failed', { file: name, error: (error as Error).message });
    }
  }
  return removed;
}

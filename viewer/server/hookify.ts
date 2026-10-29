/**
 * The hookify rule files the console writes per plan (measured-console phase
 * 28, D3).
 *
 * hookify (Anthropic's `hookify@claude-plugins-official`) reads
 * `.claude/hookify.<rule>.local.md` from a session's project directory: YAML
 * front matter — `name`, `enabled`, `event` (`bash` · `file` · `stop` ·
 * `prompt` · `all`), `action` (`warn` | `block`), a `pattern` (a Python regex)
 * or a `conditions` list (`field`, `operator`, `pattern`) — and a markdown
 * body, the words the session is shown. Format read from its README in the
 * `claude-plugins-official` marketplace checkout on 2026-10-28.
 *
 * So a rule a person can READ stands where hook code stood: the plan's
 * `permission.destructive` row and the never list (`RULE_FAMILIES`' four
 * never families — a forced or deleting push, the host commands, a protected
 * path and a secret's value) become one file each, named
 * `hookify.pe-<slug>-<rule>.local.md` so the console's files are recognisable
 * by name and a person's own rules are never touched. They are written when a
 * run of the plan starts, and drawn on Settings ▸ Hooks.
 *
 * They ADD a layer for a session that loads hookify — a person's own
 * `claude` in the repository, say. The run's own enforcement is unchanged:
 * its `PreToolUse` hook, its `deny` list and the guard hook stand exactly as
 * `runner/approvals.ts` writes them, whether or not hookify is installed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { destructiveExceptions } from '../shared/policy-model.js';
import { HOST_COMMANDS } from '../shared/turn-model.js';
import { parseFrontMatter, scalar } from './parse/frontmatter.ts';

/** hookify's events this console writes rules for. */
export const HOOKIFY_EVENTS = ['bash', 'file'] as const;
/** hookify's two actions. */
export const HOOKIFY_ACTIONS = ['warn', 'block'] as const;
export type HookifyAction = (typeof HOOKIFY_ACTIONS)[number];

/** Where the rule came from: the plan's own row, or the never list no plan widens. */
export type HookifySource = 'permission.destructive' | 'never';

export type HookifyCondition = { field: string; operator: 'regex_match'; pattern: string };

export type HookifyRule = {
  /** The rule's short id inside its plan — `publish`, `force-push`, `host`, `secret-files`. */
  rule: string;
  /** hookify's `name:` — `pe-<slug>-<rule>`. */
  name: string;
  /** `hookify.pe-<slug>-<rule>.local.md`. */
  file: string;
  event: (typeof HOOKIFY_EVENTS)[number];
  action: HookifyAction;
  pattern?: string;
  conditions?: HookifyCondition[];
  source: HookifySource;
  /** The body: what a session that trips it is told. */
  words: string;
};

/** The prefix every file the console writes carries — and the only files it ever rewrites or removes. */
export const HOOKIFY_PREFIX = 'hookify.pe-';

/** Publishing verbs — what `permission.destructive` denies unless it names an exception. */
const PUBLISH_PATTERN = String.raw`git\s+push\b|gh\s+pr\s+(create|merge)\b|gh\s+release\s+create\b|npm\s+publish\b`;
/** A forced or deleting push (`PUSH_DENY_CARVED`) — never granted through any door. */
const FORCE_PUSH_PATTERN = String.raw`git\s+push\b.*\s(--force(-with-lease)?|-f|--delete)\b`;
/** The host family (`HOST_COMMANDS`), as the first word of a command. */
const HOST_PATTERN = String.raw`(^|[;&|(]\s*)(${HOST_COMMANDS.join('|')})\b`;
/** A secret's file (`permissions/walls.ts` `SECRET_PATH_RE`, in Python's dialect). */
const SECRET_FILE_PATTERN = String.raw`(^|/)(\.env(\.[\w-]+)?|\.secrets/.*|id_(rsa|ed25519|ecdsa)|\.netrc|\.npmrc|[\w.-]+\.pem)$`;

/** A slug as a file name may carry it. */
function slugPart(slug: string): string {
  return slug.replace(/[^\w-]+/g, '-').slice(0, 60);
}

/** The rules one plan's row writes. `destructive` is the row's answered value, or null for the shipped deny. */
export function hookifyRules(slug: string, destructive: string | null): HookifyRule[] {
  const part = slugPart(slug);
  const make = (rule: string, rest: Omit<HookifyRule, 'rule' | 'name' | 'file'>): HookifyRule => ({
    rule,
    name: `pe-${part}-${rule}`,
    file: `${HOOKIFY_PREFIX}${part}-${rule}.local.md`,
    ...rest,
  });
  const excepted = destructive ? destructiveExceptions(destructive) : [];
  const publishing = excepted.filter((rule) => /git push|gh pr|gh release|npm publish/.test(rule));
  return [
    make('publish', {
      event: 'bash',
      action: publishing.length ? 'warn' : 'block',
      pattern: PUBLISH_PATTERN,
      source: 'permission.destructive',
      words: publishing.length
        ? `This plan (${slug}) publishes only where its permission.destructive row says: ${publishing.map((r) => `\`${r}\``).join(', ')}. Anything else that pushes, opens or merges a pull request, cuts a release or publishes a package is denied — check the phase allows this one before you go on.`
        : `This plan (${slug}) denies publishing: its permission.destructive row ${destructive ? 'names no exception' : 'is the shipped default'}. Pushing, opening or merging a pull request, cutting a release or publishing a package is the console's act, never a session's.`,
    }),
    make('force-push', {
      event: 'bash',
      action: 'block',
      pattern: FORCE_PUSH_PATTERN,
      source: 'never',
      words: 'A forced or deleting push rewrites what a remote already has. It is on the never list: no plan row and no grant opens it.',
    }),
    make('host', {
      event: 'bash',
      action: 'block',
      pattern: HOST_PATTERN,
      source: 'never',
      words: `${HOST_COMMANDS.join(', ')} act on the machine, not the repository. They are on the never list: no plan row and no grant opens them.`,
    }),
    make('secret-files', {
      event: 'file',
      action: 'block',
      conditions: [{ field: 'file_path', operator: 'regex_match', pattern: SECRET_FILE_PATTERN }],
      source: 'never',
      words: 'This file holds a secret (an .env, a key, a token store). Writing it is on the never list — say what you need and let a person put it there.',
    }),
  ];
}

/** One rule as hookify reads it. */
export function hookifyText(rule: HookifyRule): string {
  const head = [
    '---',
    `name: ${rule.name}`,
    'enabled: true',
    `event: ${rule.event}`,
    ...(rule.pattern ? [`pattern: ${rule.pattern}`] : []),
    `action: ${rule.action}`,
    ...(rule.conditions?.length
      ? ['conditions:', ...rule.conditions.flatMap((c) => [`  - field: ${c.field}`, `    operator: ${c.operator}`, `    pattern: ${c.pattern}`])]
      : []),
    '---',
  ];
  return `${head.join('\n')}\n\n${rule.words}\n\nWritten by Phase Console from the plan's ${rule.source === 'never' ? 'never list' : 'permission.destructive row'}; rewritten when a run of the plan starts.\n`;
}

/** The files one plan has in a root's `.claude/`, by name. */
function planFiles(dir: string, slug: string): string[] {
  const prefix = `${HOOKIFY_PREFIX}${slugPart(slug)}-`;
  try {
    return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.local.md'));
  } catch {
    return [];
  }
}

/** The ignore line, so a rule file never dirties the repository a run guards. */
export const HOOKIFY_IGNORE = `.claude/${HOOKIFY_PREFIX}*.local.md`;

/** Add the ignore line to the repository's own `info/exclude` (never a tracked `.gitignore`). */
function excludeFromGit(root: string): void {
  let common: string;
  try {
    common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
  } catch {
    return;
  }
  const file = join(common, 'info', 'exclude');
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* none yet */ }
  if (text.split('\n').includes(HOOKIFY_IGNORE)) return;
  try {
    mkdirSync(join(common, 'info'), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# Phase Console's hookify rules (written per plan)\n${HOOKIFY_IGNORE}\n`);
  } catch { /* an unwritable exclude only means git sees them */ }
}

export type HookifyWrite = { dir: string; written: string[]; unchanged: string[]; removed: string[] };

/**
 * Write one plan's rule files into `<root>/.claude/`: each file the rules name
 * (only when its bytes change), and any older file of the same plan the rules
 * no longer name is removed. Nothing without the `hookify.pe-<slug>-` prefix is
 * ever touched.
 */
export function writeHookify(root: string, slug: string, destructive: string | null): HookifyWrite {
  const dir = join(root, '.claude');
  const rules = hookifyRules(slug, destructive);
  const out: HookifyWrite = { dir, written: [], unchanged: [], removed: [] };
  mkdirSync(dir, { recursive: true });
  for (const rule of rules) {
    const file = join(dir, rule.file);
    const text = hookifyText(rule);
    let had: string | null = null;
    try { had = readFileSync(file, 'utf8'); } catch { had = null; }
    if (had === text) { out.unchanged.push(rule.file); continue; }
    writeFileSync(file, text);
    out.written.push(rule.file);
  }
  const named = new Set(rules.map((rule) => rule.file));
  for (const name of planFiles(dir, slug)) {
    if (named.has(name)) continue;
    try { unlinkSync(join(dir, name)); out.removed.push(name); } catch { /* gone already */ }
  }
  excludeFromGit(root);
  return out;
}

/** One rule file as it stands on disk, read back for the page. */
export type HookifyOnDisk = {
  file: string;
  name: string;
  event: string;
  action: string;
  enabled: boolean;
  pattern?: string;
  words: string;
  /** Its bytes are what the plan's rules would write now. */
  current: boolean;
};

/** One plan's rules: what its row asks for, and what is on disk. */
export type PlanHookify = { slug: string; rules: HookifyRule[]; onDisk: HookifyOnDisk[] };

/** The plan's files under `<root>/.claude/`, read back, each held against what its rules would write. */
export function readHookify(root: string, slug: string, destructive: string | null): PlanHookify {
  const dir = join(root, '.claude');
  const rules = hookifyRules(slug, destructive);
  const onDisk: HookifyOnDisk[] = [];
  for (const name of planFiles(dir, slug)) {
    let text: string;
    try { text = readFileSync(join(dir, name), 'utf8'); } catch { continue; }
    const { values, lines } = parseFrontMatter(text);
    const word = (key: string) => scalar(typeof values[key] === 'string' ? (values[key] as string) : '');
    const body = text.split('\n').slice(lines).join('\n').trim();
    const rule = rules.find((r) => r.file === name);
    onDisk.push({
      file: name,
      name: word('name'),
      event: word('event'),
      action: word('action') || 'warn',
      enabled: word('enabled') !== 'false',
      ...(word('pattern') ? { pattern: word('pattern') } : {}),
      words: body.split('\n')[0] ?? '',
      current: Boolean(rule && hookifyText(rule) === text),
    });
  }
  return { slug, rules, onDisk };
}

/** True when a root's `.claude/` holds any of this plan's files. */
export function hasHookify(root: string, slug: string): boolean {
  return existsSync(join(root, '.claude')) && planFiles(join(root, '.claude'), slug).length > 0;
}

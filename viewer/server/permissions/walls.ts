/**
 * Every wall the AI meets reaches a person (control-tower phase 135, #212,
 * §Architecture 19) — as ONE kind of item, whatever stopped it.
 *
 *   - RECORDED: a wall is evidence the console wrote down for ONE lane when it
 *     happened — the console's own hook (a deny rule, every guard), the CLI's
 *     own refusal (a tool outside the allow list, an MCP tool not granted, the
 *     CLI's copy of a deny rule), a refused landing push (a capability off).
 *     `PhaseRecord.walls` keeps the newest `WALLS_KEPT`, cleared at a boarding
 *     as `toolDenied` is.
 *   - CITED: a session's `blocked --needs permission` names the wall it met
 *     (`--rule`, `--command`); G5 (`turn/guard.ts`) holds it to a wall recorded
 *     for ITS lane, else "nothing refused this — run it".
 *   - RAISED: one `permission` ledger item through `raiseTurn` — "raised
 *     because the AI lacks permission X to do Y" — carrying the tool, the rule,
 *     the command, the phase, why it was needed, the wall and its risk tier
 *     (`GRANT_RISK`). A wall no grant reaches (`never`) says why and the manual
 *     path, and offers no scope. A missing credential, an App not installed, a
 *     sandbox or network wall and a protected path raise an item of their own
 *     kind; nothing here ever writes a person's own Claude Code settings.
 *
 * Since phase 149 an item's Grant is the scoped grant (`permissions/grants.ts`):
 * one press at the scope a person chooses — this call, this phase, this plan,
 * this repository or always — applied by the server with its row. The card an
 * item may still carry (the broker's held call, the widen rung's) is the
 * MECHANISM the grant answers, never a grant of its own.
 *
 * Pure: records in, records and declarations out; nothing here reads a file.
 */

import {
  HOST_COMMANDS, grantScopesOf, itemRiskOf, neverReason, riskOf,
  type GrantScope, type RiskTier, type RuleFamily, type Wall,
} from '../../shared/turn-model.js';
import { redactSecrets } from '../../shared/human-step-model.js';
import { protectedPathOf } from '../../shared/situation-model.js';
import { HOOK_TOOLS, PUSH_DENY_CARVED, ruleMatches } from '../runner/approvals.ts';
import { readShell, executedTexts } from '../runner/shell-reading.ts';
import type { DeclareInput, HumanStep } from '../human-steps.ts';
import { resolve } from 'node:path';

/** Where a recorded wall came from. */
export type WallSource = 'hook' | 'cli' | 'landing' | 'preflight' | 'broker';

/** One wall the console recorded for a lane — the evidence a permission item cites. */
export type RecordedWall = {
  wall: Wall;
  tool: string;
  /** The deny rule, the guard's name, `mcp__<server>`, the capability flag — whatever names the line that stopped it. */
  rule?: string;
  /** What was refused — a command, a path, a target — one line, bounded, redacted. */
  command?: string;
  at: string;
  source: WallSource;
  /** The CLI's own words for a refusal of its own, when it gave any. */
  reason?: string;
};

/** How many walls a lane keeps — the newest; enough for a session that met a few before it declared. */
export const WALLS_KEPT = 8;

/** A command as a wall keeps it: one line, 400 characters, never a secret. */
export function wallCommand(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const one = redactSecrets(command.replace(/\s+/g, ' ').trim());
  return one ? one.slice(0, 400) : undefined;
}

/**
 * A guard's name is a lowercase word (`in-turn-wait`, `sign-in`, `gate-forge`,
 * `console-forge`, `run-tree-clone`, `poll-loop`); a deny RULE names a tool
 * (`Bash(git push:*)`, `WebFetch`). A deny made by shape alone names neither.
 */
export function isGuardRule(rule: string | null | undefined): boolean {
  return typeof rule === 'string' && /^[a-z][a-z0-9-]*$/.test(rule);
}

/** The wall a refusal by THIS console's hook is — a guard, or the deny list. */
export function wallOfHookDenial(denial: { tool: string; rule?: string | null; command?: unknown }, at: string): RecordedWall {
  const command = wallCommand(denial.command);
  return {
    wall: isGuardRule(denial.rule) ? 'guard' : 'deny',
    tool: denial.tool,
    ...(denial.rule ? { rule: denial.rule } : {}),
    ...(command ? { command } : {}),
    at, source: 'hook',
  };
}

/** An MCP tool's server: `mcp__<server>__<tool>` → `<server>`. */
export function mcpServerOf(tool: string): string | null {
  const match = /^mcp__([^_](?:[^_]|_(?!_))*)__/.exec(tool);
  return match ? match[1]! : null;
}

/**
 * The wall a refusal by the CLI's OWN permission system is
 * (`system/permission_denied`, `result.permission_denials`): an MCP tool not
 * granted, the CLI's copy of a deny rule, its classifier, its sandbox — and
 * otherwise a tool outside the allow list, asked where nobody can answer
 * ("no approval surface in this session"). Null for the console's own hook,
 * which recorded the wall itself when it said no.
 */
export function wallOfCliDenial(
  event: { tool: string; target?: string; reason?: string; reasonType?: string }, at: string,
): RecordedWall | null {
  const type = String(event.reasonType ?? '').toLowerCase();
  if (type === 'hook') return null;
  const server = mcpServerOf(event.tool);
  const command = wallCommand(event.target);
  const reason = event.reason ? redactSecrets(event.reason.replace(/\s+/g, ' ').trim()).slice(0, 300) : undefined;
  const wall: Wall = server ? 'mcp'
    : type.includes('classifier') ? 'classifier'
      : type.includes('sandbox') ? 'sandbox'
        : type === 'rule' ? 'deny'
          : 'allow-list';
  return {
    wall, tool: event.tool,
    ...(server ? { rule: `mcp__${server}` } : {}),
    ...(command ? { command } : {}),
    at, source: 'cli',
    ...(reason ? { reason } : {}),
  };
}

/**
 * Keep one more wall on a lane's list: the newest last, a repeat of the same
 * wall moved to the end with its new clock, never more than `WALLS_KEPT`.
 */
export function withWall(walls: readonly RecordedWall[] | undefined, wall: RecordedWall): RecordedWall[] {
  const key = wallKey(wall);
  const rest = (walls ?? []).filter((kept) => wallKey(kept) !== key);
  return [...rest, wall].slice(-WALLS_KEPT);
}

/** One wall's identity: the same wall, rule and command are the same wall met again. */
export function wallKey(wall: Pick<RecordedWall, 'wall' | 'tool' | 'rule' | 'command'>): string {
  return [wall.wall, wall.tool, wall.rule ?? '', wall.command ?? ''].join('\u0000');
}

/* ------------------------------------------------------------------ *
 * The rule family — what the risk table tells apart
 * ------------------------------------------------------------------ */

/** The host family's deny rules, `Bash(<word>:*)` — `DEFAULT_DENY` carries each. */
export const HOST_RULES: readonly string[] = Object.freeze(HOST_COMMANDS.map((word) => `Bash(${word}:*)`));

/** A secret's value: a file whose bytes ARE a credential. */
const SECRET_PATH_RE = /(?:^|\/)(?:\.env(?:\.[\w-]+)?|\.secrets\/\S*|id_(?:rsa|ed25519|ecdsa)|\.netrc|\.npmrc|[\w.-]+\.pem)$/;

/** Do any of these rules stop this command, read as a shell reads it (phase 107's words)? */
function commandHits(rules: readonly string[], command: string): boolean {
  const texts = (() => {
    try { return executedTexts(readShell(command)); } catch { return [command]; }
  })();
  return rules.some((rule) => texts.some((text) => ruleMatches(rule, 'Bash', { command: text })));
}

/**
 * The family of a wall's rule (`RULE_FAMILIES`): a forced or deleting push
 * (`PUSH_DENY_CARVED`), the host family, a protected path, a secret's value —
 * the never list — else `any`. Read off the rule when it names one of them,
 * else off the command, as the shell would run it.
 */
export function ruleFamilyOf(wall: Pick<RecordedWall, 'tool' | 'rule' | 'command'>): RuleFamily {
  const rule = wall.rule ?? '';
  if (PUSH_DENY_CARVED.includes(rule)) return 'force-push';
  if (HOST_RULES.includes(rule)) return 'host';
  if (protectedPathOf(rule, wall.command ?? '')) return 'protected-path';
  if (wall.tool !== 'Bash' && wall.command && SECRET_PATH_RE.test(wall.command.trim())) return 'secret-value';
  if (wall.tool === 'Bash' && wall.command) {
    if (commandHits(PUSH_DENY_CARVED, wall.command)) return 'force-push';
    if (commandHits(HOST_RULES, wall.command)) return 'host';
  }
  return 'any';
}

/* ------------------------------------------------------------------ *
 * G5's evidence — which recorded wall a declaration cites
 * ------------------------------------------------------------------ */

/** A command compared as a person would: whitespace folded, quotes and backticks dropped. */
function folded(command: string | undefined): string {
  return (command ?? '').replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The wall a `blocked --needs permission` declaration cites, among the walls
 * recorded for ITS lane — newest first: the rule it names, else the command it
 * names (one containing the other: a session quotes what it ran, the record
 * keeps 400 characters), else, when it names neither, the newest wall. A
 * guard is never cited by a bare declaration: it is policy, not a permission.
 */
export function citedWall(
  walls: readonly RecordedWall[] | undefined, declared: { rule?: string | null; command?: string | null },
): RecordedWall | null {
  const newestFirst = [...(walls ?? [])].reverse();
  const rule = declared.rule?.trim();
  const command = folded(declared.command ?? undefined);
  if (rule) {
    const hit = newestFirst.find((wall) => wall.rule === rule);
    if (hit) return hit;
  }
  if (command) {
    const hit = newestFirst.find((wall) => {
      const kept = folded(wall.command);
      return Boolean(kept) && (kept === command || kept.includes(command) || command.includes(kept));
    });
    if (hit) return hit;
  }
  if (!rule && !command) return newestFirst.find((wall) => wall.wall !== 'guard') ?? newestFirst[0] ?? null;
  return null;
}

/* ------------------------------------------------------------------ *
 * The item
 * ------------------------------------------------------------------ */

/** What each wall is, in the words an item says. */
export const WALL_WORDS: Readonly<Record<Wall, string>> = Object.freeze({
  deny: "a deny rule in this run's permission policy",
  ask: 'an ask — the call waits for a person to answer',
  'allow-list': "a tool outside the run's allow list, asked where nobody could answer",
  mcp: 'an MCP tool this run was not granted',
  capability: "a capability this console was started without",
  credential: 'a credential no session holds',
  guard: "the console's own guard",
  sandbox: 'a sandbox or network wall on this machine',
  classifier: "Claude Code's own classifier",
});

/**
 * The card behind an item's Grant, when one holds the call (control-tower
 * phases 135 and 149): the grant engine answers it allow at the scope chosen —
 * a held hook call at no cost, the widen rung superseded — or a capability's
 * switch at the machine. The label says what the Grant does.
 */
export type TodayGrant =
  /** The approval broker's Allow: this call, or a rule remembered for the plan or everywhere. */
  | { effect: 'broker'; approvalId: string; label: string }
  /** The widen rung's Allow: the rule struck from this plan's deny list — permanently. */
  | { effect: 'strike'; approvalId: string; label: string }
  /** A capability: the console's unit verb at the machine, and a restart when idle — never from a device. */
  | { effect: 'capability'; label: string };

/**
 * The widen rung's Grant (phase 149): the deny rule lifted at the scope a
 * person chooses — for this plan it is struck from the plan's list until the
 * grant is revoked (Settings ▸ Permissions lists it and takes it back).
 */
export function strikeLabel(rule: string): string {
  return `lift \`${rule}\` for this call, this phase, this plan, this repository or always — each a grant `
    + 'with its row, revocable from Settings ▸ Permissions';
}

/**
 * What a card behind a permission item is answered when the ITEM was settled
 * another way (control-tower phase 135) — the words a live session's hook
 * reads, and the marker the widen rung reads to leave the resume to the item's
 * road back instead of parking the phase on an errand.
 */
export const ITEM_DENIED_REASON = 'Denied — do not retry; find another way inside the plan or say what remains.';
export const ITEM_CONVERTED_REASON =
  'The operator will run this themself — do not retry it; carry on with what does not need it, or say what remains.';

/**
 * A card answered allow because its permission item was GRANTED (control-tower
 * phase 149): the engine applied the grant at the scope a person chose, so the
 * card's own act — the widen rung's plan strike — is not made, and the item's
 * road back resumes the session with the grant's sentence.
 */
export const ITEM_GRANTED_REASON =
  'Granted on its permission item — the console applied the grant at the scope chosen; run the call again.';

/** Was a card answered by its permission item rather than on the card itself? */
export function answeredByItem(reason: string | null | undefined): boolean {
  return reason === ITEM_DENIED_REASON || reason === ITEM_CONVERTED_REASON || reason === ITEM_GRANTED_REASON;
}

/** Was a card answered allow by its item's grant — the card's own act not to be made? */
export function grantedByItem(reason: string | null | undefined): boolean {
  return reason === ITEM_GRANTED_REASON;
}

/** A capability's Grant (phase 149): at the machine only — the unit verb, then a restart when idle. */
export const CAPABILITY_GRANT_LABEL =
  'at the machine only — the console puts the switch into its launch unit (`phase-console capability <instance> add '
  + "--allow-publish`) and restarts when idle; or name `git push` in the plan's permission.destructive row. Never from a paired device";

/** The approval broker's Grant (phase 149): this one call answers the held call at no cost; a wider scope is a rule, with its row. */
export const BROKER_GRANT_LABEL =
  'Grant — this one call answers the held call at no cost; this phase, this plan or for every plan of this console '
  + 'is a grant with its row, revocable from Settings ▸ Permissions';

/** A permission item's own record — what the page shows and phase 149 grants from. */
export type PermissionDetail = {
  wall: Wall;
  tool?: string;
  rule?: string;
  command?: string;
  /** Why the phase needed it — the session's own words, when it gave any. */
  need?: string;
  family?: RuleFamily;
  /** The tier the item shows: its narrowest offer's, or `never`. */
  risk?: RiskTier;
  /** The scopes a grant may be offered at, narrowest first — none for `never`. */
  scopes?: GrantScope[];
  /** Why no grant is offered, and what a person does instead — `never` only. */
  never?: { why: string; manual: string };
  /** What Grant does today. */
  grant?: TodayGrant;
  /** The exact rule a person could add to their OWN settings — shown, never written. */
  ownRule?: string;
  /** Where the wall was recorded, and when. */
  source?: WallSource;
  at?: string;
};

/** The act a wall stopped, in words: `run \`git push …\``, `use mcp__github`, `use WebFetch`. */
function actOf(wall: Pick<RecordedWall, 'tool' | 'rule' | 'command'>): string {
  if (wall.tool === 'Bash' && wall.command) return `run \`${wall.command.slice(0, 160)}\``;
  if (wall.command) return `use ${wall.tool} on \`${wall.command.slice(0, 160)}\``;
  return `use ${wall.tool}`;
}

/** The permission a wall names: its rule, else the tool. */
function permissionWord(wall: Pick<RecordedWall, 'tool' | 'rule'>): string {
  return `\`${wall.rule ?? wall.tool}\``;
}

/**
 * The sentence every permission item leads with (§Architecture 19): "raised
 * because the AI lacks permission X to do Y".
 */
export function lacksSentence(wall: Pick<RecordedWall, 'tool' | 'rule' | 'command'>): string {
  return `Raised because the AI lacks permission ${permissionWord(wall)} to ${actOf(wall)}.`;
}

/**
 * The rule a person could add to their OWN Claude Code settings — for the
 * classifier's denial in an interactive session, which the console explains
 * and never applies.
 */
export function ownSettingsRule(wall: Pick<RecordedWall, 'tool' | 'rule' | 'command'>): string {
  if (wall.rule && !isGuardRule(wall.rule)) return wall.rule;
  if (wall.tool === 'Bash' && wall.command) {
    const words = wall.command.trim().split(/\s+/).slice(0, 2).join(' ');
    return `Bash(${words}:*)`;
  }
  return wall.tool;
}

/** Build the permission record of one wall — its family, risk, offers or never reason, and today's Grant. */
export function permissionDetail(
  wall: RecordedWall, opts: { need?: string | null; family?: RuleFamily; grant?: TodayGrant | null } = {},
): PermissionDetail {
  const family = opts.family ?? ruleFamilyOf(wall);
  const cell = { wall: wall.wall, family };
  // A capability is granted at the machine only — its one scope is `always` (phase 149).
  // A grant for this call or this phase is held to its lane by the console's
  // hook, so it is offered only for a tool the hook sees (phase 149).
  const lane = (scope: GrantScope) => (scope !== 'call' && scope !== 'phase') || HOOK_TOOLS.includes(wall.tool);
  const scopes = wall.wall === 'capability'
    ? grantScopesOf(cell).filter((scope) => scope === 'always')
    : grantScopesOf(cell).filter(lane);
  const never = neverReason(cell);
  const need = opts.need ? redactSecrets(opts.need.replace(/\s+/g, ' ').trim()).slice(0, 300) : '';
  return {
    wall: wall.wall, tool: wall.tool,
    ...(wall.rule ? { rule: wall.rule } : {}),
    ...(wall.command ? { command: wall.command } : {}),
    ...(need ? { need } : {}),
    family, risk: itemRiskOf(cell),
    scopes,
    ...(never ? { never: { why: never.why, manual: never.manual } } : {}),
    // A never cell offers nothing — not even today's grant.
    ...(!never && opts.grant ? { grant: opts.grant } : {}),
    ...(wall.wall === 'classifier' ? { ownRule: ownSettingsRule(wall) } : {}),
    source: wall.source, at: wall.at,
  };
}

/**
 * The approval broker's ask as a permission item's record (control-tower phase
 * 135): a PROJECTED item — the card keeps its held hook call, its clock and its
 * closure — read as the wall it is: an ask with nobody else to answer it, or,
 * for the widen rung's standing card, the deny rule it would strike.
 */
export function brokerPermission(approval: {
  id: string; tool?: { name?: string; input?: unknown } | null; suggestedRule?: string | null;
  detail?: string | null; standing?: true; createdAt?: string | null;
}): PermissionDetail | null {
  const tool = approval.tool?.name;
  if (!tool) return null;
  const input = (approval.tool?.input ?? {}) as Record<string, unknown>;
  const target = tool === 'Bash' ? input.command : (input.file_path ?? input.path ?? input.url ?? input.pattern);
  const command = wallCommand(target);
  const wall: RecordedWall = {
    wall: approval.standing ? 'deny' : 'ask', tool,
    ...(approval.suggestedRule ? { rule: approval.suggestedRule } : {}),
    ...(command ? { command } : {}),
    at: approval.createdAt ?? new Date(0).toISOString(), source: 'broker',
  };
  return permissionDetail(wall, {
    need: approval.detail ?? null,
    grant: approval.standing
      ? { effect: 'strike', approvalId: approval.id, label: strikeLabel(approval.suggestedRule ?? tool) }
      : { effect: 'broker', approvalId: approval.id, label: BROKER_GRANT_LABEL },
  });
}

/** Where a raise is: the lane that met the wall. */
export type WallAt = { slug: string; phase: number; runId: string; sessionId?: string };

/** The item's lines: the sentence, the need, the wall, the risk, and what Grant does — or why nothing does. */
function permissionLines(at: WallAt, detail: PermissionDetail, lacks: string, keyless = false): string[] {
  const lines = [
    lacks,
    `Phase ${at.phase} of ${at.slug} needs it${detail.need ? `: ${detail.need}` : ' — the session declared itself blocked on it'}.`,
    `The wall: ${WALL_WORDS[detail.wall]}${detail.rule ? ` (\`${detail.rule}\`)` : ''}.`,
  ];
  if (detail.never) {
    lines.push(`Risk: never — ${detail.never.why}. No grant is offered through any door.`);
    lines.push(`What to do instead: ${detail.never.manual}`);
  } else {
    lines.push(`Risk: ${detail.risk}${detail.risk === 'high' ? ' — the rule is typed and its reach shown before it applies' : ' — one press'}.`);
    lines.push(`Grant: one press for ${(detail.scopes ?? []).join(', ')} — the console applies it, the session resumes by itself, and Settings ▸ Permissions lists it and takes it back.`);
    if (detail.grant) lines.push(`Behind it: ${detail.grant.label}.`);
    // A console with no owner key says so on the item (phase 149): a high
    // grant there is the typed rule alone.
    if (keyless && (detail.scopes ?? []).some((scope) => riskOf({ wall: detail.wall, family: detail.family ?? 'any', scope }) === 'high')) {
      lines.push('This console has no owner key: a high-risk grant here is the rule typed back alone — enrol one with `phase-console owner enroll`.');
    }
  }
  if (detail.ownRule) {
    lines.push(`To allow it yourself, add "${detail.ownRule}" to permissions.allow in your own Claude Code settings — the console never writes them.`);
  }
  return lines;
}

/**
 * A recorded wall as a `permission` ledger item, ready for `raiseTurn`: the
 * console's raise (`birth: 'console'`), sourced by the wall so the same wall
 * raised again is the same item, its command the item's own *I'll do it
 * myself*.
 */
export function permissionTurnInput(
  at: WallAt, wall: RecordedWall,
  opts: { need?: string | null; family?: RuleFamily; grant?: TodayGrant | null; source?: { kind: string; ref: string }; keyless?: boolean } = {},
): DeclareInput {
  const detail = permissionDetail(wall, opts);
  const lacks = lacksSentence(wall);
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId, ...(at.sessionId ? { sessionId: at.sessionId } : {}),
    step: {
      kind: 'permission', why: 'permission', proof_type: 'grant',
      title: lacks.replace(/^Raised because /, '').replace(/\.$/, '').replace(/^the AI/, 'The AI'),
      lines: permissionLines(at, detail, lacks, opts.keyless === true),
      ...(wall.tool === 'Bash' && wall.command ? { open_command: wall.command } : {}),
      permission: detail,
      source: opts.source ?? { kind: 'wall', ref: `${wall.wall}:${wall.rule ?? wall.command ?? wall.tool}`.slice(0, 300) },
    },
  };
}

/** An App that is not installed — a third party's approval, with its install link. */
export function appTurnInput(at: WallAt, app: { name: string; installUrl: string; repo?: string; need?: string }): DeclareInput {
  return {
    slug: at.slug, phase: at.phase, birth: 'console', runId: at.runId, ...(at.sessionId ? { sessionId: at.sessionId } : {}),
    step: {
      kind: 'third-party-approval', why: 'third-party',
      title: `Install the ${app.name} app${app.repo ? ` on ${app.repo}` : ''}`,
      open_url: app.installUrl,
      lines: [
        `The AI cannot go on until the ${app.name} app is installed${app.repo ? ` on ${app.repo}` : ''}: an install is the account owner's act, and no grant here reaches it.`,
        ...(app.need ? [`Phase ${at.phase} of ${at.slug} needs it: ${app.need}`] : []),
        'Install it from the link, then press I\'ve done this.',
      ],
      source: { kind: 'wall', ref: `app:${app.name}` },
    },
  };
}

/**
 * A wall no grant reaches and no permission item fits: a sandbox or network
 * wall (an act the person does where it can reach), or a protected path (its
 * own kind, the edit made by hand). Never a grant; nothing written anywhere.
 */
export function manualTurnInput(at: WallAt, wall: RecordedWall, opts: { need?: string | null; path?: string | null } = {}): DeclareInput {
  const family = ruleFamilyOf(wall);
  const protectedPath = family === 'protected-path' ? (opts.path ?? protectedPathOf(wall.rule ?? '', wall.command ?? '')) : null;
  const never = neverReason({ wall: wall.wall, family }) ?? neverReason({ wall: 'sandbox' })!;
  const base = { slug: at.slug, phase: at.phase, birth: 'console' as const, runId: at.runId, ...(at.sessionId ? { sessionId: at.sessionId } : {}) };
  const need = opts.need ? [`Phase ${at.phase} of ${at.slug} needs it: ${redactSecrets(opts.need).slice(0, 300)}`] : [];
  if (protectedPath) {
    return {
      ...base,
      step: {
        kind: 'protected-path', why: 'reserved',
        title: `Make the edit to ${protectedPath} by hand`,
        lines: [lacksSentence(wall), ...need, `Why no grant: ${never.why}.`, never.manual],
        source: { kind: 'wall', ref: `protected-path:${protectedPath}` },
      },
    };
  }
  return {
    ...base,
    step: {
      kind: 'operator-act', why: 'reach',
      title: `Run it where it can reach: ${actOf(wall).replace(/^run /, '')}`,
      lines: [lacksSentence(wall), ...need, `Why no grant: ${never.why}.`, never.manual],
      ...(wall.tool === 'Bash' && wall.command ? { open_command: wall.command } : {}),
      source: { kind: 'wall', ref: `${wall.wall}:${wall.rule ?? wall.command ?? wall.tool}`.slice(0, 300) },
    },
  };
}

/**
 * The item a wall raises, by what it is: a sandbox or network wall and a
 * protected path → their manual item; anything else → a `permission` item
 * (a never one says why and the manual path, and offers nothing).
 */
export function wallTurnInput(
  at: WallAt, wall: RecordedWall,
  opts: { need?: string | null; grant?: TodayGrant | null; source?: { kind: string; ref: string }; path?: string | null; keyless?: boolean } = {},
): DeclareInput {
  const family = ruleFamilyOf(wall);
  if (wall.wall === 'sandbox' || family === 'protected-path') return manualTurnInput(at, wall, opts);
  return permissionTurnInput(at, wall, { ...opts, family });
}

/**
 * *I'll do it myself* (control-tower phase 135): the operator runs the command
 * the AI was refused, and the item that was a permission becomes an
 * `operator-act` — its guide is the command in both copy forms (as it is, and
 * from the asking lane's tree), its proof the person's word, its pass the
 * waiting session's resume.
 */
export function convertedTurnInput(
  step: Pick<HumanStep, 'slug' | 'phase' | 'title' | 'id'> & Partial<Pick<HumanStep, 'runId' | 'sessionId' | 'permission' | 'openCommand'>>,
  opts: { tree?: string | null } = {},
): DeclareInput | null {
  const command = step.permission?.command ?? step.openCommand;
  if (!command) return null;
  const tree = opts.tree?.trim();
  const inTree = tree ? `cd '${tree.replace(/'/g, `'\\''`)}' && ${command}` : null;
  const fence = (line: string) => ['   ```sh', `   ${line}`, '   ```'];
  const text = [
    `The AI was refused ${step.permission?.rule ? `\`${step.permission.rule}\`` : 'a permission'} and you said you would run this yourself.`,
    '',
    '## Steps',
    '1. Run the command the AI could not, in the lane\'s checkout.',
    ...fence(command),
    ...(inTree ? ['2. Or paste this from any terminal — it changes into that checkout first.', ...fence(inTree)] : []),
    `${inTree ? 3 : 2}. Check it did what the phase needed, then press I've done this — the session resumes and is told you ran it.`,
  ].join('\n');
  return {
    slug: step.slug, phase: step.phase, birth: 'console',
    ...(step.runId ? { runId: step.runId } : {}), ...(step.sessionId ? { sessionId: step.sessionId } : {}),
    step: {
      kind: 'operator-act', why: 'permission', proof_type: 'attest',
      title: `Run it yourself: ${command.replace(/\s+/g, ' ').slice(0, 200)}`,
      open_command: command,
      guide: text,
      source: { kind: 'convert', ref: step.id },
    },
  };
}

/* ------------------------------------------------------------------ *
 * The asking lane — where an item's evidence is read
 * ------------------------------------------------------------------ */

/**
 * The tree an approval's evidence is read from (OD-17): one of the run's OWN
 * trees — the deepest that holds the asking call's working directory, else the
 * run's checkout, else its root — never the console's root, which is another
 * lane's tree, and never the directory the call names: a session chooses that,
 * and git run where a session chose reads a config and attributes the session
 * wrote (a `core.fsmonitor`, a diff driver) — a command outside every wall. The
 * directory is resolved first, so `<tree>/../elsewhere` is elsewhere.
 */
export function evidenceTreeOf(at: {
  cwd?: string | null; workRoot?: string | null; root?: string | null; trees?: readonly string[];
}): string | null {
  const inside = (dir: string, tree: string) => dir === tree || dir.startsWith(tree.endsWith('/') ? tree : `${tree}/`);
  const cwd = at.cwd?.trim() ? resolve(at.cwd.trim()) : null;
  const trees = [...(at.trees ?? []), ...(at.workRoot ? [at.workRoot] : []), ...(at.root ? [at.root] : [])].map((tree) => resolve(tree));
  const holding = cwd ? trees.filter((tree) => inside(cwd, tree)).sort((a, b) => b.length - a.length)[0] : undefined;
  return holding ?? (at.workRoot ? resolve(at.workRoot) : at.root ? resolve(at.root) : null);
}

/**
 * The read-only git an item's evidence runs — with every hook a repository's
 * own config or attributes could hang a command on switched off.
 */
export const EVIDENCE_GIT = Object.freeze({
  status: Object.freeze(['-c', 'core.fsmonitor=false', 'status', '--short']),
  diff: Object.freeze(['-c', 'core.fsmonitor=false', 'diff', '--stat', '--no-ext-diff', '--no-textconv']),
});

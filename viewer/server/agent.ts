/**
 * Agent sessions: an interactive `claude` in the browser terminal.
 *
 * This module is the only place claude argv for a terminal session is
 * composed, and everything in it is built from allowlisted fields — the
 * client can never pass argv, a command, an env var or a flag. The terminal
 * registry (`terminal.ts`) spawns exactly the `LaunchSpec` resolved here.
 *
 * ## Where the rules come from
 *
 * The vocabularies are the runner's, imported rather than re-declared, so a
 * model or mode that becomes acceptable for the autopilot is acceptable here
 * in the same commit: `MODEL_FALLBACK` (aliases the CLI takes), `EFFORTS`
 * (the CLI only *warns* on an unknown effort, so it is enforced here), and
 * `PERMISSION_MODES` — which deliberately does not contain
 * `bypassPermissions`, so refusing it needs no special case. The composed
 * argv still passes through `sanitize()`, the runner's single audit point
 * for forbidden flags, before the positional prompt is appended.
 *
 * ## Why the prompt is appended AFTER sanitize
 *
 * `sanitize()` inspects every argv slot; a prompt whose exact text is
 * `--bare` would be deleted as a forbidden flag. The prompt is user prose,
 * not a flag, so it is appended last — and the complementary guard is
 * validation: a prompt that *begins* with `-` is refused outright, so the
 * CLI can never parse it as an option either.
 *
 * ## Why the child env is the shell's, not the runner's
 *
 * `childEnv()` (runner/errors.ts) sets `CLAUDE_CODE_RETRY_WATCHDOG=1`, which
 * is documented for CI/unattended sessions: it retries rate limits
 * indefinitely and stretches transient failures to hours. On an *interactive*
 * TUI that looks like a hang to the person watching, who could simply retry.
 * So agent sessions inherit the same env a shell does (terminal.ts adds TERM
 * and COLORTERM — and `CLAUDE_CONFIG_DIR` rides along in process.env, which
 * is also the home `/api/skills` enumerates).
 */

import { randomUUID } from 'node:crypto';

import { EFFORTS, isEffort, PERMISSION_MODES, sanitize } from './runner/spawn.ts';
import { MODEL_FALLBACK as MODELS } from './runner/errors.ts';
import { isKnownModel } from './runner/models.ts';
import { recoveryLabel, recoveryPrompt, type RecoveryFacts } from './recovery.ts';
import { qaLabel, qaPrompt, type QaFacts } from './qa-session.ts';
import { skillDirective, ultracodeDirective, type SkillInfo } from './skills.ts';
import { ISSUE_REF_RE, TICKET_ISSUES_MAX, type ResolvedIssues } from './issues/index.ts';
import {
  ISSUES_FIXED_BYTES, ISSUES_MARGIN_BYTES, ISSUES_MIN_BYTES, issuesSection,
} from './issues/prompt.ts';
import type { LaunchSpec, SessionMeta } from './terminal.ts';
import { inboxTasksFile } from './runner/tasks.ts';
import { MANIFEST_ORDER, MANIFEST_QUESTIONS, PLAN_FIELDS, manifestDefault } from './plan-fields.ts';

/**
 * A prompt bigger than this is a file, not a message. 32 KB since phase 12:
 * the plan wizard's prompt carries the manifest and the plan's fields as
 * numbered questions plus a digest of the repository's ledgers, and 16 KB was
 * jointly unsatisfiable with an 8 KB brief and twenty issues. The prompt is
 * one argv slot — macOS allows a megabyte, Linux 128 KB per argument.
 */
export const MAX_AGENT_PROMPT_BYTES = 32 * 1024;

/** The plan wizard's brief — roomy, but the composed prompt must still fit. */
export const MAX_BRIEF_BYTES = 8 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same shape the run endpoints accept: `name` or `plugin:name`. */
const SKILL_ID = /^[\w.-]+(?::[\w.-]+)?$/;

/**
 * The permission profiles a QA session may be started under.
 *
 * Deliberately two rather than the runner's three. `trusted` is an *autopilot*
 * idea — it means "no approval card is raised", and there is no card here: a QA
 * session runs in a terminal a person is looking at, so the only real question
 * is whether the CLI asks that person before acting. Guarded is that CLI, and
 * bypass is the CLI told to stop asking, which is the one choice worth naming
 * because it is the one that can change a repository unattended.
 */
const QA_PROFILES = ['guarded', 'bypass'] as const;
type QaProfile = (typeof QA_PROFILES)[number];

export type AgentRefusal = { ok: false; status: number; error: string };

/**
 * What the registry knows about the conversation a resume names — the subset
 * of a `SessionView` this module reads, spelled structurally so `agent.ts`
 * stays free of the registry's types and a test can hand over a literal.
 */
export type ResumeTarget = {
  /** Where the conversation lives. The whole reason this context field exists. */
  cwd?: string;
  /** The plan and phase the registry correlated the session to, when it did. */
  plan?: { slug: string; phase: number };
  /** `PE_OWNER` — `autopilot/<runId>` for a lane. */
  owner?: string;
  kind?: string;
};

/**
 * What to call a session resumed from the registry.
 *
 * The same three facts the Sessions row labels a foreign session with, in the
 * same order (plan, else owner, else what it is), so the tab you open reads
 * like the row you opened it from. `undefined` when the registry knew nothing:
 * the terminal registry then names it `Claude N`, exactly as a bare resume has
 * always been named.
 */
export function resumedLabel(target: ResumeTarget | undefined): string | undefined {
  if (!target) return undefined;
  const what = target.plan
    ? `${target.plan.slug} · P${target.plan.phase}`
    : (target.owner ?? (target.kind === 'autopilot' ? 'autopilot session' : undefined));
  if (!what) return undefined;
  const short = what.length > 48 ? `${what.slice(0, 47).trimEnd()}…` : what;
  return `Resumed: ${short}`;
}

export type AgentContext = {
  /** Every skill the child could invoke, from the home it will inherit. */
  skills: () => SkillInfo[];
  /** The phased-execution scripts directory this console runs with. */
  scriptsDir: string;
  /** Whether a source root is open — the plan wizard needs one to write into. */
  rootOpen: boolean;
  /**
   * The open root's path, for the one thing the launch derives from it: the
   * task inbox a QA session publishes its list to (`inboxTasksFile`), so the
   * Sessions page can fold it. Absent leaves the session with no channel —
   * the pre-2026-09-07 shape — never a guess.
   */
  root?: string;
  /**
   * The resolved recovery briefing, for `intent: 'recovery'`.
   *
   * Composed by the service (which can read the board, the run, the lock and
   * the health issues) and passed in here rather than parsed from the body —
   * the browser names *what* to recover, never *what the prompt says*. Absent
   * for every other intent.
   */
  recovery?: RecoveryFacts;
  /**
   * The resolved QA briefing, for `intent: 'qa'`.
   *
   * Composed by the service (which reads the plan, the handoff, the commits and
   * the board) for the same two reasons the recovery briefing is: a page cannot
   * dictate what a review session is told, and a brief cannot claim an exit
   * criterion exists unless the plan holds one. Absent for every other intent.
   */
  qa?: QaFacts;
  /**
   * The issues a plan ticket names, RESOLVED against the console's own estate.
   *
   * The fourth thing on this context composed by the service rather than parsed
   * from the body, and for the strongest version of the same reason: the
   * browser sends `owner/repo#12` REFS, and the inventory is the allowlist that
   * turns them into text. A ticket therefore cannot make this console fetch —
   * or quote — an arbitrary repository, and `unknown` carries the refs that did
   * not resolve so the refusal can name them.
   */
  issues?: ResolvedIssues;
  /**
   * The session-presence registry's record of the conversation `resume` names,
   * RESOLVED by the caller — the third thing on this context composed by the
   * service rather than parsed from the body, and for the same reason as the
   * two above: the browser names an id, the server reads the facts.
   *
   * It exists because a session resumed in the wrong directory is a DIFFERENT
   * session. Measured on this machine (CLI 2.1.243, Phase 8): `--resume <uuid>`
   * resolves the conversation GLOBALLY — run from another directory it does
   * find it and does continue it — and writes the new turns into the original
   * transcript carrying the new cwd. So the failure is not an error, which is
   * exactly what makes it worth pinning: the session comes up looking right and
   * is rooted somewhere else, with different relative paths, a different git
   * repository, and a different project `CLAUDE.md` and settings loaded.
   *
   * Absent (an id the registry does not know) means today's behaviour: the
   * console's open root.
   */
  resumeTarget?: ResumeTarget;
  /**
   * The account this session runs as, RESOLVED by the caller: the validated id
   * plus the env `accounts.envFor` answered for it. Same shape as the recovery
   * facts and for the same reason — the browser names an id, the service turns
   * it into an environment, and this function only carries it onto the spec.
   * Absent (or a null env) means the machine login.
   */
  account?: { id: string; env: Record<string, string> | null };
  /**
   * What this repository's ledgers say, for `intent: 'plan'` — composed by the
   * service (`Service.planFacts`), which can read every plan's manifest, its
   * twin and its rulings; the browser names nothing here. Absent when no root
   * is open, and the prompt says so rather than pretending to have read.
   */
  plan?: PlanFacts;
};

/** The repository's ledgers, digested for the plan wizard's opening. */
export type PlanFacts = {
  /** Open plans whose manifests and ledgers were read. */
  plans: number;
  /** Decision keys some open plan still has `outstanding`, with the plans. */
  outstanding: readonly { key: string; plans: readonly string[] }[];
  /** The newest rulings that named a decision key, newest first. */
  rulings: readonly { slug: string; phase: number; key: string; what: string; at: string }[];
  /** Manifest rows that came from a promoted ruling (source `ruling`). */
  promoted: number;
};

/**
 * Validate a request body into a `LaunchSpec`, or say exactly why not.
 *
 * Every failure names the field and the allowed values; none of them creates
 * a session. The spec's fields:
 *
 *   model           any Claude model name — alias, full id, or either with
 *                   the `[1m]` window suffix; optional (absent = CLI default)
 *   effort          ∈ EFFORTS, optional
 *   permissionMode  ∈ PERMISSION_MODES, optional
 *   prompt          ≤ MAX_AGENT_PROMPT_BYTES, may not begin with `-`, exclusive with intent
 *   skills          extra skill ids appended as a directive line
 *   resume          a claude session uuid → `--resume`, started in the
 *                   conversation's OWN directory when the registry knows it
 *                   (`ctx.resumeTarget`), exclusive with both
 *   intent: 'plan'  the wizard: the server composes the prompt from `brief`
 *   brief           ≤ 8 KB, required (and only meaningful) with intent
 *   intent:         a recovery: the server composes the prompt from the
 *     'recovery'    briefing it resolved (`ctx.recovery`), and stamps
 *                   `meta.recovery` so the exit can be checked against it
 *   intent: 'qa'    an independent review: the server composes the prompt from
 *                   the brief it resolved (`ctx.qa`), stamps `meta.qa` with the
 *                   verdict snapshot, and NEVER resumes — a review inherited
 *                   from the session that built the phase is not independent
 *   permissionProfile  `guarded` | `bypass`, QA sessions only; bypass is the
 *                   one place `sanitize`'s `allowBypass` is unlocked here
 */
export function buildAgentLaunch(
  body: Record<string, unknown>,
  ctx: AgentContext,
): { ok: true; launch: LaunchSpec } | AgentRefusal {
  const bad = (error: string): AgentRefusal => ({ ok: false, status: 400, error });

  const model = str(body.model);
  // `isKnownModel` and not membership of `MODELS`: `MODELS` is the escalation
  // ladder, four bare aliases, and using it as the allow-list here made
  // `claude-opus-5` — the CLI's own documented example — a 400, and left no way
  // at all to ask for the 1M window (`opus[1m]`).
  if (model && !isKnownModel(model)) {
    return bad(`model must name a Claude model: an alias (${MODELS.join(', ')}), a full id `
      + `(claude-opus-5), or either with the 1M window suffix (opus[1m]).`);
  }

  const effort = str(body.effort);
  if (effort && !isEffort(effort)) return bad(`effort must be one of: ${EFFORTS.join(', ')}.`);

  const permissionMode = str(body.permissionMode);
  if (permissionMode && !(PERMISSION_MODES as readonly string[]).includes(permissionMode)) {
    return bad(`permission mode must be one of: ${PERMISSION_MODES.join(', ')}.`);
  }

  const resume = str(body.resume);
  if (resume && !UUID_RE.test(resume)) return bad('resume must be a claude session id (a uuid).');

  if (body.intent != null && body.intent !== 'plan' && body.intent !== 'recovery' && body.intent !== 'qa') {
    return bad("intent, when given, must be 'plan', 'recovery' or 'qa'.");
  }
  const planIntent = body.intent === 'plan';
  const recoveryIntent = body.intent === 'recovery';
  const qaIntent = body.intent === 'qa';

  // Bypass is unlocked for ONE flow, named rather than implied. Widening it to
  // every agent session would be a different decision from the one this field
  // exists for, so the refusal is explicit and the surface stays where it was.
  const profileField = str(body.permissionProfile);
  if (profileField && !qaIntent) {
    return bad('permissionProfile is only accepted on a QA session — other sessions use permissionMode.');
  }
  if (profileField && !(QA_PROFILES as readonly string[]).includes(profileField)) {
    return bad(`permission profile must be one of: ${QA_PROFILES.join(', ')}.`);
  }
  const profile = (profileField ?? 'guarded') as QaProfile;
  if (profile === 'bypass' && permissionMode) {
    return bad('bypass IS the permission mode — send one or the other, not both.');
  }

  // Named rather than ignored, like `permissionProfile` above. A recovery or a
  // QA session composes a prompt about a phase; issues have nowhere to go in
  // it, and silently dropping them would let a caller believe a session was
  // briefed on work it never saw.
  if (body.issues != null && !planIntent) {
    return bad('issues are only accepted on a plan session — they compose its brief.');
  }

  /**
   * A plan-authoring session starts in plan mode unless told otherwise.
   *
   * The wizard's whole shape is "read the repository, then PRESENT a plan" —
   * and until this default existed the session could scaffold and commit
   * `docs/plans/<slug>.md` before anyone had read a word of it. Plan mode makes
   * the CLI itself hold the write until the operator approves in the terminal,
   * which is where they already are. An explicit `permissionMode` still wins:
   * the form offers the choice, so choosing must mean something.
   */
  const effectiveMode = planIntent ? (permissionMode ?? 'plan') : permissionMode;

  const prompt = str(body.prompt)?.trim();
  if (prompt && Buffer.byteLength(prompt) > MAX_AGENT_PROMPT_BYTES) {
    return bad(`the prompt is too long (${MAX_AGENT_PROMPT_BYTES / 1024} KB max).`);
  }
  if (prompt && prompt.startsWith('-')) {
    return bad("a prompt may not begin with '-' — the CLI would read it as a flag.");
  }
  if (resume && prompt) return bad('resume and a prompt are mutually exclusive — the resumed session has its context.');
  if (resume && planIntent) return bad('resume and a plan brief are mutually exclusive.');
  if (resume && recoveryIntent) return bad('resume and a recovery are mutually exclusive — a recovery starts fresh.');
  // Said again here even though `parseQaRequest` refuses it first: this is the
  // function that composes argv, and "the review is never the session that
  // built it" must not depend on a caller having parsed the body correctly.
  if (resume && qaIntent) return bad('a QA session is a fresh review — it never resumes the session that built the phase.');

  // What the first message says, and what the session gets named after.
  let text = '';
  let named = '';
  let planSkill = '';
  let label: string | undefined;
  let recoveryMeta: SessionMeta['recovery'];
  let qaMeta: SessionMeta['qa'];
  if (planIntent) {
    if (prompt) return bad('a plan session composes its own prompt — send the brief instead.');
    const brief = str(body.brief)?.trim();
    if (!brief) return bad('a plan session needs a brief.');
    if (Buffer.byteLength(brief) > MAX_BRIEF_BYTES) return bad('the brief is too long (8 KB max).');
    if (!ctx.rootOpen) return { ok: false, status: 409, error: 'No source directory is open.' };
    // The refs are shape-checked HERE and resolved by the service; a ref that
    // named no issue in this console's own estate is a 400 that NAMES it,
    // because the alternative — planning nine issues and quietly briefing six —
    // is a failure the operator would only find in the finished plan.
    const refs = issueRefs(body.issues);
    if (refs === 'malformed') {
      return bad(`issues must be refs of the form owner/repo#12, at most ${TICKET_ISSUES_MAX} of them.`);
    }
    if (refs.length && !ctx.issues) return bad('the issue estate could not be read.');
    const unknown = refs.length ? (ctx.issues?.unknown ?? []) : [];
    if (unknown.length) {
      return bad(`no such issue in this console's repositories: ${unknown.slice(0, 8).join(', ')}.`);
    }
    planSkill = phasedExecutionSkillId(ctx.skills());
    // 🔴 The issues get what is LEFT, not a fixed share (QA round 3). The two
    // caps were jointly unsatisfiable: an 8 KB brief is legal, twenty issues are
    // legal, and the composed 16 KB cap refused six of them with a message that
    // named neither — while this file's own header promised the issue text was
    // not the operator's budget. It is not, now: the section is handed the room
    // that remains after the template and the brief, and its three tiers spend
    // exactly that, degrading from full entries to a list of refs rather than
    // failing. An operator can always send a long brief OR many issues.
    let section = '';
    if (refs.length) {
      const base = Buffer.byteLength(planPrompt(brief, planSkill, ctx.scriptsDir, '', ctx.plan));
      // The margin covers what is appended AFTER this — the skill directive and
      // the `ultracode` line — plus the section's own head and discipline block.
      const room = MAX_AGENT_PROMPT_BYTES - base - ISSUES_FIXED_BYTES - ISSUES_MARGIN_BYTES;
      if (room < ISSUES_MIN_BYTES) {
        return bad('the brief leaves no room for the issues — shorten the brief, or send fewer.');
      }
      section = issuesSection(ctx.issues?.issues ?? [], room);
    }
    text = planPrompt(brief, planSkill, ctx.scriptsDir, section, ctx.plan);
    named = brief;
  } else if (recoveryIntent) {
    if (prompt) return bad('a recovery session composes its own prompt.');
    // The service resolves the briefing before we are called; reaching here
    // without one is a wiring bug, not something a browser can provoke.
    const facts = ctx.recovery;
    if (!facts) return bad('that recovery could not be resolved.');
    if (!ctx.rootOpen) return { ok: false, status: 409, error: 'No source directory is open.' };
    planSkill = facts.skillId;
    text = recoveryPrompt(facts);
    // Named from the thing it repairs, not from the prompt: `Recover <slug> P<N>`
    // reads as a row on the board, so sessions and phases scan together.
    label = recoveryLabel(facts);
    recoveryMeta = {
      kind: facts.class,
      slug: facts.slug,
      ...(facts.phase != null ? { phase: facts.phase } : {}),
      ...(facts.runId ? { runId: facts.runId } : {}),
    };
  } else if (qaIntent) {
    if (prompt) return bad('a QA session composes its own prompt.');
    // Resolved by the service before we are called; reaching here without a
    // briefing is a wiring bug, not something a browser can provoke.
    const facts = ctx.qa;
    if (!facts) return bad('that QA session could not be resolved.');
    if (!ctx.rootOpen) return { ok: false, status: 409, error: 'No source directory is open.' };
    planSkill = facts.skillId;
    text = qaPrompt(facts);
    label = qaLabel(facts);
    // The snapshot the exit check compares against. Taken from the facts the
    // service resolved a moment ago, so "did this session record anything?" is
    // answered against the table as it stood when the session was minted.
    qaMeta = {
      slug: facts.slug,
      phase: facts.phase,
      ...(facts.previous?.result ? { before: facts.previous.result } : {}),
      ...(facts.previous?.report ? { beforeReport: facts.previous.report } : {}),
      // Which round this session is producing, and the report it was told to
      // write. Carried on the session itself so the Sessions destination can
      // say "QA round 3 of phase 7, writing phase-07-qa-round3.md" without
      // fetching the run — and so a reader can open that report the moment it
      // exists, which was impossible while the path lived only in a prompt.
      ...(facts.round ? { round: facts.round } : {}),
      report: facts.reportArg,
    };
  } else if (prompt) {
    text = prompt;
    named = prompt;
  }

  // The skill the composed prompt is already about; naming it again in the
  // directive would read as a second, competing instruction.
  const composed = planIntent || recoveryIntent || qaIntent;
  const extras = skillIds(body.skills).filter((id) =>
    id !== planSkill && !(composed && (id === 'phased-execution' || id.endsWith(':phased-execution'))));
  const directive = skillDirective(extras);
  if (directive) text = text ? `${text}\n${directive}` : directive.trim();
  // The ticket's own standing opt-in, after the skill directive so the composed
  // brief still speaks first. `=== true` and nothing else: an unrecognised
  // value is silence, and silence is off — a ticket that fans out dozens of
  // agents must have been asked for in so many words.
  const ultracode = ultracodeDirective(body.ultracode === true);
  if (ultracode) text = text ? `${text}\n${ultracode.trim()}` : ultracode.trim();

  if (text && Buffer.byteLength(text) > MAX_AGENT_PROMPT_BYTES) {
    return bad(`the composed prompt is too long (${MAX_AGENT_PROMPT_BYTES / 1024} KB max).`);
  }

  const claudeSessionId = resume ?? randomUUID();
  label ??= labelFor(planIntent, named);
  // A resume with nothing else to be named after takes the registry's words
  // for the session it continues, rather than becoming another `Claude N`.
  if (resume) label ??= resumedLabel(ctx.resumeTarget);

  const argv: string[] = [];
  if (resume) argv.push('--resume', resume);
  else argv.push('--session-id', claudeSessionId);
  // Guarded is the absence of the flag — the CLI's own "ask before acting",
  // which is what a person watching a terminal is there for.
  if (profile === 'bypass') argv.push('--permission-mode', 'bypassPermissions');
  else if (effectiveMode) argv.push('--permission-mode', effectiveMode);
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  if (label) argv.push('--name', label.slice(0, 80));

  // `sanitize` stays the single audit point: bypass is not special-cased here,
  // it is UNLOCKED here, by the one profile that may ask for it.
  const flags = sanitize(argv, profile === 'bypass' ? { allowBypass: true } : undefined);
  const args = text ? [...flags, text] : flags;

  const meta: SessionMeta = {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    // What the session is actually running under, not what was asked for: the
    // page that shows "bypass" — or "plan", which a wizard session gets without
    // asking — must be reading the resolved argv's mode.
    ...(profile === 'bypass' ? { permissionMode: 'bypassPermissions' }
      : effectiveMode ? { permissionMode: effectiveMode } : {}),
    claudeSessionId,
    ...(planIntent ? { intent: 'plan' as const } : {}),
    // The linkage P2 built the session-exit announce policy around: a session
    // carrying it is always announced when it ends, and its outcome is checked
    // against the thing it was opened to fix.
    ...(recoveryMeta ? { intent: 'recovery' as const, recovery: recoveryMeta } : {}),
    // The linkage the exit check reads: a QA session's end is answered by
    // re-reading test-status.md rather than by reporting that a process ended.
    ...(qaMeta ? { intent: 'qa' as const, qa: qaMeta } : {}),
    // Which quota this session spends — display, and the resume-later story.
    ...(ctx.account && ctx.account.id !== 'default' ? { accountId: ctx.account.id } : {}),
  };

  return {
    ok: true,
    launch: {
      kind: 'claude',
      file: 'claude',
      args,
      ...(label ? { label } : {}),
      // A QA session over an ISOLATED run starts in that run's own checkout.
      // Absent everywhere else, so `terminal.ts` falls back to the console's
      // root exactly as it always did and no other session's cwd moves.
      // Naming the branch in the brief is not a substitute: git allows a branch
      // one working tree, so a reviewer told to check out `pe/<slug>` in the
      // shared root is told to do something git refuses.
      ...(qaIntent && ctx.qa?.gitStrategy?.workRoot ? { cwd: ctx.qa.gitStrategy.workRoot } : {}),
      meta,
      // The env, not the id: `terminal.ts` merges it verbatim and stays a
      // lifecycle for ptys that decides neither argv nor credentials.
      // `PE_OWNER` rides along so the session-presence hook reports this
      // session as the console's own — `kindOf()`'s `console/` branch was
      // dead and every pty agent registered as `foreign` without it.
      env: {
        ...(ctx.account?.env ?? {}),
        PE_OWNER: 'console/agent',
        // Where this reviewer publishes its task list: the unsupervised inbox
        // for its (slug, phase), which the Sessions page folds. Without it
        // `phase-tasks.sh` wrote the same file by its own fallback rule — and
        // nothing read it.
        ...(qaMeta && ctx.root ? { PE_TASKS_FILE: inboxTasksFile(ctx.root, qaMeta.slug, qaMeta.phase) } : {}),
      },
      // Where the conversation lives — see `resumeTarget`. Server-composed
      // from the registry record, never a path the browser sent; the same rule
      // the verify mint's `cwd` follows (`terminal.ts`'s `LaunchSpec.cwd`).
      ...(resume && ctx.resumeTarget?.cwd ? { cwd: ctx.resumeTarget.cwd } : {}),
    },
  };
}

/**
 * The id the boot prompt should invoke for plan authoring.
 *
 * Clones offer the bare `phased-execution`; marketplace installs offer the
 * namespaced `<plugin>:phased-execution`. `listSkills` already ordered
 * project ahead of personal ahead of plugin, so the first exact id wins,
 * then any skill whose *name* is right, then the literal as a last resort —
 * a session can still resolve it even if discovery saw nothing.
 */
export function phasedExecutionSkillId(skills: SkillInfo[]): string {
  const exact = skills.find((skill) => skill.id === 'phased-execution');
  if (exact) return exact.id;
  const byName = skills.find((skill) => skill.name === 'phased-execution');
  return byName ? byName.id : 'phased-execution';
}

/**
 * The wizard's boot prompt: the skill's own Mode 1, spelled as steps, with
 * two deliberate overrides.
 *
 * The first is the ending — step 6 stops instead of rolling into the root
 * phase, because in this product flow the phases are run from the console once
 * the operator has read the plan.
 *
 * The second is the beginning, and it is the reason the session is launched
 * `--permission-mode plan`: the phase list IS the decision, and a plan file
 * that is scaffolded, filled and committed before anyone has read it is a
 * decision taken on the operator's behalf. So the prompt is written in the two
 * halves plan mode already enforces — explore and present, then (once approved,
 * which is also when plan mode exits) write. The steps are unchanged; what
 * changed is which side of the approval each one is on.
 *
 * Everything interpolated is machine-local (the scripts directory) or the
 * operator's own words (the brief); the committed template itself must stay
 * neutral — a test holds it to the same scrub patterns as the guide.
 *
 * `issues` is the fourth thing that may be interpolated and the first that came
 * from off this machine: the "Issues to solve" section
 * (`server/issues/prompt.ts`), composed server-side from the console's own
 * cache. It goes AFTER the brief deliberately — the operator's words are the
 * decision and the issues are the material, and a session reads the last thing
 * it was told as the most specific. It is plain text in a prompt; nothing in
 * this console renders it as markup.
 */
export function planPrompt(
  brief: string, skillId: string, scriptsDir: string, issues = '', facts?: PlanFacts,
): string {
  // The questions, numbered Q1… so a session (and the test) can count them:
  // the manifest's keys first, the plan's own machine-read fields after — the
  // shape `INSTALL_PROMPT` uses for the capability flags, one at a time, the
  // recommended default named first.
  const manifest = MANIFEST_ORDER.map((key, i) => {
    const fallback = manifestDefault(key);
    return `   Q${i + 1}. \`${key}\` — ${MANIFEST_QUESTIONS[key]}${fallback ? ` (default ${fallback})` : ''}`;
  });
  const fields = PLAN_FIELDS.map((f, i) => `   Q${MANIFEST_ORDER.length + i + 1}. ${f.field} — ${f.question} → ${f.home}`);
  return [
    `Invoke the ${skillId} skill (/${skillId}) and use its Mode 1 — plan — for the brief below.`,
    "You are in the repository this plan is for; the skill's helper scripts live at:",
    scriptsDir,
    '',
    'This session starts in PLAN MODE: first explore and PRESENT the plan for approval —',
    'write nothing until the operator approves and plan mode exits.',
    '',
    ...ledgerDigest(facts, scriptsDir),
    '',
    'Before approval — read and decide, change nothing on disk:',
    '',
    '1. Pick the session budget for the model that will EXECUTE the phases (the skill\'s',
    '   references/sizing.md) and author the FEWEST phases that fit it.',
    '2. Ask the decision manifest ONE QUESTION AT A TIME — each numbered question below on',
    '   its own, the recommended default first, and wait for the answer before the next',
    '   (AskUserQuestion). Every answer becomes a row of the plan\'s "## Decisions" table; a',
    '   decision the operator leaves open stays outstanding WITH AN OWNER, and one they rule',
    '   out is waived with the reason as its value:',
    ...manifest,
    '3. Then the plan\'s own machine-read fields, the same way — each is a line',
    '   phase-graph.sh reads back, so an unasked one is a default nobody chose:',
    ...fields,
    '4. Work out the plan in the shape references/plan-format.md requires, and present it:',
    '   the "## Phase graph" table is machine-read, so every phase lists every dependency,',
    '   plus Size tags (S/M/L), exit criteria, and the blocking-vs-simultaneous callout —',
    '   and a runnable **Verification:** per phase (whole backticked commands or a fenced',
    '   block; the autopilot parks any phase whose verification nothing can execute).',
    '   Present that table, the session budget, and the "## Decisions" table with EVERY',
    '   row answered, waived or owned — the manifest is shown filled in BEFORE anything is',
    '   written, so the operator approves the answers and the phases together.',
    '',
    'After the operator approves the plan:',
    '',
    `5. Scaffold the file first: bash ${scriptsDir}/new-plan.sh <slug> — then fill the`,
    '   template in at docs/plans/<slug>.md, the manifest rows included.',
    `6. Sanity-check: bash ${scriptsDir}/phase-graph.sh <slug> (every phase listed, the`,
    `   roots ready, suggested batches printed), bash ${scriptsDir}/phase-graph.sh <slug> --decisions`,
    `   (every row as it holds) and bash ${scriptsDir}/validate.sh <slug>.`,
    '7. Commit docs/plans/<slug>.md with a message naming the plan.',
    '8. Then STOP and summarise the plan — do not begin implementing phases; they run from',
    '   the console (or from later sessions) once the operator has read the plan.',
    '',
    'A question the numbered list does not cover is still asked before authoring — the',
    'operator is watching this terminal and will answer here.',
    '',
    'The brief:',
    '',
    brief,
    ...(issues ? ['', issues] : []),
  ].join('\n');
}

/** How much of the ledger digest a prompt may carry — bounded, so it never crowds the brief. */
const DIGEST_OUTSTANDING_MAX = 8;
const DIGEST_RULINGS_MAX = 6;
const DIGEST_WHAT_MAX = 100;

/**
 * The opening: what this repository's ledgers already say. The last plans'
 * surprises — a key nobody answered, a ruling a session had to make — are
 * exactly the questions the next manifest should answer up front, which is
 * the feedback loop chapter 10 ZTD-7 found missing. Relative paths only: the
 * prompt must stay neutral (no absolute path outside the scripts dir).
 */
function ledgerDigest(facts: PlanFacts | undefined, scriptsDir: string): string[] {
  const lines = ['Open by reading this repository\'s ledgers — the last plans\' surprises are the next plan\'s questions.'];
  if (!facts) {
    lines.push('(No source root is open on this console, so nothing could be read for you: read',
      ' docs/plans/*.md "## Decisions" and docs/handoffs/<slug>/decisions.md yourself.)');
    return lines;
  }
  lines.push(`Read for you: ${facts.plans} open plan${facts.plans === 1 ? '' : 's'}, ${facts.promoted} answer${facts.promoted === 1 ? '' : 's'} promoted from rulings.`);
  if (facts.outstanding.length) {
    const shown = facts.outstanding.slice(0, DIGEST_OUTSTANDING_MAX)
      .map((o) => `\`${o.key}\` (${o.plans.length} plan${o.plans.length === 1 ? '' : 's'}: ${o.plans.slice(0, 3).join(', ')}${o.plans.length > 3 ? ', …' : ''})`);
    const more = facts.outstanding.length - shown.length;
    lines.push(`Still outstanding somewhere: ${shown.join(' · ')}${more > 0 ? ` · and ${more} more` : ''} — ask these first.`);
  } else {
    lines.push('No open plan leaves a decision outstanding.');
  }
  if (facts.rulings.length) {
    lines.push('Recent rulings that named a key (a decision a session had to make on the way — the next manifest answers it up front):');
    for (const r of facts.rulings.slice(0, DIGEST_RULINGS_MAX)) {
      const what = r.what.length > DIGEST_WHAT_MAX ? `${r.what.slice(0, DIGEST_WHAT_MAX - 1)}…` : r.what;
      lines.push(`   - ${r.slug} phase ${r.phase} · \`${r.key}\`: ${what}`);
    }
  }
  lines.push(`Read more with bash ${scriptsDir}/phase-graph.sh <slug> --decisions, and in docs/handoffs/<slug>/decisions.md.`);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Small parsers
 * ------------------------------------------------------------------ */

/** A non-empty string, or nothing — `''` from a form means "not chosen". */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** Extra skill ids: shaped, deduped, capped — invalid entries dropped, not fatal. */
function skillIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || id.length > 200 || !SKILL_ID.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * A ticket's issue refs — the list, or the word `malformed`.
 *
 * Unlike `skillIds`, a bad entry here is FATAL rather than dropped, and the
 * difference is the point: an unusable skill id costs a directive line, while a
 * dropped issue ref costs an issue the operator selected and believes is being
 * planned. Absence is an empty list; anything else that is not a clean array of
 * `owner/repo#12` within the bound is a refusal.
 */
function issueRefs(value: unknown): string[] | 'malformed' {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > TICKET_ISSUES_MAX) return 'malformed';
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return 'malformed';
    const ref = item.trim();
    if (!ISSUE_REF_RE.test(ref)) return 'malformed';
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/**
 * What the tab and claude's own `/resume` picker call this session. Derived
 * from the operator's words rather than a counter, so five parked sessions
 * are five names, not `Claude 1` through `Claude 5` — the registry's counter
 * still names sessions launched bare.
 */
function labelFor(planIntent: boolean, text: string): string | undefined {
  const words = text.replace(/\s+/g, ' ').trim();
  if (!words) return undefined;
  const short = words.length > 48 ? `${words.slice(0, 47).trimEnd()}…` : words;
  return planIntent ? `Plan: ${short}` : `Claude: ${short}`;
}

/**
 * What a run may be told, named once.
 *
 * Two doors accept run settings — `POST /api/run/:slug/start` and
 * `POST /api/run/:slug/settings` — and until Phase 4 they each quietly dropped
 * whatever they did not recognise. Phase 4 made them 400 instead. This module
 * is the other half of that fix: the LIST itself, in one place, so the form
 * that builds a payload and the route that reads one cannot drift.
 *
 * There are three readers:
 *
 * - `server/api/routes.ts` is the real door, and these lists describe it.
 *   Nothing here validates anything; the route's own coercion is still the wall.
 * - `client/src/features/run-setup/schema.ts` builds its zod shape from these
 *   names, so a field the server accepts and the form cannot send is a test
 *   failure rather than a silent capability gap.
 * - `test/run-settings-parity.test.ts` reads the route module's source and
 *   holds all three honest: every `body.<field>` the two case blocks read must
 *   appear here, and every name here must be read there.
 *
 * ⚠️ Data only, no imports — the client bundles this, and `node --test`
 * imports it directly. Adding a field to a door means adding it here in the
 * same commit; that is the whole point.
 */

/**
 * Fields `POST /api/run/:slug/start` reads off the body.
 *
 * Ordered the way the route reads them, not alphabetically: this list is a
 * description of that code, and a reviewer comparing the two should be able to
 * walk both in one pass.
 */
/**
 * How much a session may do without asking — the run's permission PROFILE.
 *
 * ⚠️ Only the ask list moves between profiles. `deny` is the wall and is
 * identical in all three (`server/runner/approvals.ts`); a profile that could
 * widen it would make the wall a preference.
 * @typedef {'guarded'|'trusted'|'bypass'} PermissionProfile
 * @type {readonly PermissionProfile[]}
 */
export const PERMISSION_PROFILES = Object.freeze(/** @type {const} */ (['guarded', 'trusted', 'bypass']));

/**
 * The profile a run gets when nobody names one — and the answer to "what is in
 * force here?", which until 3.5.0 nothing could give.
 *
 * There is no `permissionProfile` PREFERENCE: the profile is per-run, and the
 * run door falls back to this word for a body that does not say (and for one
 * that says something unrecognised, so a typo can never be the reason a run
 * takes the guard rails off). That fallback was spelled as a literal at the
 * door, which meant `GET /api/policy` could list the profiles that EXIST and
 * not the one a new run would actually get. Naming it here gives both the same
 * source.
 * @type {PermissionProfile}
 */
export const DEFAULT_PERMISSION_PROFILE = /** @type {const} */ ('guarded');

/**
 * What each profile is CALLED, in the one place it is decided.
 *
 * Three tables held these strings — `runner/approvals.ts`,
 * `features/runs/defaults.ts` and `features/run-setup/modes.ts` — and two of
 * them disagreed: the server served "Guarded — ask about the irreversible"
 * from `/api/…` while both client tables said "ask me about", so the SAME
 * profile was labelled two ways depending on which surface drew it. The
 * client's wording wins (it is the one a person reads while choosing, and it
 * was two sites to one). console-audit-hardening P23 reconciled it
 * deliberately; it is the only user-visible string that phase changed.
 *
 * Since zero-touch phase 12 each label says what the profile SILENCES, and
 * that deny refuses on every one of them (chapter 08 TRS-9: a picker offering
 * three postures must not imply a difference the policy cannot deliver — and
 * with the ask list struck empty, Guarded and Trusted are one posture, which
 * the policy page's advisory says out loud).
 * @type {Readonly<Record<PermissionProfile, string>>}
 */
export const PROFILE_LABELS = Object.freeze({
  guarded: 'Guarded — asks about everything on the ask list; deny still refuses',
  trusted: 'Trusted — silences the ask list; deny still refuses',
  bypass: 'Bypass — silences the ask list and the CLI’s own prompts; deny still refuses',
});

/**
 * How many rounds QA may FAIL on one phase before the run stops asking.
 *
 * Three, because it is the smallest number that lets the normal shape happen —
 * QA fails, the builder fixes it, QA passes — and still leaves one round of
 * slack for a fix that misses. Above that the evidence is that nobody is
 * converging and a person should look: on the run issue #7 was written from,
 * the phase that reached five rounds was not one round from passing.
 *
 * Named here rather than spelled at the door because three readers need it —
 * the run door's coercion, the ladder's refusal, and the Settings copy that
 * tells an operator what they are changing from.
 * @type {number}
 */
export const DEFAULT_QA_MAX_ROUNDS = 3;

/**
 * How a QA recovery boards the session that FIXES what the report found.
 *
 *   - `resume` — continue the phase's own session (`claude -p --resume`). It
 *     already holds the context the report is about, which is what makes the
 *     fix half cheap, and it is what both QA ladder rungs have always done.
 *   - `fresh`  — board a new session from the phase's boot prompt with the last
 *     report's findings appended verbatim. Fresh eyes, a full session's cost.
 *
 * `resume` is the default and `fresh` is the fallback the loop takes by itself
 * when no session id survives (a run from another console, a hand-driven plan,
 * a session whose transcript is gone) — so the word an operator chooses is a
 * PREFERENCE, never a promise the machine can always keep. `qa-recover`
 * journals which one it actually used, per round.
 * @typedef {'resume'|'fresh'} QaFixStrategy
 * @type {readonly QaFixStrategy[]}
 */
export const QA_FIX_STRATEGIES = Object.freeze(/** @type {const} */ (['resume', 'fresh']));

/** What a run gets when nobody names a strategy — see `QA_FIX_STRATEGIES`. */
export const DEFAULT_QA_FIX_STRATEGY = /** @type {const} */ ('resume');

/** What each strategy is CALLED, decided once — the picker, the card, the journal. */
export const QA_FIX_STRATEGY_LABELS = Object.freeze({
  resume: "Resume the phase's own session",
  fresh: 'Board a fresh session with the findings',
});

/**
 * The CLI permission modes a phase may run under. Members are decided here;
 * each surface keeps its own ORDER (the server declares them in CLI order, the
 * run-setup picker in the order it offers them), which is why this is a list
 * and not a display order.
 * @typedef {'acceptEdits'|'auto'|'dontAsk'|'plan'|'manual'} PermissionMode
 * @type {readonly PermissionMode[]}
 */
export const PERMISSION_MODES = Object.freeze(
  /** @type {const} */ (['acceptEdits', 'auto', 'dontAsk', 'plan', 'manual']),
);

export const RUN_START_FIELDS = Object.freeze([
  'model',
  'effort',
  'maxParallel',
  'maxConsecutiveFailures',
  'autonomy',
  'phaseBudgetUsd',
  'runBudgetUsd',
  'resumeRunId',
  'onlyPhases',
  'phaseOptions',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'permissionProfile',
  'gitMode',
  'openPr',
  'isolation',
  // What happens to the finished branch: `pr` (push and open one), `keep`
  // (leave it), `integration` (merge it into the console's staging checkout) or
  // `merge-queue` (a session rebases, re-verifies, then pushes). It rides
  // beside `openPr` rather than replacing it, because every run file already
  // written carries `openPr` and must keep meaning what it meant —
  // `settleOf()` in `shared/worktree-model.js` is the one place that folds the
  // two into an answer.
  'settle',
  // Which class this run's admissions queue in, and which plan it begins
  // after. `priority` is on both lists (it is changeable mid-run); `startAfter`
  // is start-only, because a chain says where a run BEGINS and a run already
  // mid-plan cannot un-begin. See `shared/orchestration-model.js`.
  'priority',
  'startAfter',
  'reviewEachPhase',
  'reviewerPolicy',
  // The two "ultra" opt-ins, both off and both on BOTH lists. `ultracode` is a
  // word in the prompt rather than a flag — it licenses the session's Workflow
  // tool to fan out — and `ultraReview` says when the run spends the operator's
  // cloud budget on `claude ultrareview`. Neither is a stored preference: an
  // opt-in that costs money per phase is chosen for a run, every time.
  'ultracode',
  'ultraReview',
  'attachDefaultSkills',
  'qa',
  // QA's own three, and they are the run's rather than the ladder's on purpose.
  // `qaMaxRounds` is the QA FAILURE BUDGET — "QA may fail N rounds on a phase,
  // then stop" — which the `ladder*` caps could never express: those count
  // RUNGS and dollars, and a round driven from inside a phase's own session is
  // neither, which is how one phase reached five rounds under a two-rung cap.
  // `qaModel`/`qaEffort` are the reviewer's own tier: the review is a different
  // job from the build and is regularly worth a different one in EITHER
  // direction (Fable builds, Opus reviews — or a cheap reviewer for a
  // mechanical phase). All three are on both lists, for `reviewEachPhase`'s
  // reason: an operator watching a run review more, or more expensively, than
  // they meant must be able to change THAT without stopping the run.
  'qaMaxRounds',
  'qaModel',
  'qaEffort',
  // QA RECOVERY's own two, and on both lists for the reason the three above
  // are: an operator watching a recovery loop spend more per round than they
  // meant must be able to change THAT without stopping the run.
  // `qaFixStrategy` says how the fix session is boarded (see the vocabulary
  // above); `qaRoundBudgetUsd` is a hard stop for ONE ROUND and never for the
  // run — the distinction is the whole point, because `phaseBudgetUsd` cannot
  // express "each attempt gets this much" and a loop under a phase budget
  // spends the phase's entire allowance on round one.
  'qaFixStrategy',
  'qaRoundBudgetUsd',
  'accountId',
  'onLimit',
  'autoRecover',
  // The prelude's four required answers and its one recorded override (phase
  // 11, ZTD-2/QRL-2). START-only, every one: they are the run's answers to the
  // decision manifest — `resume.on-restart`, `relay`, `accounts` and the
  // acknowledgement of every `waived` row — and a settings patch cannot
  // re-answer what the door was refused on. `accounts` is a list of
  // `{id, minHeadroomPct}` (the plan's `**Accounts:**` clause, `id:min`);
  // `manifestOverride` is `{rows, by}` — the one way past a blocking row, and
  // it is journalled as `run.manifest-override` so nothing is silent.
  'resumeOnRestart',
  'relay',
  'accounts',
  'acknowledgedWaivers',
  'manifestOverride',
  // The answers to the prelude's fifth probe, verification (2026-09-18): the
  // exact commands, by fingerprint, the built-in tier would not run but the
  // operator approves, and the `<phase>:<fp>` fragments set aside. START-only
  // for the reason the prelude's answers above are — the door judged them, and a
  // patch cannot re-answer it.
  'verifyAnswers',
  // What many-plans-one-repo phase 15 gave the launch form, every field of it
  // ALSO a plan line (or a Settings default) — the run's word speaks only
  // where the plan is silent, the `mcpPolicy` precedent. Each takes a word
  // from its shared owner and nothing else: `baseBranch` is a ref
  // (`shared/landing-model.js` names the members that are questions rather
  // than answers), `maxConcurrentPerRepo` a whole number clamped to the
  // console's own cap, `worktreeRetention` a `WORKTREE_RETENTION` member or
  // `ttl:<h>`, and the rest members of `LAND_POLICIES`, `CONFLICT_POLICIES`,
  // `MESSAGING_WORDS` and `ISSUE_MODES`.
  'baseBranch',
  'maxConcurrentPerRepo',
  'worktreeRetention',
  'landing',
  'conflictPolicy',
  'messaging',
  'issuesMode',
]);

/**
 * The relay (Tier 2, phase 14) a run may arm: `off` — the console answers
 * nothing on the session's behalf and every `relay: off` run carries
 * `--permission-prompts none`; `last-resort` — a question a session raises
 * reaches a person and, unanswered after the window, the console's rule table.
 * The manifest's `relay` row and the run's `relay` field share this list.
 * @typedef {'off'|'last-resort'} RelayMode
 * @type {readonly RelayMode[]}
 */
export const RELAY_MODES = Object.freeze(/** @type {const} */ (['off', 'last-resort']));

/**
 * The CLI version the relay arms at — the first release whose
 * `PermissionRequest` `http` hook fires in `-p` (phase 1's spike S2, measured
 * on 2.1.270; the floor is the audit's, chapter 13 §4). Read from
 * `system/init.claude_code_version`, never from `capabilities`; `phase-console
 * doctor` compares the installed CLI against it and phase 14 refuses to arm below it.
 */
export const RELAY_CLI_FLOOR = '2.1.268';

/**
 * The CLI version `--permission-prompts none` arrived in (the CLI reference:
 * "Requires Claude Code v2.1.259 or later. Earlier versions reject it with an
 * unknown-option error"). Every `relay: off` run carries the flag — the floor
 * for a run nobody can answer (QRL-9): anything that would prompt is denied,
 * the session is told nobody can approve and not to retry, `AskUserQuestion`
 * is removed and elicitations are cancelled. A run under a KNOWN older CLI
 * gets no flag and a `run.permission-prompts-skipped` line instead.
 */
export const PERMISSION_PROMPTS_CLI_FLOOR = '2.1.259';

/**
 * Is `version` at or above `floor`? 3 numeric parts, a leading `v` ignored, a
 * missing part read as 0; `null` when there is no version to compare. The one
 * comparison the doctor's `cli` row and the floor flag share.
 * @param {string | null | undefined} version
 * @param {string} floor
 * @returns {boolean | null}
 */
export function versionAtLeast(version, floor) {
  if (!version) return null;
  /** @param {string} v */
  const parse = (v) =>
    v
      .trim()
      .replace(/^v/, '')
      .split('.')
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

/**
 * Fields `POST /api/run/:slug/settings` reads off the body.
 *
 * The difference from `start` is the point, so it is spelled out rather than
 * derived: `resumeRunId`, `qa`, `accountId` and `startAfter` are START-only — a
 * settings patch cannot mint a run, turn a plan's QA gate on, move a run's
 * account (that last one is its own verb, `switch-account`) or retroactively
 * unstart a run that has already begun. `by` is not a setting: it is the audit
 * attribution the route stamps.
 */
export const RUN_SETTINGS_FIELDS = Object.freeze([
  'model',
  'effort',
  'maxParallel',
  'autoRecover',
  'autonomy',
  'phaseBudgetUsd',
  'runBudgetUsd',
  'maxConsecutiveFailures',
  'onlyPhases',
  'phaseOptions',
  'skills',
  'mcpServers',
  'mcpPolicy',
  'permissionProfile',
  'gitMode',
  'openPr',
  // Read on `settings` and only half-honoured, which is why it is on BOTH
  // lists rather than in `START_ONLY_FIELDS`: the route really does read
  // `body.isolation` here, and the parity test describes what the route reads.
  // What it does with it is one-way — a drop lands, a raise 409s — and that
  // rule lives at the door and in `applySettings`, not in this list.
  'isolation',
  // Changeable mid-run in BOTH directions, unlike `isolation` above, and the
  // asymmetry is arithmetic rather than caution: isolation is about where a
  // run's commits ALREADY are, and settle is about what happens to them at the
  // end — which has not happened yet. An operator who decides mid-run that this
  // branch should go to the staging checkout instead of a pull request is
  // making a decision about the future, and nothing in the run's past depends
  // on the answer.
  'settle',
  // Changeable mid-run both ways, unlike `isolation` above: nothing about a
  // run's past depends on which class its next admission is scanned in, and
  // `Scheduler.reprioritize` carries the change to entries already waiting.
  'priority',
  // Changeable mid-run, and deliberately: turning the reviewer off is how an
  // operator stops a run that is reviewing more than they wanted, without
  // stopping the run. It lands on the next phase-finish.
  'reviewEachPhase',
  'reviewerPolicy',
  // Changeable mid-run, both of them, and for `reviewEachPhase`'s reason: an
  // operator who sees a run fanning out further than they meant, or spending
  // more cloud review than they meant, must be able to stop THAT without
  // stopping the run. `ultracode` lands on the next phase's prompt and
  // `ultraReview` on the next phase-finish.
  'ultracode',
  'ultraReview',
  'attachDefaultSkills',
  // Changeable mid-run, all three — see the comment on the start list. Note
  // `qa` itself is NOT here and stays start-only: turning a plan's QA gate on
  // writes `test-status.md`, and these three only say how the reviewing is
  // done once something has decided there is reviewing to do.
  'qaMaxRounds',
  'qaModel',
  'qaEffort',
  // Changeable mid-run, both — see the start list. Neither creates anything on
  // disk (that is `qa`'s reason for being start-only): they only say how the
  // next recovery round is boarded and what it may spend.
  'qaFixStrategy',
  'qaRoundBudgetUsd',
  'onLimit',
  // Phase 15's seven, every one read here too — three of them with a RULE
  // that lives at the door and in `applySettings`, not in this list (the
  // `isolation` precedent above: the list describes what the route READS).
  // `landing` and `conflictPolicy` move both ways: they decide what happens
  // when a phase settles, which has not happened yet for the phases to come.
  // `baseBranch` is read and refused with a 409 once the run's branch exists
  // — it was cut from the old word, and a new one would describe a fork that
  // never happened. `issuesMode` is read and may only TIGHTEN (file → draft →
  // off): loosening it mid-run would let sessions already boarded file on the
  // repository under a word nobody launched them with. `messaging`,
  // `worktreeRetention` and `maxConcurrentPerRepo` move both ways and land on
  // the next spawn, the next settle and the next admission.
  'baseBranch',
  'maxConcurrentPerRepo',
  'worktreeRetention',
  'landing',
  'conflictPolicy',
  'messaging',
  'issuesMode',
]);

/** Accepted on `start` and refused on `settings` — asserted, not assumed. */
export const START_ONLY_FIELDS = Object.freeze(
  RUN_START_FIELDS.filter((field) => !RUN_SETTINGS_FIELDS.includes(field)),
);

/** What one phase may override for itself (`PhaseOptions`, `phaseOptions()` in the route). */
export const PHASE_OPTION_FIELDS = Object.freeze([
  'model',
  'effort',
  'tools',
  'permissionMode',
  'skills',
  'skillsOff',
  'mcpServers',
  'mcpOff',
  'mcpPolicy',
  'autoApprove',
  // A phase may carve itself out of the run's answer in EITHER direction, like
  // `autoApprove` and unlike `skillsOff`: "fan out here" and "not here" are
  // both choices about one phase's work, and silence is what inherits the run's.
  'ultracode',
]);

/**
 * Where a phase's model or effort came from: `retry` (this attempt's Retry with
 * edits) · `run` (this run's per-phase choice) · `plan` (the plan's own bullet) ·
 * `default` (the run's default), strongest first.
 * @typedef {'retry'|'run'|'plan'|'default'} PhaseChoiceSource
 */

/**
 * What one phase runs as for one field (a model, an effort), resolved from the
 * four places that may say — and which of them answered.
 *
 * The order is the runner's and is never rearranged: the attempt, then the run's
 * per-phase choice, because both are more recent and more specific than the plan;
 * then the plan, the durable statement of what the phase needs; then the run's
 * default. `source` is undefined only when nothing answered, which leaves the
 * machine's own default.
 *
 * ONE function with two readers (autopilot-token-drain phase 5): the runner boards
 * the phase with it (`optionsFor`), and the launch form's per-phase table shows it.
 * They were two copies of one rule, and run `deadaff9` launched with a form that
 * never said the plan's `high` sat below the run default's `max`. An empty string is
 * "no choice here", the per-phase select's own empty value.
 * @param {{ retry?: string, run?: string, plan?: string, fallback?: string }} [levels]
 * @returns {{ value: string | undefined, source: PhaseChoiceSource | undefined }}
 */
export function resolvePhaseChoice({ retry, run, plan, fallback } = {}) {
  if (retry) return { value: retry, source: 'retry' };
  if (run) return { value: run, source: 'run' };
  if (plan) return { value: plan, source: 'plan' };
  if (fallback) return { value: fallback, source: 'default' };
  return { value: undefined, source: undefined };
}

/**
 * A plan's `**Model:**` bullet, read as the model the phase will be started on.
 *
 * The match keeps the whole model token, not just the family word. It used to
 * collapse to a bare alias, which meant a plan that carefully asked for
 * `claude-opus-5[1m]` ran on plain `opus`: the one part of the name the operator
 * wrote on purpose — the window — was the part thrown away. The server reads the
 * bullet through this function, so the launch form can show exactly that token.
 * @param {string | undefined} text
 * @returns {string | undefined}
 */
export function planModelOf(text) {
  const match = /\b(?:claude-)?(?:fable|opus|sonnet|haiku)(?:-[0-9a-z.]+)*(?:\[1m\])?/i.exec(text ?? '');
  return match ? match[0].toLowerCase() : undefined;
}

/**
 * The same, for `**Effort:**` — one of the five levels the CLI accepts, or nothing.
 * @param {string | undefined} text
 * @returns {string | undefined}
 */
export function planEffortOf(text) {
  const match = /\b(low|medium|high|xhigh|max)\b/i.exec(text ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * Where a plan orders its OWN reviewer inside the building session — what the
 * launch form advises from when `reviewEachPhase` would review the same diff a
 * second time (autopilot-token-drain phase 5; run `deadaff9` paid for both on
 * every phase it finished).
 *
 * Two shapes count, and only as orders:
 * - `dispatch` (any tense) with a reviewer at most 3 words after it —
 *   `dispatch ONE fresh-context reviewer`, `dispatches a code-reviewer subagent`;
 * - a `subagent_type` whose value names a reviewer —
 *   `subagent_type: feature-dev:code-reviewer`. `subagent_type: Explore` is not one.
 * A sentence negated before the match ("No remaining phase dispatches a reviewer
 * agent") orders nothing, and "a reviewer's verdict → dispatch the `Agent`" puts
 * the reviewer BEFORE the verb, which is talk about one.
 *
 * Narrow on purpose: an advisory that fires on a plan merely discussing reviews
 * teaches an operator to ignore it. One mention per section — the nearest `##` to
 * `####` heading above it, `''` before any — and at most five.
 * @param {string | undefined} markdown
 * @returns {{ section: string, excerpt: string }[]}
 */
export function inPlanReviewers(markdown) {
  const text = markdown ?? '';
  const headings = [...text.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map((m) => ({
    at: m.index ?? 0,
    title: m[1],
  }));
  const orders =
    /\bdispatch(?:es|ed|ing)?\s+(?:[\w`'’()-]+\s+){0,3}?[\w`:-]*reviewers?\b|\bsubagent_type\W{0,4}[\w:-]*review/gi;
  const negated = /\b(?:no|not|never|without|nor|cannot|can['’]t|don['’]t|doesn['’]t|removed)\b/i;
  /** @type {{ section: string, excerpt: string }[]} */
  const found = [];
  const sections = new Set();
  for (const match of text.matchAll(orders)) {
    const at = match.index ?? 0;
    const lead = sentenceLead(text, at);
    if (negated.test(lead)) continue;
    const section = headings.filter((heading) => heading.at < at).pop()?.title ?? '';
    if (sections.has(section)) continue;
    sections.add(section);
    const words = text
      .slice(at - lead.length, at + match[0].length + 160)
      .replace(/\s+/g, ' ')
      .trim();
    found.push({ section, excerpt: words.length > 240 ? `${words.slice(0, 239).trimEnd()}…` : words });
    if (found.length === 5) break;
  }
  return found;
}

/**
 * The part of the sentence before `at`: back to the nearest sentence end, blank
 * line, list marker or heading, whichever is closest.
 * @param {string} text
 * @param {number} at
 * @returns {string}
 */
function sentenceLead(text, at) {
  const window = text.slice(Math.max(0, at - 400), at);
  const pieces = window.split(/[.!?;][)"'’*_`\]]*\s+|\n\s*\n|\n\s*(?:[-*+]|\d+\.)\s+|\n#{1,6}\s/);
  return pieces[pieces.length - 1] ?? '';
}

/**
 * What `POST /api/agent/ticket` takes for the two launches this form mints —
 * a QA review and a recovery. Not a run: an agent ticket opens ONE interactive
 * session, so it has no budget, no git strategy and no per-phase matrix.
 *
 * `cols`/`rows` are carried by the caller (`estimateTerminalSize`), not by the
 * form: the pty is born at the size the browser can see, which is a property of
 * the viewport rather than of the launch.
 */
export const AGENT_TICKET_FIELDS = Object.freeze([
  'intent',
  'slug',
  'phase',
  'runId',
  'recoveryClass',
  'activate',
  'model',
  'effort',
  'permissionProfile',
  'permissionMode',
  'prompt',
  // The plan wizard's 8 KB operator brief — read by `buildAgentLaunch` since
  // the wizard shipped, and unlisted here until Phase 14, because the test
  // that was meant to catch that was anchored on a route head that does not
  // exist and had been scanning an empty string.
  'brief',
  // The issues a plan-from-issues ticket is about, as `owner/repo#12` REFS.
  // Refs and not text: the server resolves them against its own issue cache and
  // composes the "Issues to solve" section itself, so nine selected issues cost
  // the operator's 8 KB brief nothing (`server/issues/prompt.ts`).
  'issues',
  'skills',
  // One session, one standing opt-in: a ticket that says `ultracode` gets the
  // line in its prompt and nothing else changes. `ultraReview` is deliberately
  // NOT here — a ticket opens an interactive session with no branch of its own
  // and no phase-finish to hang a cloud review on.
  'ultracode',
  'resume',
  'accountId',
  'cols',
  'rows',
]);

/**
 * The plan's machine-read fields — what the engine reads back, and therefore
 * what the plan wizard must ask (zero-touch phase 12, chapter 10 ZTD-11).
 *
 * `scripts/phase-graph.sh` answers questions about a plan through flags, and
 * every flag that READS A PLAN FIELD BACK names a field a plan author must
 * have written: the Repos column, a `- **Size:**` tag, the `**MCP policy:**`
 * line. The skill's Mode 1 elicits all of them one question at a time; the
 * console's own wizard once listed six duties and asked about none of this,
 * so the plans it produced were the ones least able to answer anything.
 *
 * This table is the coupling: `PLAN_FIELDS` maps each such flag to the field
 * it reads and the question the wizard asks for it, `STATE_FLAGS` names the
 * flags that COMPUTE state rather than read a field (with the reason), and
 * `test/agent.test.ts` holds the union of the two to the script's actual flag
 * list — the way `test/skill-sync.test.ts` holds SKILL.md to the capability
 * flags. A flag added to the script without a home here fails the suite; a
 * home that names a flag the script no longer has fails it too.
 */

import { DECISION_KEYS, type DecisionKey } from '../shared/decisions-model.js';
import { POLICY_DEFAULTS } from '../shared/policy-model.js';
import { MCP_POLICIES } from '../shared/run-lifecycle.js';

export type PlanField = {
  /** The field's name, as the prompt and the test spell it. */
  field: string;
  /** The `phase-graph.sh` flags that read it back — empty for a console-only read. */
  flags: readonly string[];
  /** Where it is written in the plan. */
  home: string;
  /** The one-line question the wizard asks, default included when there is one. */
  question: string;
};

/** Every plan field the engine reads back, in the order the wizard asks them. */
export const PLAN_FIELDS: readonly PlanField[] = Object.freeze([
  { field: 'Repos', flags: ['--repos'], home: '## Phase graph, the Repos column',
    question: 'which repositories each phase touches — its scope; `all` runs alone' },
  { field: 'Depends on', flags: ['--deps', '--dependents', '--ready', '--ready-after'], home: '## Phase graph, the Depends on column',
    question: 'every phase each phase must wait for — a DAG, never a line' },
  { field: 'Size', flags: ['--size'], home: '- **Size:** S|M|L on each phase',
    question: "each phase's weight against the session budget (default M)" },
  { field: 'Target model', flags: ['--session-plan'], home: '## Session budget, **Target model:**',
    question: 'the model that will EXECUTE the phases — it sets the budget' },
  { field: 'Gate-check', flags: ['--gated', '--gate-kind', '--gate-status'], home: '*(GATED)* headings with - **Gates:** and - **Gate-check:**',
    question: 'which phases wait on something outside the plan, and who can clear it (default ai)' },
  { field: 'MCP servers', flags: ['--mcp'], home: '**MCP servers (every session):** and - **MCP:**',
    question: 'MCP servers every session needs, and any one phase needs (default none)' },
  { field: 'MCP policy', flags: ['--mcp-policy'], home: `**MCP policy:** ${MCP_POLICIES.join('|')}`,
    question: 'what a phase does when its server will not connect (default continue)' },
  { field: 'Credentials', flags: ['--credentials'], home: '**Credentials:** and - **Credentials:**',
    question: 'the logins the plan needs — gh, claude-login, env:NAME, keychain:SERVICE, file:PATH' },
  { field: 'Credential policy', flags: ['--credential-policy'], home: `**Credential policy:** ${MCP_POLICIES.join('|')}`,
    question: 'whether a missing credential parks a phase at boarding (default continue)' },
  { field: 'Accounts', flags: ['--accounts'], home: '**Accounts:** `id:minHeadroom`',
    question: 'which Claude accounts may spend, each with a headroom floor (default default:0)' },
  { field: 'QA gate', flags: ['--qa-mode'], home: '**QA gate:** on|off and - **QA:** on|off',
    question: 'whether a fresh-context reviewer gates each phase (default off)' },
  { field: 'QA exhausted', flags: ['--qa-exhausted'], home: '**QA exhausted:** waive|halt|<owner>',
    question: 'what happens when the QA rounds run out (default waive; skip when QA is off)' },
  { field: 'Person-check', flags: ['--person-check'], home: '- **Person-check:** allow|halt|<owner>',
    question: 'what a prose §Verification line does — waived, parked at boarding, or asked of whom' },
  { field: 'Wait budget', flags: ['--wait-budget'], home: '**Wait budget:**',
    question: "the longest a phase may stay parked on an external clock (default the console's)" },
  { field: 'Waits on', flags: ['--waits-on'], home: '- **Waits on:** <ref> · <max>',
    question: 'the external clocks a phase is known to wait on, each with its --watch ref' },
  { field: 'Decisions', flags: ['--decisions'], home: '## Decisions',
    question: 'the manifest itself — every row above answered, waived (with the reason) or owned' },
  { field: 'Setup', flags: ['--setup'], home: '**Setup (every phase):** and - **Setup:**',
    question: 'bring-up commands that run before verification and can never fail a phase' },
  { field: 'Checkout', flags: ['--checkout'], home: '- **Checkout:** default',
    question: 'a phase that must stand on the trunk, not the run branch (after a merge)' },
  { field: 'Skills', flags: [], home: '**Skills (every session):**',
    question: 'skills every session re-invokes before implementing (default none)' },
  { field: 'Worktrees', flags: [], home: '- **Worktrees:** on|off',
    question: 'whether disjoint lanes each get their own checkout (default off)' },
  { field: 'Branch', flags: [], home: '**Branch:**',
    question: 'one branch for the whole plan, or the one already checked out (default)' },
]);

/** The flags that compute state rather than read a field, each with its reason. */
export const STATE_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  '--lint': 'validates the plan; reads every field above and authors none',
  '--memory-block': "the board's five buckets, computed from the handoffs",
  '--qa-result': 'a recorded verdict, written by qa-record.sh after a review',
  '--qa-history': 'every recorded round, same source',
  '--qa-prompt': "composes the reviewer's brief from the fields above",
  '--boot-prompt': "composes a session's boot prompt from the fields above (Skills reaches a session only through it)",
  '--plan-status': 'the frontmatter status, written by close-plan.sh, never asked',
  '--closed': 'the predicate over that status',
});

/** The question the wizard asks for each manifest key, in `DECISION_KEYS` order. */
export const MANIFEST_QUESTIONS: Readonly<Record<DecisionKey, string>> = Object.freeze({
  'permission.policy': "this plan's ask/deny/allow overlay and autoApprove (also a **Permissions:** line)",
  'permission.destructive': 'publishing and destructive verbs: deny, with named per-phase exceptions (**May publish:**)',
  credentials: 'the logins it needs (**Credentials:**) and whether a missing one parks a phase (**Credential policy:**)',
  accounts: 'which accounts may spend, each with a headroom floor (**Accounts:** `id:min`)',
  mcp: 'the MCP servers, and what a phase does when one will not connect (**MCP policy:**)',
  gates: 'a Gate-check on every *(GATED)* heading, and whether human gates are delegated',
  'verification.person-check': 'allow, halt, or an owner when a §Verification line is prose (- **Person-check:**)',
  'qa.exhausted': 'waive, halt, or an owner when the QA rounds run out (**QA exhausted:**; skip when QA is off)',
  waits: 'each expected external wait, its --watch ref and its maximum (**Wait budget:**, - **Waits on:**)',
  'human-acts': 'steps denied to an agent, each with the ref that proves it landed (- **Human step:**)',
  ambiguity: 'ruling, ask or halt when the plan did not decide (**When in doubt:**)',
  budgets: 'run, phase and turn ceilings in dollars',
  'resume.on-restart': "continue, hold or ask — the RUN's answer when the console restarts under it",
  'plan-health': 'whether the advisory lints gate this plan',
  stop: 'autonomy, and who is told when the run halts',
  relay: 'off or last-resort, the 60-second default, who is paged',
  announce: 'which categories push, to whom, on which origin',
});

/** The recommended default the wizard names first for a manifest key, when one ships. */
export function manifestDefault(key: DecisionKey): string | undefined {
  return (POLICY_DEFAULTS as Readonly<Partial<Record<DecisionKey, string>>>)[key];
}

/** Every flag the two tables account for. */
export function accountedFlags(): Set<string> {
  return new Set([...PLAN_FIELDS.flatMap((f) => f.flags), ...Object.keys(STATE_FLAGS)]);
}

/** The manifest keys, in the order the wizard asks them. */
export const MANIFEST_ORDER: readonly DecisionKey[] = DECISION_KEYS;

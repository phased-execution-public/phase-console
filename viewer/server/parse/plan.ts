/**
 * Plan parser — `docs/plans/<slug>.md`.
 *
 * The dependency graph, `Size:` tags, GATED markers and the Session-budget
 * directives are parsed with **exactly** the rules `scripts/phase-graph.sh`
 * uses, because the console draws its route map from this parse while taking
 * every status claim from the engine. `test/engine-parity.test.ts` asserts the
 * two agree across every real plan; if you change a rule here, change it there
 * first and let the test prove it.
 */

import {
  parseFrontMatter, stripFrontMatter, fmString, fmNumber,
  type FrontMatter,
} from './frontmatter.ts';
import {
  sections, findSection, labelledBullets, bullet, tableAfter, plainCell,
  type Section,
} from './markdown.ts';
import { wantsDefaultCheckout, ISOLATION_DIRECTIVES } from '../../shared/worktree-model.js';
import {
  LAND_POLICIES, DEFAULT_LAND, GITLINK_POLICIES, DEFAULT_GITLINK,
  CONFLICT_POLICIES, DEFAULT_CONFLICT, DEFAULT_BASE_BRANCH,
} from '../../shared/landing-model.js';
import { MESSAGING_WORDS, DEFAULT_MESSAGING } from '../../shared/message-model.js';
import { ISSUE_MODES, DEFAULT_ISSUES } from '../../shared/issues-model.js';
import {
  CREDENTIAL_ID_RE, HUMAN_STEP_AUTO_OPEN, HUMAN_STEP_BULLET_KEYS, HUMAN_STEP_WHERE, KIND_META, dueRefOk, humanStepKindOf,
  type HumanStepKind, type HumanStepWhere,
} from '../../shared/human-step-model.js';
import { reasonAllowed, type WhyPerson } from '../../shared/turn-model.js';
import { parseDecisionsTable } from '../../shared/decisions-model.js';
import { inPlanReviewers, PERMISSION_MODES, withWindowNote } from '../../shared/run-settings.js';
import { MODEL_POLICIES, type ModelPolicy } from '../../shared/run-lifecycle.js';
import type { DecisionRow } from '../../shared/decisions-model.js';
import type { McpPolicy } from '../runner/state.ts';

/**
 * The 5.1.0 directive types, DERIVED from the imported vocabularies rather
 * than re-declared: `LAND_POLICIES` is the owner, so a word added there is a
 * word this parser accepts on the same commit, with no second list to forget.
 */
type LandPolicy = (typeof LAND_POLICIES)[number];
type GitlinkPolicy = (typeof GITLINK_POLICIES)[number];
type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];
type IssueMode = (typeof ISSUE_MODES)[number];
type IsolationDirective = (typeof ISOLATION_DIRECTIVES)[number];
/** A CLI `--permission-mode` word a plan may name (control-tower phase 11). */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * `**Credential policy:**` — the SAME vocabulary as `McpPolicy`
 * (`MCP_POLICIES`, `shared/run-lifecycle.js`) and the same three states;
 * silence is the console's to answer. An alias, never a second spelling.
 */
export type CredentialPolicy = McpPolicy;

/** One `id:minHeadroom` pair off the `**Accounts:**` line; `minHeadroom` absent when unstated. */
export type AccountClause = { id: string; minHeadroom?: number };

export type PhaseRow = {
  phase: number;
  title: string;
  dependsOn: number[];
  parallelSafe: string;
  repos: string;
  exitCriteria: string;
};

export type PhaseSize = 'S' | 'M' | 'L';

export type PhaseDetail = {
  phase: number;
  /** Heading title, `### Phase 4 — Payment` → `Payment`. */
  title: string;
  gated: boolean;
  gates?: string;
  gateCheck?: string;
  size: PhaseSize;
  model?: string;
  /** `**Effort:**` — the reasoning level this phase is worth running at. */
  effort?: string;
  goal?: string;
  readFirst?: string;
  files?: string;
  steps?: string;
  exitCriteria?: string;
  verification?: string;
  /**
   * `- **Setup:**` — bring-up run BEFORE the verification commands and never
   * part of the verdict (`runner/verify.ts` `runSetup`).
   *
   * Already UNIONED with the plan-wide `**Setup (every phase):**` line, plan
   * first, because that is the order bring-up happens in: the shared stack,
   * then whatever this phase alone needs. A reader wanting the phase's own
   * words has the `bullets` map; this field is what actually runs.
   *
   * The bullet exists because 19 plans put `docker compose up -d` and
   * `sleep 8` inside §Verification for want of anywhere else, where each one
   * is a command a person is asked to vouch for at boarding and a line that
   * can turn a phase red for a reason unrelated to its work (register R27).
   */
  setup?: string;
  /**
   * 5.1.0 — this phase's own half of the landing and isolation directives,
   * resolved against the plan's by `landFor` / `gitlinkFor` / `isolationFor` /
   * `issuesFor`. Absent means the bullet is missing OR says something that is
   * not one of its words: the reader falls through and lint F27 names it.
   */
  land?: LandPolicy;
  gitlink?: GitlinkPolicy;
  isolation?: IsolationDirective;
  issues?: IssueMode;
  /**
   * `- **Permission mode:** plan` — the mode this phase's session starts in,
   * OVERRIDING the plan's `**Permission mode:**` line (`permissionModeFor`).
   * Absent means the bullet is missing or names no mode: the reader falls
   * through, and lint F31 names the typo.
   */
  permissionMode?: PermissionMode;
  /**
   * `- **Model policy:** pinned|ladder` — what a run may do to this phase's
   * model (control-tower phase 54, #91), OVERRIDING the plan's line
   * (`modelPolicyFor`). Absent: the bullet is missing or names no policy.
   */
  modelPolicy?: ModelPolicy;
  /**
   * `**QA:** on|off` — this phase's OWN QA regime, overriding the plan's
   * `**QA gate:**` where it is stated, inheriting where it is silent.
   *
   * Read here so a caller can tell "this phase said something" from "this phase
   * inherited", without an engine round trip per phase. The engine remains the
   * authority on the resolved answer (`--qa-mode <phase>`); this only says
   * whether asking it per phase can differ from asking it per plan.
   *
   * Bold is REQUIRED, matching `qa_phase_directive`'s `\*\*QA:?\*\*` — unlike
   * the MCP bullets, whose bash readers make the asterisks optional. Anything
   * that is not exactly `on` or `off` is silence: a typo must inherit, never
   * guess.
   */
  qa?: 'on' | 'off';
  /**
   * `**Verify in:**` — the directory the verification commands mean, relative
   * to the repository root.
   *
   * Verification runs `bash -c` with the cwd the console was opened on. In a
   * monorepo that is the superproject, so a plan whose phase lives in one
   * submodule had its suite run against the whole tree — and a real plan's
   * `docker compose run … -v "$PWD:/app"` mounted the entire monorepo into the
   * container and hung. The plan already knows which directory it means; until
   * now there was no way for it to say so.
   */
  verifyIn?: string;
  /**
   * `**Checkout:**` — which branch this phase's session works ON.
   *
   * One value the console acts on: the DEFAULT branch (`main`, `master`, or
   * the literal word `default`). It means *do not stand this phase on the run
   * branch* — board it in a checkout DETACHED at the default branch's head.
   * That is what a phase after the run's pull request has merged needs: the
   * branch it would have stood on has been deleted, and re-creating it would
   * re-open work the merge just closed. A detached checkout owns no ref, so
   * any number of them may stand beside each other and beside whoever holds
   * the branch — which is what "two plans on one repository" asks for.
   *
   * Every other value is carried verbatim and acted on by nobody: a plan may
   * document which branch it means without the console inferring a mechanism.
   */
  checkout?: string;
  /**
   * `- **Wall-clock floor:** <duration>` — this phase's FIXED wall-clock
   * floor: a full `gates.sh` run, a CD wait — the least time it can take, no
   * matter how small its `Size` tag (`Size` weights CONTEXT for the ladder;
   * this is a clock).
   *
   * In MINUTES, rounded UP (`wallClockFloorMinutes`): one or more LEADING
   * `<number><unit>` groups, summed. Undefined when the bullet is missing, its
   * value has no leading duration, or that duration rounds to zero minutes —
   * all three are silence, meaning "this phase has no floor".
   */
  wallClockFloorMin?: number;
  /**
   * `- **Verify timeout:** <duration>` — how long ONE of this phase's
   * §Verification commands may run before the console cuts it, in minutes
   * (control-tower phase 83, #95; `verify_timeout_for_phase()`). The FIRST
   * duration after the label, like `Waits on:`'s max; it overrides the plan's
   * `**Verify timeout:**` for this phase (`verifyTimeoutFor`). Undefined when
   * the bullet is missing or names no duration.
   */
  verifyTimeoutMinutes?: number;
  /**
   * `**MCP:**` — the MCP servers this phase needs, as registry ids.
   *
   * What a phase states is WHICH server it needs, never how to reach it: the
   * how is per-machine and belongs to the console's registry, so a plan naming
   * `github` works on any machine that has one registered and says so honestly
   * on one that does not (F15 at plan time, the preflight at boarding).
   */
  mcpServers?: string[];
  /**
   * `**MCP policy:**` — what THIS phase does when one of those will not connect.
   *
   * Absent means the phase has no opinion and the plan's own line answers;
   * absent at both levels means the run's setting does. Only the exact word
   * `require` parks — see `mcpPolicyOf`.
   */
  mcpPolicy?: McpPolicy;
  /**
   * `- **Credentials:** \`x\`` — credential ids this phase needs beyond the
   * plan's line; UNIONED like `mcpServers` (`credentialsFor`). Absent when
   * the bullet is missing or names nothing.
   */
  credentials?: string[];
  /** `- **Credential policy:** require|continue` — overrides the plan's, like `mcpPolicy`. */
  credentialPolicy?: CredentialPolicy;
  /**
   * `- **Waits on:** <ref>[, <ref>…] · <max>` — what this phase waits on and,
   * after the `·`, how long it may stay parked in total; the max overrides the
   * plan's `**Wait budget:**` for this phase (`waitBudgetFor`), and a `date:`
   * ref is the plan countersigning a wait up to that instant. Absent when the
   * bullet is missing.
   */
  waitsOn?: { refs: string[]; maxMinutes?: number };
  /**
   * `- **Wait count:** <n>` — how many waits this phase may DECLARE, 1..99
   * (control-tower phase 121, #40; `wait_count_for_phase()`). Overrides the
   * plan's `**Wait count:**`; absent is silence (the console's own four).
   */
  waitCount?: number;
  /**
   * `- **Person-check:** allow|halt|<owner>` — what to do with a §Verification
   * fragment written as prose (`person_check_for_phase()`; chapter 10 ZTD-6,
   * the `verification.person-check` row). One lower-cased word; absent is
   * silence and the console's policy table answers (`personCheckFor`).
   */
  personCheck?: string;
  /**
   * `- **Human step:** <kind> · <what> · open: … · proof: … · where: … ·
   * window: … [· auto-open: host] [· credential: <id>]` — the acts only a
   * person can do that this phase declares (control-tower phase 41,
   * `human_steps_for_phase()`). Several bullets are several steps; one the
   * lint refuses (F37) is not a step. Absent when the phase declares none.
   */
  humanSteps?: HumanStepDirective[];
  handoffMustRecord?: string;
  /** Every labelled bullet, so nothing in an unusual plan is dropped. */
  bullets: { label: string; body: string }[];
  raw: string;
};

export type SessionBudget = {
  raw: string;
  targetModel?: string;
  budget?: string;
  branch?: string;
  skills: string[];
  /** `**MCP servers (every session):**` — attached to every phase of this plan. */
  mcpServers: string[];
  /**
   * `**Setup (every phase):**` — bring-up prepended to EVERY phase's own
   * `- **Setup:**` bullet.
   *
   * Raw text rather than a parsed list, because the extractor that will run it
   * (`verify.ts` `extractCommands`) is the same one §Verification uses and it
   * reads backticked spans and fenced blocks out of prose. Parsing here would
   * mean two extractors and, eventually, two answers.
   */
  setup?: string;
  /**
   * `**MCP policy:**` — the plan's answer for every phase that has no answer of
   * its own. Absent means the plan has no opinion, which is not the same as
   * saying `continue`: the console's resolution lets the RUN's setting speak
   * when the plan is silent, and lets the plan win when it is not.
   */
  mcpPolicy?: McpPolicy;
  /**
   * `**Credentials:**` — backticked credential ids every phase needs, probed
   * by the console's registry of named credential probes before a phase
   * boards (chapter 10 ZTD-4; the `MCP servers` shape). Empty when none.
   */
  credentials: string[];
  /** `**Credential policy:**` — `require` refuses at boarding, `continue` runs and reports; absent is silence. */
  credentialPolicy?: CredentialPolicy;
  /**
   * `**Accounts:**` — which Claude accounts a run may spend, in order, each
   * with the minimum five-hour headroom (percent) it must show before a phase
   * boards (chapter 13 §1.1 `accounts`). Empty when none.
   */
  accounts: AccountClause[];
  /**
   * `**Wait budget:**` — the total wall-clock ONE phase may spend parked across
   * its declared waits, in minutes (`plan_wait_budget()`). Absent is silence:
   * the console's own default applies (`DEFAULT_WAIT_BUDGET_MS`).
   */
  waitBudgetMinutes?: number;
  /**
   * `**Wait count:**` — how many waits each phase may DECLARE, 1..99
   * (control-tower phase 121, #40; `plan_wait_count()`). A phase's own bullet
   * overrides it; absent is silence, and the console's own four apply.
   */
  waitCount?: number;
  /**
   * `**Verify timeout:**` — how long one §Verification command of any phase may
   * run, in minutes (control-tower phase 83, #95; `plan_verify_timeout()`). A
   * phase's own bullet overrides it. Absent is silence: the console scales the
   * limit from each line's measured history (`verify-ledger.ts`).
   */
  verifyTimeoutMinutes?: number;
  /**
   * `**QA exhausted:** waive|halt|<owner>` — the plan's answer once the QA
   * round budget is spent (`plan_qa_exhausted()`; chapter 10 ZTD-9, the
   * `qa.exhausted` row). One lower-cased word; absent is silence and the
   * console's policy table answers.
   */
  qaExhausted?: string;
  /** Literal plan directive, if present: `on` | `off`. */
  qaGate?: 'on' | 'off';
  /**
   * `**Worktrees:**` — whether this plan's disjoint lanes each get their own
   * git worktree instead of sharing the run's checkout.
   *
   * Absent means OFF, and the default is stated in exactly one place
   * (`optedIn`, `server/runner/worktree.ts`). It is a PLAN directive rather
   * than a run setting because whether two lanes may safely hold two checkouts
   * of the same repository is a property of the work, not of an operator's
   * mood on a given afternoon.
   */
  worktrees?: 'on' | 'off';
  /**
   * Where the plan's phases land and where they run (5.1.0). Each is the
   * plan-wide half of a directive a phase may also carry; `landFor` and its
   * siblings below resolve the pair and say WHICH level answered, because
   * "this plan chose hold" and "this plan never considered landing" are two
   * facts and the console treats them differently.
   *
   * Absent means the line is missing OR says something that is not one of its
   * words — the same fall-through `mcpPolicy` takes, with lint F27 naming it.
   */
  landing?: LandPolicy;
  /** `**Base branch:**` — a word (`origin/HEAD`, `head`) or any git ref, verbatim. */
  baseBranch?: string;
  gitlink?: GitlinkPolicy;
  conflictPolicy?: ConflictPolicy;
  messaging?: 'on' | 'off';
  issues?: IssueMode;
  isolation?: IsolationDirective;
  /** `**Permission mode:**` — the plan's mode for every phase with no bullet of its own. */
  permissionMode?: PermissionMode;
  /** `**Model policy:**` — what a run may do to a model, for every phase with no bullet of its own (#91). */
  modelPolicy?: ModelPolicy;
  /** `**Clash zones:**` — paths two concurrent phases must never both touch. Empty when none. */
  clashZones: string[];
};

/** Which level of the plan answered a directive — the source token the engine prints. */
export type DirectiveSource = 'phase' | 'plan' | 'default';

/** A resolved directive: the word, and which level said it. */
export type Resolved<T extends string> = { value: T; source: DirectiveSource };

export type Plan = {
  slug: string;
  path: string;
  /** True when a `## Phase graph` table parsed — otherwise this is a document. */
  phased: boolean;
  frontMatter: FrontMatter;
  status?: string;
  /** Date the plan was closed (`close-plan.sh`), when its status is terminal. */
  closed?: string;
  /** Operator's reason for closing, one line. */
  closedReason?: string;
  created?: string;
  declaredPhases?: number;
  memoryKey: string;
  title: string;
  provenance?: string;
  sections: Section[];
  context?: string;
  architecture?: string;
  endToEnd?: string;
  sessionBudget: SessionBudget;
  /**
   * The `## Decisions` manifest (chapter 13 §1.1): one row per decision key,
   * as written in the PLAN. The mutable twin (`docs/handoffs/<slug>/
   * decisions.md`) is read by the store and merged over these rows with
   * `mergeDecisions`; the engine's `--decisions` prints that merge, and
   * `engine-parity` holds the two together. Empty when the plan has none.
   */
  decisions: DecisionRow[];
  graph: PhaseRow[];
  /** Blocking / Independent callout lines under the graph table. */
  callouts: string[];
  /**
   * Where the plan orders its own in-session reviewer (`inPlanReviewers`) — what
   * the launch form advises from when `reviewEachPhase` would double it.
   */
  reviewers: { section: string; excerpt: string }[];
  phases: Record<number, PhaseDetail>;
  /**
   * The plan's OWN acts (control-tower phase 121): `- **Human step:**` bullets
   * under `## Operator errands`, which no phase owns — `--human-steps 0`.
   * Absent when the section declares none.
   */
  operatorErrands?: HumanStepDirective[];
  body: string;
};

/** En/em dashes → ASCII, so range tokens and the `—` no-deps marker both parse. */
function dashNormalise(text: string): string {
  return text.replace(/[–—]/g, '-');
}

/** `1-7 (+8-10)` → `[1..7, 8..10]`; `—` → `[]` (engine rule, verbatim). */
export function parseDependsOn(cell: string): number[] {
  const raw = dashNormalise(cell).replace(/[^0-9-]+/g, ' ');
  const out: number[] = [];
  for (const token of raw.split(/\s+/)) {
    if (!token) continue;
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      for (let i = from; i <= to; i++) out.push(i);
      continue;
    }
    if (/^\d+$/.test(token)) out.push(Number(token));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Column positions when the table has NO header row at all — the same fallback
 * `_table_scan` uses (`ti=3, di=4, ri=6` in awk's 1-based fields, which are
 * these once the leading pipe is stripped).
 */
const FALLBACK_COLUMNS = { title: 1, dependsOn: 2, parallelSafe: 3, repos: 4, exitCriteria: 5 };

type Columns = Partial<Record<keyof typeof FALLBACK_COLUMNS, number>>;

/**
 * Map the phase table's columns by HEADER NAME, exactly as `_table_scan` does.
 *
 * Reading them by position was a ship-breaker on the bash side (engine-1) and
 * Phase 2 fixed it there; this half was left reading position 4 for Repos and
 * position 5 for Exit criteria. So a plan that drops the decorative
 * `Parallel-safe with` column — a perfectly valid five-column table the engine
 * scopes correctly — had every phase's SCOPE read out of its exit-criteria
 * text here: `scope "tests,pass"` where the engine says `api`. Scope is what
 * decides whether two sessions may run at once, so the console would have
 * admitted a lane onto a working tree the engine had already refused.
 *
 * An unmatched column reads EMPTY rather than falling back to a position: a
 * table with no Repos column says nothing about scope, and inventing one from
 * whatever sits at index 4 is how the original bug did its damage. Only a table
 * with no header at all uses the positional fallback.
 */
function mapColumns(header: string[] | undefined): Columns {
  if (!header) return { ...FALLBACK_COLUMNS };
  const found: Columns = {};
  header.forEach((cell, i) => {
    const name = plainCell(cell).toLowerCase().trim();
    if (found.dependsOn === undefined && /depends/.test(name)) found.dependsOn = i;
    else if (found.repos === undefined && /^repos/.test(name)) found.repos = i;
    else if (found.title === undefined && /^title/.test(name)) found.title = i;
    else if (found.parallelSafe === undefined && /parallel/.test(name)) found.parallelSafe = i;
    else if (found.exitCriteria === undefined && /exit/.test(name)) found.exitCriteria = i;
  });
  // The fallbacks are PER COLUMN, not all-or-nothing — `_table_scan` ends its
  // header scan with `if (di == 0) di = -1; if (ri == 0) ri = -1; if (ti == 0)
  // ti = 3`. Deps and Repos read EMPTY when unnamed, because inventing a
  // dependency or a scope is the damage. A TITLE is only a label, and two live
  // hub plans head their table `| # | Phase | Depends on | … |` — the phase
  // NUMBER under `#` and the title under `Phase`, so nothing matches /^title/
  // and the engine still reads the title from the second cell. Blanking it
  // here would have renamed every phase of those plans to nothing.
  if (found.title === undefined) found.title = FALLBACK_COLUMNS.title;
  return found;
}

function parseGraph(text: string): PhaseRow[] {
  const rows = tableAfter(dashNormalise(text), (t) => /^phase graph/i.test(t));
  const isPhaseRow = (cells: string[]) => /^\d+$/.test(plainCell(cells[0] ?? ''));
  // "The first pipe row that is not a phase row is the header" — `_table_scan`'s
  // rule, verbatim, separator row included. Excluding `|---|` here looked
  // tidier and was a divergence: on a table that opens with a separator and no
  // header, the engine maps that row (matching nothing, so deps and repos read
  // empty) while a separator-skipping reader would find no header at all and
  // fall back to POSITION — inventing exactly the scope this whole change
  // exists to stop inventing.
  const headerRow = rows.find((r) => !isPhaseRow(r.cells));
  const columns = mapColumns(headerRow?.cells);
  const at = (cells: string[], key: keyof typeof FALLBACK_COLUMNS): string => {
    const index = columns[key];
    return index === undefined ? '' : cells[index] ?? '';
  };

  const out: PhaseRow[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (!isPhaseRow(row.cells)) continue;         // header, separator and prose rows
    const phase = Number(plainCell(row.cells[0] ?? ''));
    // The FIRST row of a duplicated phase wins, matching the engine's load
    // loop — a repeated row used to appear twice here and once there.
    if (seen.has(phase)) continue;
    seen.add(phase);
    out.push({
      phase,
      title: plainCell(at(row.cells, 'title')),
      dependsOn: parseDependsOn(at(row.cells, 'dependsOn')),
      parallelSafe: plainCell(at(row.cells, 'parallelSafe')),
      repos: plainCell(at(row.cells, 'repos')),
      exitCriteria: at(row.cells, 'exitCriteria').trim(),
    });
  }
  return out;
}

/** `### Phase N …` block, ending at the next `### Phase` or any `## ` heading. */
function phaseBlocks(text: string): Map<number, { title: string; raw: string; headingLine: string }> {
  const lines = text.split('\n');
  const out = new Map<number, { title: string; raw: string; headingLine: string }>();
  let current: { phase: number; title: string; heading: string; buf: string[] } | null = null;

  const flush = () => {
    if (current) out.set(current.phase, { title: current.title, raw: current.buf.join('\n').trim(), headingLine: current.heading });
    current = null;
  };

  for (const line of lines) {
    const heading = /^###\s+[Pp]hase\s+(\d+)\s*(?:[—–-]\s*)?(.*)$/.exec(line);
    if (heading) {
      flush();
      // Some plans collapse finished work under one heading — `### Phase 1–5 —
      // DONE`. The engine files that block under the first number; the leftover
      // text is not a title, so fall back to the graph row's.
      const isRange = /^\d+\s*[—–-]/.test(heading[2]);
      current = {
        phase: Number(heading[1]),
        title: isRange ? '' : heading[2].replace(/\*\(GATED\)\*/i, '').trim(),
        heading: line,
        buf: [],
      };
      continue;
    }
    if (/^##\s/.test(line)) { flush(); continue; }
    if (current) current.buf.push(line);
  }
  flush();
  return out;
}

/**
 * Engine rule: uppercase `GATED` on the `### Phase N` heading, or in that
 * phase's graph row. Case-sensitive on purpose — matching loosely also fires on
 * prose like "born-gated", which would freeze a ready phase behind a gate the
 * plan never declared.
 */
function isGated(text: string, phase: number, heading: string): boolean {
  if (new RegExp(`^### Phase ${phase}(?![\\w])`).test(heading) && heading.includes('GATED')) return true;
  const rowRe = new RegExp(`^\\|\\s*${phase}\\s*\\|.*GATED`, 'm');
  return rowRe.test(text);
}

/**
 * Engine rule: the first `**Size:**` bullet inside the phase's OWN block.
 *
 * Mirrors `phase_size` in `scripts/phase-graph.sh` — deliberately, and the
 * engine-parity test is what keeps the two honest. Both used to read a fixed
 * eight-line window from the heading, which is neither scoped to the phase nor
 * long enough: a phase whose Size bullet sits under a reconciliation blockquote
 * silently fell back to M (two live plan phases did), and a phase with no Size
 * bullet at all read its NEIGHBOUR's.
 *
 * The bullet match is `**Size:**` rather than `.*size`, for the same reason on
 * both sides: the loose one also fires on prose carrying "resize" or "sizes".
 */
function phaseSize(text: string, phase: number): PhaseSize {
  const lines = text.split('\n');
  const headingRe = new RegExp(`^### Phase ${phase}(?![\\w])`);
  const anyPhaseRe = /^###\s+[Pp]hase\s+[0-9]+/;
  const sectionRe = /^##\s/;
  const bulletRe = /^\s*[-*]\s*\*{0,2}Size\*{0,2}\s*:/i;
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (anyPhaseRe.test(line) || sectionRe.test(line)) break;  // the block ends
      if (!bulletRe.test(line)) continue;
      // The LAST `size` on the line, not the first — `.*` is greedy on both
      // sides. `phase_size` reads the letter with
      // `sed -E 's/.*[Ss]ize[^A-Za-z]*([A-Za-z]).*/\1/'`, whose leading `.*`
      // anchors the match on the final occurrence; a non-anchored regex here
      // took the first. They agree on every ordinary bullet and diverge the
      // moment one says the word twice: on `- **Size:** L (sized against opus)`
      // the engine reads `d` (from "sized", so: not S/M/L, so M) while this read
      // `L`. Same plan, two boards, and the console offering a batch the engine
      // would size differently.
      const m = /.*size[^A-Za-z]*([A-Za-z])/i.exec(line);
      const letter = m?.[1]?.toUpperCase();
      if (letter === 'S' || letter === 'M' || letter === 'L') return letter;
      return 'M';
    }
  }
  return 'M';
}

function firstBulletValue(block: string, pattern: RegExp): string | undefined {
  for (const line of block.split('\n')) {
    if (!/^\s*[-*]/.test(line)) continue;
    const m = pattern.exec(line);
    if (m) return m[1].replace(/[*`]/g, '').trim();
  }
  return undefined;
}

function parseSessionBudget(section?: Section): SessionBudget {
  const raw = section?.body ?? '';
  const flat = raw.replace(/^[\s>]*/gm, '');

  // A "(1M window)" after the name is the window the plan asked for, and reads
  // as `[1m]` (control-tower phase 13, #91) — the bash twin is `plan_model`.
  const target = /\*\*Target model:\*\*\s*`?([^`·\n(]+)`?/i.exec(flat);
  const named = target?.[1]?.trim();
  const model = named && target ? withWindowNote(named, flat.slice(target.index + target[0].length)) : named;
  const budget = /\*\*Budget:\*\*\s*([^·\n]+)/i.exec(flat)?.[1]?.trim();
  const branch = /\*\*Branch:\*\*\s*([^·\n]+)/i.exec(flat)?.[1]?.trim();

  // The PHRASE decides, and the bold markers are decoration.
  //
  // `plan_skills()` and `plan_mcp()` match on the phrase alone
  // (`grep -i 'skills (every session)'`), so a budget written
  // `Skills (every session): \`tdd\`` — or with the bold wrapped around the
  // whole line rather than the label — is read by the engine and injected into
  // every boot prompt, while this side saw nothing and the QA brief omitted the
  // skills the engine's own brief named. Strictness about the PHRASE is what
  // stops a loose `mcp` match swallowing backticked tokens out of unrelated
  // budget prose; strictness about the asterisks bought nothing and cost that.
  const skillsLine = /(?:\*\*)?Skills \(every session\):?(?:\*\*)?\s*(.+)/i.exec(flat)?.[1] ?? '';
  const skills = [...skillsLine.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());

  // Same phrase-decides rule as `Skills (every session)` above, and the same
  // `(.+)` terminator — `flat` keeps its newlines, so this is one line.
  const setupLine = /(?:\*\*)?Setup \(every phase\):?(?:\*\*)?\s*(.+)/i.exec(flat)?.[1]?.trim();

  const mcpLine = /(?:\*\*)?MCP servers \(every session\):?(?:\*\*)?\s*(.+)/i.exec(flat)?.[1] ?? '';
  const mcpServers = [...mcpLine.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  // `plan_mcp_policy()` is looser still — `grep -i 'mcp policy'`, then strip
  // everything through the first colon — so bold is optional here too.
  const mcpPolicy = mcpPolicyOf(/(?:\*\*)?MCP policy(?:\*\*)?[^:\n]*:\s*(.+)/i.exec(flat)?.[1]);

  // `plan_credentials()` / `plan_accounts()`: the label at the START of a line
  // (the engine greps `^[[:space:]>]*\*{0,2}credentials\*{0,2}[[:space:]]*:`),
  // so a sentence that merely mentions credentials cannot become a list; then
  // the same backtick harvest as MCP servers. `plan_credential_policy()` is
  // the loose `grep -i 'credential policy'` of its MCP twin.
  const credentialsLine = /^\*{0,2}Credentials\*{0,2}\s*:\s*(.+)/im.exec(flat)?.[1] ?? '';
  const credentials = [...new Set([...credentialsLine.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean))];
  const credentialPolicy = credentialPolicyOf(/(?:\*\*)?Credential policy(?:\*\*)?[^:\n]*:\s*(.+)/i.exec(flat)?.[1]);
  const accountsLine = /^\*{0,2}Accounts\*{0,2}\s*:\s*(.+)/im.exec(flat)?.[1] ?? '';
  const accounts = [...accountsLine.matchAll(/`([^`]+)`/g)].map((m) => accountClauseOf(m[1])).filter((a): a is AccountClause => a !== undefined);
  // `plan_wait_budget()`: the label at the start of a line, then the FIRST
  // duration after the colon.
  const waitBudgetMinutes = durationMinutes(/^\*{0,2}Wait[ \t]+budget\*{0,2}[ \t]*:\s*(.+)/im.exec(flat)?.[1]);
  // `plan_wait_count()`: the same label shape, then the first whole number.
  const waitCount = countWord(/^\*{0,2}Wait[ \t]+count\*{0,2}[ \t]*:\s*(.+)/im.exec(flat)?.[1]);
  // `plan_verify_timeout()`: the same shape as the wait budget above.
  const verifyTimeoutMinutes = durationMinutes(/^\*{0,2}Verify[ \t]+timeout\*{0,2}[ \t]*:\s*(.+)/im.exec(flat)?.[1]);
  // `plan_qa_exhausted()`: the label at the start of a line (after the quote
  // marks), then the FIRST word after the colon.
  const qaExhausted = policyWord(/^\*{0,2}QA[ \t]+exhausted\*{0,2}[ \t]*:\s*(.+)/im.exec(flat)?.[1]);

  // Ported verbatim from `qa_mode()`, whose own regex carries a comment naming
  // the bug it fixed: the optional `- `/`* ` bullet prefix, because
  // `- **QA gate:** off` — a perfectly ordinary way to write it — missed BOTH
  // rules and read as QA-on. The terminator is a space-or-end rather than
  // end-of-line, so a trailing note after the word still counts.
  let qaGate: 'on' | 'off' | undefined;
  for (const line of raw.split('\n')) {
    const m = /^[\s>]*(?:[-*]\s+)?\*{0,2}QA gate:?\*{0,2}\s*(on|off)(?:\s|$)/i.exec(line);
    if (m) { qaGate = m[1].toLowerCase() as 'on' | 'off'; break; }
  }

  // Same shape as `QA gate`, and for the same reason: the bullet prefix and the
  // bold markers are both optional, because `- **Worktrees:** on` is how a
  // person actually writes it and a rule that missed it would read as OFF —
  // which is the safe direction here, but silently ignoring a directive an
  // operator DID write is not a safety property, it is a bug that looks like
  // one.
  let worktrees: 'on' | 'off' | undefined;
  for (const line of raw.split('\n')) {
    const m = /^[\s>]*(?:[-*]\s+)?\*{0,2}Worktrees:?\*{0,2}\s*(on|off)(?:\s|$)/i.exec(line);
    if (m) { worktrees = m[1].toLowerCase() as 'on' | 'off'; break; }
  }

  // 5.1.0's plan-wide directives (`_plan_directive` in phase-graph.sh): the
  // label at the START of a line after any quote marks, then the first word
  // after the first colon, checked against its vocabulary. An unrecognised
  // word is `undefined` — the reader falls THROUGH it, and lint F27 is what
  // says so, exactly as `mcpPolicyOf` does with a typo'd policy.
  const landing = planWord(flat, 'Landing', LAND_POLICIES);
  const gitlink = planWord(flat, 'Gitlink', GITLINK_POLICIES);
  const conflictPolicy = planWord(flat, 'Conflicts', CONFLICT_POLICIES);
  const messaging = planWord(flat, 'Messaging', MESSAGING_WORDS);
  const issues = planWord(flat, 'Issues', ISSUE_MODES);
  const isolation = planWord(flat, 'Isolation', ISOLATION_DIRECTIVES);
  const permissionMode = permissionModeWord(
    new RegExp(`^[\\s>]*\\*{0,2}${PERMISSION_MODE_LABEL}\\*{0,2}[ \\t]*:(.*)$`, 'im').exec(flat)?.[1],
  );
  // control-tower phase 54 (#91): `_plan_directive 'Model[[:space:]]+policy'`.
  const modelPolicy = planWord(flat, MODEL_POLICY_LABEL, MODEL_POLICIES);
  // The base branch is the one value that is not a vocabulary — two words are
  // special and everything else is a git ref, passed through whole — so it
  // takes the raw remainder rather than its first token.
  const baseBranch = /^[\s>]*\*{0,2}Base branch\*{0,2}[ \t]*:(.*)$/im.exec(flat)?.[1]
    ?.replace(/[*`]/g, '').trim() || undefined;
  const clashZonesLine = /^[\s>]*\*{0,2}Clash zones\*{0,2}[ \t]*:(.*)$/im.exec(flat)?.[1] ?? '';
  const clashZones = [...new Set(
    [...clashZonesLine.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean),
  )];

  return {
    raw, targetModel: model, budget, branch, skills, mcpServers, mcpPolicy, credentials, credentialPolicy, accounts, qaGate, worktrees,
    clashZones,
    ...(setupLine ? { setup: setupLine } : {}),
    ...(waitBudgetMinutes !== undefined ? { waitBudgetMinutes } : {}),
    ...(waitCount !== undefined ? { waitCount } : {}),
    ...(verifyTimeoutMinutes !== undefined ? { verifyTimeoutMinutes } : {}),
    ...(qaExhausted !== undefined ? { qaExhausted } : {}),
    ...(landing !== undefined ? { landing } : {}),
    ...(baseBranch !== undefined ? { baseBranch } : {}),
    ...(gitlink !== undefined ? { gitlink } : {}),
    ...(conflictPolicy !== undefined ? { conflictPolicy } : {}),
    ...(messaging !== undefined ? { messaging } : {}),
    ...(issues !== undefined ? { issues } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(modelPolicy !== undefined ? { modelPolicy } : {}),
  };
}

/**
 * One plan-wide directive, as its first word, or undefined when the line is
 * missing or says something that is not one of `words`.
 *
 * `_plan_directive | _first_word` plus the membership test `_resolve_directive`
 * applies — the two are one step here because nothing needs the raw value of a
 * closed directive, and keeping them apart invited a reader that took the word
 * without checking it.
 */
function planWord<T extends string>(flat: string, label: string, words: readonly T[]): T | undefined {
  const re = new RegExp(`^[\\s>]*\\*{0,2}${label}\\*{0,2}[ \\t]*:(.*)$`, 'im');
  const word = policyWord(re.exec(flat)?.[1]);
  return words.includes(word as T) ? (word as T) : undefined;
}

/** `Permission[[:space:]]+mode` in phase-graph.sh — one space or several. */
const PERMISSION_MODE_LABEL = 'Permission[ \\t]+mode';

/** `Model[[:space:]]+policy` in phase-graph.sh (control-tower phase 54). */
const MODEL_POLICY_LABEL = 'Model[ \\t]+policy';

/**
 * A permission mode, matched case-insensitively and returned the way the CLI
 * spells it — `_permission_mode_word()`. `policyWord` lower-cases and the CLI's
 * modes are camelCase (`acceptEdits`, `dontAsk`), so a plain membership test
 * would refuse the one spelling the CLI accepts. Undefined = not a mode.
 */
function permissionModeWord(remainder: string | undefined): PermissionMode | undefined {
  const word = policyWord(remainder);
  return word === undefined ? undefined : PERMISSION_MODES.find((mode) => mode.toLowerCase() === word);
}

/**
 * The same, for a phase's own `- **Label:**` bullet — `_phase_directive |
 * _first_word` with `_resolve_directive`'s membership test.
 *
 * The bullet marker is required and the bold is not, which is the engine's
 * rule (`^[[:space:]]*[-*][[:space:]]*\*{0,2}Label\*{0,2}[[:space:]]*:`) and
 * not the stricter one `qaBullet` uses. The two differ deliberately and the
 * asymmetry is pinned in `viewer/test/parse.test.ts`.
 */
function phaseWord<T extends string>(block: string, label: string, words: readonly T[]): T | undefined {
  const re = new RegExp(`^[ \\t]*[-*][ \\t]*\\*{0,2}${label}\\*{0,2}[ \\t]*:(.*)$`, 'im');
  const word = policyWord(re.exec(block)?.[1]);
  return words.includes(word as T) ? (word as T) : undefined;
}

/**
 * `duration_minutes()` in phase-graph.sh: the FIRST `<n><unit>` in the text as
 * minutes (`45m`, `~45m`, `8h`, `2 days`, `90 min`), or undefined. Longest unit
 * first so the ordered alternation picks what awk's leftmost-longest does.
 */
export function durationMinutes(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /([0-9]+)[ \t\r\n\f\v]*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)(?:[^A-Za-z0-9_]|$)/i
    .exec(text.replace(/[`*]/g, ''));
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  const unit = m[2].toLowerCase();
  if (unit.startsWith('d')) return n * 1440;
  if (unit.startsWith('h')) return n * 60;
  return n;
}

/**
 * `wall_clock_floor_minutes()` in phase-graph.sh: a phase's `- **Wall-clock
 * floor:**` value as minutes, or undefined.
 *
 * Unlike `durationMinutes` above — the FIRST duration anywhere in the text,
 * single group, integers only — this reads one or more LEADING
 * `<number><unit>` groups (decimal numbers allowed, the space before a unit
 * and between groups both optional), sums them and rounds UP: `1h 30m` and
 * `1.5h` both read 90. Reading stops at the first token that is not such a
 * group — a lookahead rather than a trailing-boundary character class, so a
 * following DIGIT does not stop it (`1h30m` still reads two groups) while a
 * following LETTER does (`5 miles` is not `5 minutes`) — so trailing prose
 * (` — a full gates.sh run`) never reaches the sum. Undefined when nothing
 * leading is readable, or when the total rounds to zero minutes — both are
 * silence, meaning "no floor".
 */
export function wallClockFloorMinutes(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const re = /^([0-9]+(?:\.[0-9]+)?)[ \t]*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)(?![a-z])/i;
  let rest = text.replace(/[`*]/g, '');
  let total = 0;
  let matched = false;
  for (;;) {
    rest = rest.replace(/^[ \t]+/, '');
    const m = re.exec(rest);
    if (!m) break;
    matched = true;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith('d')) total += n * 1440;
    else if (unit.startsWith('h')) total += n * 60;
    else total += n;
    rest = rest.slice(m[0].length);
  }
  if (!matched || total <= 0) return undefined;
  return Math.ceil(total);
}

/** `plan_credential_policy()`'s word filter — the MCP policy filter, because it is the MCP policy vocabulary. */
function credentialPolicyOf(value?: string): CredentialPolicy | undefined {
  return mcpPolicyOf(value);
}

/**
 * One backticked `id:min` token → a clause. `plan_accounts()` splits on the
 * first colon, trims, strips a trailing `%` off the minimum and prints the id
 * with an EMPTY minimum when the pair carries none — read as `undefined` here.
 */
function accountClauseOf(token: string): AccountClause | undefined {
  const [rawId, ...rest] = token.split(':');
  const id = rawId.trim();
  if (!id) return undefined;
  const min = rest.join(':').trim().replace(/[\s%]+$/, '');
  if (!min) return { id };
  const n = Number(min);
  return Number.isFinite(n) ? { id, minHeadroom: n } : { id };
}

/**
 * Read an `**MCP policy:**` value, at either level.
 *
 * Three states, not two, and the third is load-bearing. Both words are
 * recognised, and anything else — a typo, a sentence — is `undefined`, meaning
 * "said nothing". An explicit `continue` on a phase is what lets it carve
 * itself out of a plan-wide `require`; silence is what lets the run's own
 * setting answer at all. Collapsing silence into `continue` would make a
 * run-level choice unreachable on every plan ever written, and collapsing it
 * into `require` would stop plans over a typo — so an unrecognised word falls
 * through, the same fail-safe direction `gitMode` takes.
 *
 * Mirrors `plan_mcp_policy` / `mcp_policy_directive` in `phase-graph.sh`;
 * `engine-parity` holds the two readings together.
 */
function mcpPolicyOf(value?: string): McpPolicy | undefined {
  const word = value?.replace(/[*`]/g, '').trim().toLowerCase().split(/\s+/)[0];
  return word === 'require' || word === 'continue' ? word : undefined;
}

/*
 * The two per-phase MCP bullets are read off the RAW block, not off
 * `labelledBullets`, because the engine does not require the bold.
 *
 * `mcp_directive` and `mcp_policy_directive` both match
 * `\*{0,2}MCP\*{0,2}[[:space:]]*:` — the asterisks are optional — while
 * `labelledBullets`' item regex requires a bold span to emit a label at all. So
 * a phase written `- MCP: \`playwright\`` was a server list to the engine and
 * invisible here, and it is THIS side the attach and preflight paths read: the
 * phase would have boarded without the server the plan says it needs, which is
 * the one failure the preflight exists to make cheap.
 *
 * Same regexes as bash, same first-match-wins (`head -1`).
 */
const MCP_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}MCP\*{0,2}[ \t]*:(.*)$/i;
const MCP_POLICY_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}MCP[ \t]+policy\*{0,2}[ \t]*:(.*)$/i;
/** `credentials_directive()` / `credential_policy_directive()` — the same shapes. */
const CREDENTIALS_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}Credentials\*{0,2}[ \t]*:(.*)$/i;
const CREDENTIAL_POLICY_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}Credential[ \t]+policy\*{0,2}[ \t]*:(.*)$/i;
/** `waits_on_directive()` — the label, then everything after its first colon. */
const WAITS_ON_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}Waits[ \t]+on\*{0,2}[ \t]*:(.*)$/i;
/** `person_check_for_phase()` — the same shape. */
const PERSON_CHECK_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}Person-check\*{0,2}[ \t]*:(.*)$/i;
/** `human_step_bodies()`: every `- **Human step:**` bullet, bold or not, the colon inside or outside it. */
const HUMAN_STEP_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}human[ \t]+step\*{0,2}[ \t]*:/i;
/** `wait_count_for_phase()` (control-tower phase 121) — the label, then everything after its first colon. */
const WAIT_COUNT_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}Wait[ \t]+count\*{0,2}[ \t]*:(.*)$/i;
/** `wall_clock_floor_directive()` — the same shape; bold optional, like `Checkout`. */
const WALL_CLOCK_FLOOR_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}Wall-clock[ \t]+floor\*{0,2}[ \t]*:(.*)$/i;
/** `verify_timeout_directive()` — the same shape again (control-tower phase 83, #95). */
const VERIFY_TIMEOUT_BULLET_RE = /^[ \t]*[-*][ \t]*\*{0,2}Verify[ \t]+timeout\*{0,2}[ \t]*:(.*)$/i;

/**
 * `_policy_word()`: bold and backticks stripped, the FIRST token lower-cased
 * with trailing punctuation dropped — `Halt.` reads `halt`, `**dev-lead** —
 * they know the UI` reads `dev-lead`. Undefined when the remainder is empty.
 */
function policyWord(remainder: string | undefined): string | undefined {
  if (remainder === undefined) return undefined;
  const first = remainder.replace(/[*`]/g, '').trim().split(/\s+/)[0] ?? '';
  const word = first.toLowerCase().replace(/[!-/:-@[-`{-~]+$/, '');
  return word || undefined;
}

/**
 * The plan-wide Setup line and the phase's own bullet, joined — or undefined.
 *
 * Plan first: bring-up is ordered, and the shared stack has to be up before a
 * phase's extra step against it can work. Newline-joined rather than
 * concatenated so the extractor sees two lines and cannot run the end of one
 * into the start of the other.
 */
function setupFor(planWide: string | undefined, own: string | undefined): string | undefined {
  const parts = [planWide?.trim(), own?.trim()].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('\n') : undefined;
}

/** The first line of `block` matching `re`, or undefined — bash's `head -1`. */
function firstMatch(block: string, re: RegExp): string | undefined {
  for (const line of block.split('\n')) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * The phase's `- **MCP:** \`a\`, \`b\`` ids, or undefined when it names none.
 *
 * The label is matched exactly (`MCP:`), never as a prefix, because the bash
 * side does: a hypothetical `- **MCP notes:**` bullet must not read as a server
 * list on one side and prose on the other.
 */
function mcpBullet(block: string): string[] | undefined {
  const body = firstMatch(block, MCP_BULLET_RE);
  if (body === undefined) return undefined;
  const ids = [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
  return ids.length ? [...new Set(ids)] : undefined;
}

/** The phase's `- **MCP policy:** require|continue`, or undefined for silence. */
function mcpPolicyBullet(block: string): McpPolicy | undefined {
  return mcpPolicyOf(firstMatch(block, MCP_POLICY_BULLET_RE));
}

/** The phase's `- **Credentials:** \`a\`, \`b\`` ids, or undefined when it names none — `mcpBullet`'s twin. */
function credentialsBullet(block: string): string[] | undefined {
  const body = firstMatch(block, CREDENTIALS_BULLET_RE);
  if (body === undefined) return undefined;
  const ids = [...body.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
  return ids.length ? [...new Set(ids)] : undefined;
}

/** The phase's `- **Credential policy:** require|continue`, or undefined for silence. */
function credentialPolicyBullet(block: string): CredentialPolicy | undefined {
  return credentialPolicyOf(firstMatch(block, CREDENTIAL_POLICY_BULLET_RE));
}

/**
 * `_count_word()`: bold and backticks stripped, the FIRST token a whole number
 * from 1 to 99 — anything else is silence, so the console's default stands.
 */
function countWord(remainder: string | undefined): number | undefined {
  if (remainder === undefined) return undefined;
  const match = /^\s*(\d+)(?![\dA-Za-z])/.exec(remainder.replace(/^\*+/, '').replace(/[*`]/g, ''));
  const n = match ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : undefined;
}

/** The phase's `- **Person-check:** allow|halt|<owner>`, or undefined for silence. */
function personCheckBullet(block: string): string | undefined {
  return policyWord(firstMatch(block, PERSON_CHECK_BULLET_RE));
}

/**
 * One `- **Human step:**` bullet — `_human_step_parse()` in phase-graph.sh,
 * field for field: the kind and what to do are positional, every later field is
 * `key: value` in any order (last wins), one wrapping pair of backticks is read
 * without them. Undefined for anything the F37 lint refuses — the superseded
 * `<who, what, proof ref>` spelling, an unknown kind, a field the grammar does
 * not have, a `where`/`auto-open`/`window` it cannot read, a `credential` off a
 * `secret-entry` step, or an `open:` link that is not http(s).
 */
export function parseHumanStepBody(body: string): HumanStepDirective | undefined {
  const fields = body.split(/\s*·\s*/).map((f) => f.trim());
  const kind = humanStepKindOf((fields[0] ?? '').replace(/[`*]/g, '').trim().split(/\s+/)[0]);
  if (!kind) return undefined;
  const what = fields[1] ?? '';
  if (!what) return undefined;
  const values: Record<string, string> = {};
  for (const field of fields.slice(2)) {
    const key = /^([A-Za-z][A-Za-z-]*)\s*:/.exec(field)?.[1]?.toLowerCase() ?? '';
    if (!(HUMAN_STEP_BULLET_KEYS as readonly string[]).includes(key)) return undefined;
    values[key] = field.replace(/^[^:]*:\s*/, '').replace(/^`(.*)`$/, '$1').trim();
  }
  const where = (values.where?.toLowerCase() || KIND_META[kind].where) as HumanStepWhere;
  if (!(HUMAN_STEP_WHERE as readonly string[]).includes(where)) return undefined;
  const autoOpen = values['auto-open']?.toLowerCase();
  if (autoOpen && !(HUMAN_STEP_AUTO_OPEN as readonly string[]).includes(autoOpen)) return undefined;
  let windowMinutes: number | undefined;
  if (values.window) {
    windowMinutes = durationMinutes(values.window);
    if (windowMinutes === undefined) return undefined;
  }
  const credential = values.credential;
  if (credential && (kind !== 'secret-entry' || !CREDENTIAL_ID_RE.test(credential))) return undefined;
  const open = values.open;
  if (open && /^[A-Za-z][A-Za-z0-9+.-]*:\S/.test(open) && !/^https?:\/\/[^\s/?#]+/i.test(open)) return undefined;
  // `due:` (control-tower phase 121) — a watch ref, by its scheme; the step is
  // `upcoming` until it lands.
  const due = values.due;
  if (due && !dueRefOk(due)) return undefined;
  // Your turn's four (control-tower phase 130) — `_human_step_parse`'s rules.
  const why = values.why?.toLowerCase();
  if (why && !reasonAllowed(kind, why)) return undefined;
  let effortMinutes: number | undefined;
  if (values.effort) {
    effortMinutes = durationMinutes(values.effort);
    if (effortMinutes === undefined) return undefined;
  }
  let unblocks: number[] | undefined;
  if (values.unblocks) {
    const list = values.unblocks.replace(/ /g, '');
    if (!/^0*[1-9][0-9]{0,4}(,0*[1-9][0-9]{0,4})*$/.test(list)) return undefined;
    unblocks = list.split(',').map(Number);
  }
  const guide = values.guide;
  if (guide && (/^\/|\.\.|\s/.test(guide) || !/^[A-Za-z0-9._/-]+\.md$/.test(guide))) return undefined;
  return {
    kind, what, where,
    ...(open ? { open } : {}),
    ...(values.proof ? { proof: values.proof } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(autoOpen ? { autoOpen: 'host' as const } : {}),
    ...(credential ? { credential } : {}),
    ...(due ? { due } : {}),
    ...(why ? { why: why as WhyPerson } : {}),
    ...(effortMinutes !== undefined ? { effortMinutes } : {}),
    ...(unblocks ? { unblocks } : {}),
    ...(guide ? { guide } : {}),
  };
}

/** The phase's well-formed `- **Human step:**` bullets, or undefined when it has none. */
function humanStepBullets(block: string): HumanStepDirective[] | undefined {
  const steps: HumanStepDirective[] = [];
  for (const line of block.split('\n')) {
    if (!HUMAN_STEP_BULLET_RE.test(line)) continue;
    const body = line.replace(/^[^:]*:\s*/, '').replace(/^\*{1,2}\s*/, '').replace(/\s+$/, '');
    const step = parseHumanStepBody(body);
    if (step) steps.push(step);
  }
  return steps.length ? steps : undefined;
}

/** The phase's `- **Wall-clock floor:** <duration>`, in minutes — or undefined for silence. */
function wallClockFloorBullet(block: string): number | undefined {
  return wallClockFloorMinutes(firstMatch(block, WALL_CLOCK_FLOOR_BULLET_RE));
}

/**
 * The phase's `- **Waits on:** …` — `waits_on_refs()` and `wait_budget_for_phase()`.
 * Refs are the backticked spans left of the `·` when there are any, else that
 * side split on commas; the max is the first duration right of the `·`.
 */
function waitsOnBullet(block: string): { refs: string[]; maxMinutes?: number } | undefined {
  const line = firstMatch(block, WAITS_ON_BULLET_RE);
  if (line === undefined) return undefined;
  // The engine strips through the FIRST colon of the whole line and then a
  // leading `**`: the label's own closing bold, when the colon sat inside it.
  const body = line.replace(/^[ \t]*/, '').replace(/^\*{1,2}[ \t]*/, '');
  const dot = body.indexOf('·');
  const left = dot === -1 ? body : body.slice(0, dot);
  const refs = left.includes('`')
    ? [...left.matchAll(/`([^`]+)`/g)].map((m) => m[1])
    : left.split(',').map((ref) => ref.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, '')).filter(Boolean);
  const maxMinutes = dot === -1 ? undefined : durationMinutes(body.slice(dot + 1));
  return { refs, ...(maxMinutes !== undefined ? { maxMinutes } : {}) };
}

/**
 * The phase's `- **QA:** on|off`, or undefined for silence.
 *
 * Mirrors `qa_phase_directive`: bold required, first bullet wins, and any word
 * that is not exactly `on` or `off` reads as silence so a typo inherits the
 * plan rather than inventing a regime.
 */
const QA_BULLET_RE = /^[ \t]*[-*][ \t]*\*\*QA:?\*\*[ \t]*(.*)$/i;

function qaBullet(block: string): 'on' | 'off' | undefined {
  const body = firstMatch(block, QA_BULLET_RE);
  if (body === undefined) return undefined;
  const word = body.replace(/[*`]/g, '').trim().toLowerCase();
  return word === 'on' || word === 'off' ? word : undefined;
}

function calloutLines(text: string): string[] {
  const graph = findSection(sections(text), 'Phase graph');
  if (!graph) return [];
  return graph.body
    .split('\n')
    .filter((l) => /^\*\*(Blocking|Independent|Simultaneous|Parallel)/i.test(l.trim()))
    .map((l) => l.trim());
}

/**
 * Every MCP server a phase runs with — `mcp_for_phase` in `phase-graph.sh`.
 *
 * The plan-wide `**MCP servers (every session):**` line UNIONED with the
 * phase's own bullet, deduped, first-seen order. The union is the point: a
 * plan-wide server is not something a phase opts into, and a phase bullet adds
 * rather than replaces. This is also the count the engine charges its size
 * surcharge on, so anything costing a phase must ask this and not the bullet.
 */
export function mcpServersFor(plan: Plan | undefined, phase: number): string[] {
  if (!plan) return [];
  return [...new Set([
    ...(plan.sessionBudget.mcpServers ?? []),
    ...(plan.phases[phase]?.mcpServers ?? []),
  ])];
}

/**
 * Every credential id a phase needs: the plan-wide line UNIONED with the
 * phase's own bullet, deduped, first-seen order — `credentials_for_phase()`
 * in phase-graph.sh, which `--credentials N` prints and engine-parity pins.
 */
export function credentialsFor(plan: Plan | undefined, phase: number): string[] {
  if (!plan) return [];
  return [...new Set([
    ...(plan.sessionBudget.credentials ?? []),
    ...(plan.phases[phase]?.credentials ?? []),
  ])];
}

/**
 * The credential policy that applies to a phase: its own bullet, else the
 * plan's line, else undefined (silence — the run's setting decides), exactly
 * `credential_policy_for_phase()`.
 */
export function credentialPolicyFor(plan: Plan | undefined, phase: number): CredentialPolicy | undefined {
  if (!plan) return undefined;
  return plan.phases[phase]?.credentialPolicy ?? plan.sessionBudget.credentialPolicy;
}

/**
 * One step the plan declares for a person (control-tower phase 41) — what
 * `--human-steps N` prints, as a record. `where` is resolved (the kind's
 * default when the bullet is silent); `windowMinutes` is read as minutes.
 */
export type HumanStepDirective = {
  kind: HumanStepKind;
  what: string;
  open?: string;
  proof?: string;
  where: HumanStepWhere;
  windowMinutes?: number;
  autoOpen?: 'host';
  credential?: string;
  /** The watch ref the step is `upcoming` until (control-tower phase 121). */
  due?: string;
  /** Your turn (control-tower phase 130): the reason a person fits it, the minutes, the phases, the guide file. */
  why?: WhyPerson;
  effortMinutes?: number;
  unblocks?: number[];
  guide?: string;
};

/**
 * The steps phase N declares for a person — `human_steps_for_phase()`. Phase 0
 * is the plan's own: its `## Operator errands` bullets (control-tower phase 121).
 */
export function humanStepsFor(plan: Plan | undefined, phase: number): HumanStepDirective[] {
  if (phase === 0) return plan?.operatorErrands ?? [];
  return plan?.phases[phase]?.humanSteps ?? [];
}

/**
 * One step as the engine prints it: kind, what, open, proof, where, window,
 * auto-open, credential — tab-separated — and a ninth field, the `due:` ref,
 * only when the step names one.
 */
export function humanStepLine(step: HumanStepDirective): string {
  const turn = step.why || step.effortMinutes !== undefined || step.unblocks || step.guide;
  return [
    step.kind, step.what, step.open ?? '', step.proof ?? '', step.where,
    step.windowMinutes === undefined ? '' : String(step.windowMinutes), step.autoOpen ?? '', step.credential ?? '',
    ...(turn
      ? [step.due ?? '', step.why ?? '', step.effortMinutes === undefined ? '' : String(step.effortMinutes),
        step.unblocks ? step.unblocks.join(',') : '', step.guide ?? '']
      : step.due ? [step.due] : []),
  ].join('\t');
}

/**
 * How many waits a phase may declare, and which line said so (control-tower
 * phase 121, #40) — `wait_count_for_phase()`: the phase's `Wait count:`
 * bullet, else the plan's line, else undefined (the console's own four). With
 * no phase, the plan line alone.
 */
export function waitCountFor(plan: Plan | undefined, phase?: number): { count: number; source: 'phase' | 'plan' } | undefined {
  if (!plan) return undefined;
  const own = phase === undefined ? undefined : plan.phases[phase]?.waitCount;
  if (own !== undefined) return { count: own, source: 'phase' };
  const planWide = plan.sessionBudget.waitCount;
  return planWide !== undefined ? { count: planWide, source: 'plan' } : undefined;
}

/** The phase's `- **Person-check:**` word — `person_check_for_phase()`; phase-only, no plan-wide line. */
export function personCheckFor(plan: Plan | undefined, phase: number): string | undefined {
  return plan?.phases[phase]?.personCheck;
}

/**
 * The 5.1.0 directives, resolved — `_resolve_directive()` in `phase-graph.sh`.
 *
 * Phase bullet, else plan line, else the engine's own default, and the answer
 * SAYS WHICH. Everything above this point either answers a bare word (and lets
 * silence mean "the run decides") or unions two levels; this family does
 * neither, because its words have defaults and a default that cannot be told
 * apart from a choice is a wizard that stops asking a question nobody answered.
 *
 * `undefined` is returned only where the engine prints nothing — `isolationFor`
 * alone, whose default belongs to the run and not to the plan.
 */
function resolve<T extends string>(
  own: T | undefined, planWide: T | undefined, fallback: T,
): Resolved<T> {
  if (own !== undefined) return { value: own, source: 'phase' };
  if (planWide !== undefined) return { value: planWide, source: 'plan' };
  return { value: fallback, source: 'default' };
}

/** What happens to a phase's commits when it settles — `land_for_phase()`. */
export function landFor(plan: Plan | undefined, phase?: number): Resolved<LandPolicy> {
  const own = phase === undefined ? undefined : plan?.phases[phase]?.land;
  return resolve(own, plan?.sessionBudget.landing, DEFAULT_LAND);
}

/** Whether a landing superproject phase also moves the gitlink — `gitlink_for_phase()`. */
export function gitlinkFor(plan: Plan | undefined, phase?: number): Resolved<GitlinkPolicy> {
  const own = phase === undefined ? undefined : plan?.phases[phase]?.gitlink;
  return resolve(own, plan?.sessionBudget.gitlink, DEFAULT_GITLINK);
}

/** Whether a session may open an issue for something outside its phase — `issues_for_phase()`. */
export function issuesFor(plan: Plan | undefined, phase?: number): Resolved<IssueMode> {
  const own = phase === undefined ? undefined : plan?.phases[phase]?.issues;
  return resolve(own, plan?.sessionBudget.issues, DEFAULT_ISSUES as IssueMode);
}

/**
 * Whether a phase gets a checkout of its own — `isolation_for_phase()`.
 *
 * The one member of this family that can answer NOTHING. A phase that says
 * nothing inherits the run, and the run is not in the plan: answering `shared`
 * here would be the parser deciding a question the operator owns, and would
 * make a run-level `worktree` setting unreachable on every plan ever written.
 */
export function isolationFor(plan: Plan | undefined, phase?: number): Resolved<IsolationDirective> | undefined {
  const own = phase === undefined ? undefined : plan?.phases[phase]?.isolation;
  if (own !== undefined) return { value: own, source: 'phase' };
  const planWide = plan?.sessionBudget.isolation;
  return planWide !== undefined ? { value: planWide, source: 'plan' } : undefined;
}

/**
 * The permission mode a plan asks a phase's session to start in —
 * `permission_mode_for_phase()` (control-tower phase 11, #34). Overrides, never
 * unions: the phase's bullet beats the plan's line. Undefined when both are
 * silent, because the RUN's default answers then (and `acceptEdits` below it) —
 * the same reason `isolationFor` leaves the run's question to the run.
 */
export function permissionModeFor(plan: Plan | undefined, phase?: number): Resolved<PermissionMode> | undefined {
  const own = phase === undefined ? undefined : plan?.phases[phase]?.permissionMode;
  if (own !== undefined) return { value: own, source: 'phase' };
  const planWide = plan?.sessionBudget.permissionMode;
  return planWide !== undefined ? { value: planWide, source: 'plan' } : undefined;
}

/**
 * What a run may do to a phase's model — `model_policy_for_phase()`
 * (control-tower phase 54, #91). Overrides, never unions: the phase's bullet
 * beats the plan's line. Undefined when both are silent, because the RUN's
 * `modelPolicy` answers then (and `ladder` below it).
 */
export function modelPolicyFor(plan: Plan | undefined, phase?: number): Resolved<ModelPolicy> | undefined {
  const own = phase === undefined ? undefined : plan?.phases[phase]?.modelPolicy;
  if (own !== undefined) return { value: own, source: 'phase' };
  const planWide = plan?.sessionBudget.modelPolicy;
  return planWide !== undefined ? { value: planWide, source: 'plan' } : undefined;
}

/** What the run branch is cut from — `plan_base_branch()`. Plan-wide: a base branch is a fact about the RUN. */
export function baseBranchOf(plan: Plan | undefined): Resolved<string> {
  const own = plan?.sessionBudget.baseBranch;
  return own !== undefined ? { value: own, source: 'plan' } : { value: DEFAULT_BASE_BRANCH, source: 'default' };
}

/** What a landing that will not merge cleanly does — `plan_conflict_policy()`. Plan-wide. */
export function conflictPolicyOf(plan: Plan | undefined): Resolved<ConflictPolicy> {
  return resolve(undefined, plan?.sessionBudget.conflictPolicy, DEFAULT_CONFLICT);
}

/** Whether this plan's sessions may message each other — `plan_messaging()`. Plan-wide. */
export function messagingOf(plan: Plan | undefined): Resolved<'on' | 'off'> {
  return resolve(undefined, plan?.sessionBudget.messaging, DEFAULT_MESSAGING as 'on' | 'off');
}

/**
 * The paths two concurrent phases must never both touch — `plan_clash_zones()`.
 * A list, so no source token: an empty list and a plan that never named one are
 * the same instruction to everything that reads it.
 */
export function clashZonesOf(plan: Plan | undefined): string[] {
  return plan?.sessionBudget.clashZones ?? [];
}

/**
 * How long a phase may stay parked on its declared waits, and which line said
 * so — `wait_budget_for_phase()`: the phase's `Waits on:` max, else the plan's
 * `Wait budget:`, else undefined (the console's default applies). With no
 * phase, the plan line alone.
 */
export function waitBudgetFor(
  plan: Plan | undefined, phase?: number,
): { minutes: number; source: 'phase' | 'plan' } | undefined {
  if (!plan) return undefined;
  const own = phase === undefined ? undefined : plan.phases[phase]?.waitsOn?.maxMinutes;
  if (own !== undefined) return { minutes: own, source: 'phase' };
  const planWide = plan.sessionBudget.waitBudgetMinutes;
  return planWide !== undefined ? { minutes: planWide, source: 'plan' } : undefined;
}

/**
 * How long one §Verification command of a phase may run, and which line said
 * so (control-tower phase 83, #95) — `verify_timeout_for_phase()`: the phase's
 * `Verify timeout:` bullet, else the plan's `Verify timeout:` line, else
 * undefined (the console scales the limit from the line's history). With no
 * phase, the plan line alone.
 */
export function verifyTimeoutFor(
  plan: Plan | undefined, phase?: number,
): { minutes: number; source: 'phase' | 'plan' } | undefined {
  if (!plan) return undefined;
  const own = phase === undefined ? undefined : plan.phases[phase]?.verifyTimeoutMinutes;
  if (own !== undefined) return { minutes: own, source: 'phase' };
  const planWide = plan.sessionBudget.verifyTimeoutMinutes;
  return planWide !== undefined ? { minutes: planWide, source: 'plan' } : undefined;
}

/** The refs a phase's `- **Waits on:**` bullet names — `waits_on_refs()`. */
export function waitsOnFor(plan: Plan | undefined, phase: number): string[] {
  return plan?.phases[phase]?.waitsOn?.refs ?? [];
}

/**
 * Does any phase of this plan ask to leave the run branch — the run-level half
 * of the `- **Checkout:** main` bullet.
 *
 * Pure over the parsed plan so it can be tested where the parse lives: the
 * Service's `RunnerDeps.detachRequested` is this call behind a store lookup,
 * and the runner asks it as ONE question over the run's phases (`phases` is
 * the run's `onlyPhases`; absent or empty means every phase counts). The
 * `main`/`master`/`default` spellings are `wantsDefaultCheckout`'s to decide —
 * never re-read the bullet here.
 */
export function detachRequestedIn(plan: Plan, phases?: number[]): boolean {
  const wanted = phases?.length ? new Set(phases) : null;
  return plan.graph.some((row) => (!wanted || wanted.has(row.phase))
    && wantsDefaultCheckout(plan.phases[row.phase]?.checkout));
}

export function parsePlan(text: string, slug: string, path: string): Plan {
  const frontMatter = parseFrontMatter(text);
  const body = stripFrontMatter(text, frontMatter);
  const secs = sections(body);
  const graph = parseGraph(body);

  const titleLine = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? slug;
  const provenance = /^>\s?(.+(?:\n>.*)*)/m.exec(body.split(/^##\s/m)[0] ?? '')?.[0]
    ?.split('\n').map((l) => l.replace(/^>\s?/, '')).join('\n').trim();

  // Hoisted above the phase loop, not read at the return: every phase's
  // `setup` is the plan-wide line UNIONED with its own bullet, so the budget
  // has to be parsed before the phases are built.
  const sessionBudget = parseSessionBudget(findSection(secs, 'Session budget'));
  const planSetup = sessionBudget.setup;

  const blocks = phaseBlocks(body);
  const phases: Record<number, PhaseDetail> = {};
  for (const [phase, block] of blocks) {
    const bullets = labelledBullets(block.raw);
    phases[phase] = {
      phase,
      title: block.title || graph.find((row) => row.phase === phase)?.title || `Phase ${phase}`,
      gated: isGated(body, phase, block.headingLine),
      gates: bullet(bullets, 'Gates'),
      gateCheck: firstBulletValue(block.raw, /gate-check[^:]*:\s*(.+)$/i),
      size: phaseSize(body, phase),
      model: bullet(bullets, 'Model'),
      effort: bullet(bullets, 'Effort'),
      goal: bullet(bullets, 'Goal'),
      readFirst: bullet(bullets, 'Read first'),
      files: bullet(bullets, 'Files'),
      steps: bullet(bullets, 'Steps'),
      exitCriteria: bullet(bullets, 'Exit criteria'),
      verification: bullet(bullets, 'Verification'),
      // Bring-up, run before §Verification and never part of the verdict.
      // Distinct prefix from both `Verification` and `Verify in`, so
      // `bullet()`'s prefix match cannot confuse the three. The plan-wide
      // `**Setup (every phase):**` line is UNIONED in by `setupFor`, the way
      // the MCP list is — a preamble every phase needs (a stack, a venv) is
      // stated once, and a phase that needs one more says so itself.
      setup: setupFor(planSetup, bullet(bullets, 'Setup')),
      // Distinct prefixes: neither `verification` nor `verify in` starts with
      // the other, so `bullet()`'s prefix match cannot confuse them.
      verifyIn: bullet(bullets, 'Verify in'),
      // Distinct prefix from every other bullet here, and read the same way
      // the engine's `checkout_directive()` reads it (`--checkout <phase>`).
      checkout: bullet(bullets, 'Checkout'),
      // Read off the RAW block like the MCP/Waits-on family, because the
      // engine's `wall_clock_floor_directive()` does not require the bold
      // either (`--floor <phase>`).
      wallClockFloorMin: wallClockFloorBullet(block.raw),
      // The first duration after the label, read off the RAW block like the
      // floor above (`verify_timeout_for_phase()`).
      verifyTimeoutMinutes: durationMinutes(firstMatch(block.raw, VERIFY_TIMEOUT_BULLET_RE)),
      // Backticked ids off the bullet, matching `mcp_directive()` in
      // phase-graph.sh — read from the RAW block, because the engine does not
      // require the bold and this side decides what actually gets attached.
      // Absent rather than empty when the bullet says nothing, so "no bullet"
      // and "a bullet naming nothing" read the same downstream.
      mcpServers: mcpBullet(block.raw),
      // Same regex as `mcp_policy_directive()`, same optional asterisks.
      mcpPolicy: mcpPolicyBullet(block.raw),
      // The credential twins of the two above (`credentials_directive()`,
      // `credential_policy_directive()`).
      credentials: credentialsBullet(block.raw),
      credentialPolicy: credentialPolicyBullet(block.raw),
      personCheck: personCheckBullet(block.raw),
      // control-tower phase 41: the acts only a person can do, as the plan
      // declares them (`human_steps_for_phase()`).
      humanSteps: humanStepBullets(block.raw),
      // 5.1.0: where this phase's work lands and where it runs. Each is the
      // phase half of a plan-wide line; `landFor` and its siblings resolve the
      // pair. `Land` and not `Landing` on purpose — the plan-wide line is a
      // policy for the plan, the bullet is what THIS phase does.
      land: phaseWord(block.raw, 'Land', LAND_POLICIES),
      gitlink: phaseWord(block.raw, 'Gitlink', GITLINK_POLICIES),
      isolation: phaseWord(block.raw, 'Isolation', ISOLATION_DIRECTIVES),
      issues: phaseWord(block.raw, 'Issues', ISSUE_MODES),
      // control-tower phase 11: the mode this phase's session starts in —
      // `_phase_directive <N> 'Permission[[:space:]]+mode'`, any case.
      permissionMode: permissionModeWord(
        new RegExp(`^[ \\t]*[-*][ \\t]*\\*{0,2}${PERMISSION_MODE_LABEL}\\*{0,2}[ \\t]*:(.*)$`, 'im').exec(block.raw)?.[1],
      ),
      // control-tower phase 54 (#91): `_phase_directive <N> 'Model[[:space:]]+policy'`.
      modelPolicy: phaseWord(block.raw, MODEL_POLICY_LABEL, MODEL_POLICIES),
      // What the phase waits on and its own parked-time allowance
      // (`waits_on_refs()` / `wait_budget_for_phase()`).
      waitsOn: waitsOnBullet(block.raw),
      waitCount: countWord(firstMatch(block.raw, WAIT_COUNT_BULLET_RE)),
      // Whether this phase states its own QA regime — see PhaseDetail.qa.
      qa: qaBullet(block.raw),
      handoffMustRecord: bullet(bullets, 'Handoff must record'),
      bullets,
      raw: block.raw,
    };
  }

  // A graph row without a `### Phase N` block still deserves a detail record.
  for (const row of graph) {
    if (phases[row.phase]) continue;
    phases[row.phase] = {
      phase: row.phase, title: row.title, gated: /GATED/.test(row.exitCriteria) || isGated(body, row.phase, ''),
      size: phaseSize(body, row.phase), bullets: [], raw: '',
    };
  }

  return {
    slug,
    path,
    phased: graph.length > 0,
    frontMatter,
    status: fmString(frontMatter, 'status'),
    closed: fmString(frontMatter, 'closed'),
    closedReason: fmString(frontMatter, 'closed_reason'),
    created: fmString(frontMatter, 'created'),
    declaredPhases: fmNumber(frontMatter, 'phases'),
    memoryKey: fmString(frontMatter, 'memory') ?? `project_${slug}`,
    title: titleLine,
    provenance: provenance || undefined,
    sections: secs,
    context: findSection(secs, 'Context')?.body,
    architecture: findSection(secs, 'Architecture')?.body,
    endToEnd: findSection(secs, 'End-to-end')?.body,
    sessionBudget,
    // The first pipe table of the `## Decisions` section — `_decisions_table()`
    // in phase-graph.sh reads the same table the same way (columns by name,
    // the separator row skipped, a fenced example ignored).
    decisions: parseDecisionsTable(findSection(secs, 'Decisions')?.body ?? ''),
    graph,
    callouts: calloutLines(body),
    reviewers: inPlanReviewers(body),
    phases,
    // `human_step_bodies 0` (control-tower phase 121): the section's own bullets.
    ...((() => {
      const errands = humanStepBullets(findSection(secs, 'Operator errands')?.body ?? '');
      return errands ? { operatorErrands: errands } : {};
    })()),
    body,
  };
}

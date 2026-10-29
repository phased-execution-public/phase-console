# Mode 1 — `plan` (no plan exists yet)

**First:** name the model that will RUN the phases and read `references/sizing.md` §Step 1–3. Then work
the steps below in order; each ends on the condition stated in bold.

Contents: Step 1 the session budget · Step 2 the decision manifest · Step 3 drafting the plan · Step 4
gates · Step 5 scaffold, lint, commit · Step 6 the root phase · It's working if

## Step 1 — Set the session budget, then minimize phase count

Identify the model that will *run* these phases — you know your own from your system context; if a
different model will execute them, ask (`AskUserQuestion`; the common split is Fable plans, Opus
executes — default `claude-opus-5-5`). Look up its budget in `references/sizing.md` and **author the
fewest phases that each fit one session** — by the measured model there (the floor every session pays
plus the slope × the phase's weight, under the target), never by weight over budget. Add a boundary
only where one is *earned*: an external gate, a deliberate model switch, or a checkpoint the user asked
for. Subsystem tidiness earns none — extra phases buy repeated bootstrap and handoff ceremony. A split
buys real parallelism only along **repo boundaries**, since disjoint scopes may run as concurrent
sessions. A phase that does not fit one session is two phases (`--session-plan` flags it `over budget —
split`).

Record in a `## Session budget` note: the target model and budget, each phase's rough `- **Size:**
S|M|L` (default `M`), and the **branch** — by default the branch already checked out; create ONE feature
branch for the whole plan only when the user asked (every phase, concurrent ones included, commits to
it). The console can impose a run branch `pe/<slug>` at launch; the plan line stays the default for
hand-driven sessions (`references/conventions.md` §Branches).

Optional lines, each only when the user asked for it:

- **`**QA gate:** on`** — QA is off by default (`references/qa-method.md`).
- **`- **Worktrees:** on`** — this plan's disjoint lanes each get their own git checkout instead of
  sharing the run's. Phase Console reads it with its new-branch git strategy; a hand session ignores it.
  On a **superproject** the run takes a **MIRROR** instead of a plain linked worktree: one linked
  worktree per scoped sub-repository, the root's own tree first (since 2026-09-05), one mirror per RUN
  shared by its phases and serialized per scope. Two cases refuse by name — `scope-unmapped` (a scope
  naming no repository, or an uninitialized submodule) and per-LANE worktrees under a superproject
  (`has-submodules`); every refusal is journalled and degrades to a shared checkout. Each lane commits
  to **`pe/<slug>-p<N>`**, a *sibling* of the run branch `pe/<slug>` (the hyphen is load-bearing:
  `pe/<slug>/p4` is impossible in git while `pe/<slug>` exists), merged back when the phase settles. `$DOCS_ROOT` is
  injected into every spawned session and keeps its value — skill scripts resolve the docs root from
  it first, and inside a lane's worktree a cwd walk would answer the worktree.
- **`**Skills (every session):**`** — skills the user named for this work, each backticked; the
  engine re-injects them into every boot prompt and QA brief.
- **`**MCP servers (every session):**`** — backticked registry ids, three to six at most; a phase that
  needs one the rest do not takes its own `- **MCP:** \`server\`` bullet, UNIONED with the plan line.
  The console probes them before a phase boards. By default an unreachable server leaves the phase
  running without it, told which are missing and to record the gap as an operator errand. **When a
  phase genuinely cannot proceed without its server**, write `**MCP policy:** require` (or a per-phase
  `- **MCP policy:** require`, which overrides the plan line either way) — sparingly: a parked phase
  with no other ready phase behind it halts the plan.

**Done when** the note names the model, the budget, the branch and every phase's size.

## Step 2 — Elicit the decision manifest — ONE question at a time, before authoring

Nothing asks a person mid-run: every decision a run can need is asked here, once, and written as a
row of the plan's **`## Decisions`** table (`references/plan-format.md` §Decisions). Ask each with
`AskUserQuestion`, the Tier-1 default first and marked `(Recommended)`, and write the answer as
`| \`<key>\` | <value> | <who answered> | answered | <yes|no> | plan | <evidence> |`. A key the user
leaves open stays `outstanding` with an owner (an `outstanding` row with NO owner fails `validate.sh`,
F25); one they rule out is `waived` with the reason as its value.

The nineteen keys, in order (`scripts/decisions.env` `DECISION_KEYS`):

1. `permission.policy` — this plan's ask/deny/allow overlay, `autoApprove`; also a `**Permissions:**` line.
2. `permission.destructive` — publishing and destructive verbs: `deny`, with named per-phase exceptions
   (`**May publish:**`).
3. `issues` — `off`, `draft` or `file` for problems a session trips over (`**Issues:**`).
4. `credentials` — backticked ids on `**Credentials:**` + `**Credential policy:** require|continue`; a
   phase adds its own with `- **Credentials:**`.
5. `accounts` — `**Accounts:**` as `\`id:minHeadroom\`` pairs, a percent.
6. `mcp` — the MCP question above.
7. `gates` — `Gate-check` on every `*(GATED)*` heading (a missing one fails the lint, F24, and reads
   as `ai`), and `Gates: delegated|operator`.
8. `verification.person-check` — allow, halt, or an owner when a §Verification fragment is prose
   (`- **Person-check:**`).
9. `qa.exhausted` — `**QA exhausted:** waive|halt|<owner>`; skip when QA is off.
10. `waits` — each expected external wait, its `--watch` ref and its maximum: `**Wait budget:**` is the
    TOTAL one phase may spend parked across all its waits, and a phase's `- **Waits on:** <ref> ·
    <max>` overrides it for that phase.
11. `human-acts` — steps denied to an agent, each with the ref that proves it landed: `- **Human
    step:** <kind> · <what> · open: <url or command> · proof: <ref> · where: host|any · window:
    <duration>` (the 5.1.0 `<who, what, proof ref>` spelling fails the lint, F37), with the person's
    words beside it — `guide: <file>` (F42 `guide-file-missing` gates when it names no file), a
    decision's `options: id=Label[::consequence] | …` and `recommended: <id>`, a `deadline: <ISO 8601>`,
    or a `## Operator errands` row its text names as `(E-N)` (`references/turn.md`). A task or decision
    with none of these draws F41 `human-step-no-guide`, and an errands row no bullet names F43
    `errand-row-unbound`. An act only the RUN can take is no human step: a session declares it
    `blocked --needs run --run-act <act>`.
12. `ambiguity` — ruling, ask or halt when the plan did not decide (`**When in doubt:**`).
13. `budgets` — run, phase and turn ceilings.
14. `resume.on-restart` — continue, hold or ask: the RUN's answer.
15. `plan-health` — whether the advisory lints gate this plan.
16. `stop` — `autonomy`, and who is told on a halt.
17. `relay` — `off` or `last-resort`: a question asked mid-run gets 60 s in front of a person, then a
    rule answers (arms at CLI 2.1.268+).
18. `announce` — which categories push, to whom.
19. `plan-approval` — `hold` or `continue`: what a plan-mode phase's presented plan waits for.

The shipped defaults (`POLICY_DEFAULTS`): `gates: delegated` · `qa.exhausted: waive` ·
`resume.on-restart: continue` · `ambiguity: ruling` — the template's four — and
`verification.person-check: operator` · `credentials: continue` · `mcp: continue` · `relay: off` ·
`waits: window` · `plan-approval: hold`. `scripts/phase-graph.sh <slug> --decisions` reads the table
back, and the boot prompt hands each phase its rows.

**Done when** every key has a row: `answered`, `waived`, or `outstanding` with an owner.

## Step 3 — Draft the plan

Use the `references/plan-format.md` shape. **Every phase is self-contained** — a session with zero
prior context executes it from the plan and its handoff alone.

- **The `## Phase graph` table is load-bearing.** Its `Depends on` column is the dependency source the
  engine parses: every phase lists **every** phase that must finish first (comma-separated numbers,
  ranges like `1–7`, or `—`). Fill `Parallel-safe with`, `Repos`, exit criteria and the **"Blocking vs
  simultaneous"** callout.
- **Every phase carries a runnable `- **Verification:**`** — whole backticked commands or a fenced
  block proving its exit criteria (`validate.sh` fails F14 `verification-empty-open` on an open phase
  without one; the autopilot parks such a phase at boarding). Bring-up goes on `- **Setup:**`; a
  directory goes on `**Verify in:**`.
- **A phase that edits this skill** — `SKILL.md`, a `references/mode-*.md` file, the description —
  runs the skill's eval suite (`evals/`, through `claude plugin eval`) as one of its verification lines.

**Done when** every phase has its graph row, its exit criteria and a runnable §Verification.

## Step 4 — Categorize every gate

Mark an externally-gated phase `*(GATED)*` in its `### Phase N` heading with a `- **Gates (must clear
first):** …` line AND a category directive `- **Gate-check:** …`:

- **`ai <one-line check>` — the DEFAULT unless a person is genuinely required.** A session verifies the
  conditions, does the work to make them true, and records the clearance itself; the boot prompt orders
  it to.
- **`manual <who/what>` — only when a person is truly required** (a physical action, a third party,
  credentials no session holds). Then the Gates bullet carries full **numbered step-by-step operator
  instructions**: the console renders them on the phase's Gate card beside its Approve button.
- **Self-evaluating checks** (`date` · `phase`/`phases` · `plan` · `deadline`/`by` · `cmd`) when a
  machine can answer directly. Grammar and the approval lifecycle: `references/plan-format.md`.

**Done when** every `*(GATED)*` heading has a `Gate-check` and every `manual` gate numbered steps.

## Step 5 — Scaffold, lint, preview, commit

1. `bash <skill-root>/scripts/new-plan.sh <slug>`, then fill it in. (`<skill-root>` is the base
   directory this skill loaded from — the Skill banner names it, and `$CLAUDE_PLUGIN_ROOT` holds it in
   a plugin install; F13 rejects an assumed home-directory skills path.)
2. `scripts/validate.sh <slug>` and `scripts/phase-graph.sh <slug>` — every phase listed, the right
   roots `ready`, and (with `Size:` tags) `SUGGESTED BATCHES:`. A missing phase is a row the parser
   skipped; fix it here. `--explain <F-code>` prints any lint's paragraph.
3. `scripts/phase-graph.sh <slug> --session-plan <model>` — the forecast in measured sessions and the
   groups a person may batch by hand; paste its generated `Weight:` line into §Session budget.
4. Commit `docs/plans/<slug>.md`.

**Done when** `validate.sh` exits 0 and the plan is committed.

A plan that needs one more phase later takes it through `scripts/amend-plan.sh` — never a hand edit of
the graph — and a plan lists what it knows it has not decided under `## Not yet specified`, which
`close-plan.sh --status complete` refuses to close over (`references/plan-format.md` §Amendments).

## Step 6 — Implement the root phase(s) in this same session

Switch to Mode 2 (`references/mode-phase-start.md`). Driving by hand, continue into further ready phases
while the budget lasts (Mode 3 step 6); the console runs one phase per session. What doesn't fit runs in
later sessions from the composed prompts — concurrently where their scopes are disjoint.

## It's working if

- the plan has the fewest phases that each fit one session, and each boundary names what earned it;
- every decision key has a row, asked one at a time;
- every phase has a graph row, exit criteria and a runnable §Verification;
- every gate is categorized, `ai` unless a person is genuinely required;
- `validate.sh` is clean and the root phase is under way in this session.

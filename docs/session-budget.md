# Session budget

The eleven decisions a plan records, and where each one is written.

A complete `## Session budget` note looks like this:

```markdown
## Session budget

> **Target model:** `claude-opus-5` (1M window) · **Budget:** ~200K weight/session (≈60% of the
> window) · **Branch:** current branch (no new branch).
> **Skills (every session):** `design-system`, `some-plugin:test-first`
> **MCP servers (every session):** `context7`, `playwright`
> **MCP policy:** continue
> **QA gate:** on
```

## 1 · Which model runs the phases

Phases are usually *executed* later, in fresh sessions, possibly by a different model than the one
planning now. So the plan records a target, and every phase-start re-checks it against the model
actually running — if they differ, the budget is recomputed and the batching changes. A common split
is one model planning and another executing.

## 2 · How much work fits one session

The **budget** is measured in summed phase *weight*, not raw context, and defaults to **~0.2 × the
model's effective window**, so a session's context target — 60 % of the window, the console's own
wrap-up line — is 3 × its budget. What a session's context actually IS comes from a measured model,
never from a multiple of its weight (control-tower phase 59, #83):

```
peak context ≈ boot floor + work floor + slope × weight      (shipped: 121K + 198K + 2.17 × weight)
```

- the **boot floor** is the first API call's context — the system prompt, tools, CLAUDE.md, rules,
  memory and the boot prompt, read before any work. It is per REPOSITORY (121K on one console of the
  machine that measured it, 89K on the other), and `--session-plan` reports it as its own line,
  because it is the part a repository can shrink;
- the **work floor** is what every phase session adds above its boot whatever its size;
- the **slope** is what the phase's own weight adds.

`boot + work` is the per-session floor, paid ONCE by every session: a batch of phases fits when
`floor + slope × Σweight` stays under the target. The old "≈ 3 × weight" was under 107 of 108
measured phases; the model above sits within 10 % of the median peak for every tag. Override the
budget if your session's effective window is smaller than the model's maximum:

```bash
scripts/phase-graph.sh checkout-rewrite --session-plan 40000   # a raw budget in tokens
```

## 3 · How big each phase is

Tag a phase and the engine can group phases into sessions for you:

| Tag | Working set | Looks like |
|---|---|---|
| `S` | ≤ ~15K tokens | a focused edit, a migration, one small file, a doc |
| `M` *(default)* | ~15–50K | a typical feature across a few files with some exploration |
| `L` | ~50–120K | a substantial subsystem, heavy exploration, large diffs |

Untagged phases are treated as `M`. A phase whose predicted peak exceeds the target on its own is
really two phases — split it.

**What caps a session.** On the console every session carries a dollar and a turn cap
(`--max-budget-usd`, `--max-turns`), and they are MEASURED, not chosen: each mode's p99 over the
console's own `phase.session` lines of the last two weeks, plus 50 %, rounded up — re-derived hourly
as sessions accrue (`deriveCapTable`, `viewer/server/runner/session-record.ts`). A mode with fewer
than twenty sessions in the window takes the table shipped with the release, measured the same way:

| Mode | Dollars | Turns | Measured over (shipped) |
|---|---|---|---|
| `phase` | $120 | 490 | p99 $77.81 over 274 sessions · p99 322 turns over 321, 2026-09-16 → 2026-09-25 |
| `resume` | the phase's | 120 | p99 74 turns over 27 — the resume floor |

The size tag no longer sets a cap: measured, it did not separate an M's spend from an L's (p90: M 252
turns and $51.6, L 264 and $50.4), and the per-size rows it set — "about three times the most any
measured session spent" — sat under routine M work and never bound an L. A cap binds on a runaway and
never on the p90, and every `phase.session` records each cap's derivation (percentile, headroom,
window, samples) so drift shows in the ledger. A run's `phaseBudgetUsd` still replaces the dollars.
Dollars: a phase attempt, and a session that continues the phase's work, get the phase's whole
dollars (or the whole `phaseBudgetUsd`); a side session — a closeout, a repair, a reviewer — gets a
quarter of those dollars, never under $1, unless its caller set its own (a QA round's
`qaRoundBudgetUsd`). Turns, by session (`capsFor`, held to this table by
`viewer/test/resume-caps.test.ts`):

| Session | Turn cap |
|---|---|
| a phase attempt (`phase`) | the phase's measured cap |
| a resume with an instruction (`resume`), a wait-resume (`wait-resume`) | the phase's cap minus the turns the phase already spent, never under 120 (`RESUME_MIN_TURNS`) |
| a repair (`repair`) | 90 (`REPAIR_MAX_TURNS`) |
| a closeout or closeout brief (`closeout`), a QA round (`qa`), a landing (`landing`), a PR (`pr`) or review (`review`) session | 60 (`CLOSEOUT_MAX_TURNS`) |

A side session's own measurement can raise its cap above those constants, never lower it. A session
that continues the phase does the phase's work, so it runs under what is left of the phase's
allowance; its floor is the audit week's p90 continuation stint (83 turns, over 22 stints) with about
45 % headroom. A cap that bites is not a failure: the same session resumes under double that cap — a
resume included — and the `phase.session` line names which policy set each cap.

## 4 · How many sessions a plan takes, and whether phases share one

```bash
scripts/phase-graph.sh checkout-rewrite --session-plan opus
```

Under the console the unit is **`1 phase ≥ 1 session`**: the autopilot boards every phase in a session
of its own and never batches, and a phase that wraps its context takes more. So `--session-plan`
states that unit first and forecasts the phases left from MEASURED sessions per phase, by size and by
whether a phase wraps (`sizing.env`'s `SESSIONS_*` and `WRAP_*`: an S 1.71, an M 1.66, an L 1.93) —
never a weight over a budget, which forecast 0.35–0.67 sessions a phase against a measured 1.1–5.0. It
prints the plan's weight as a generated line — quote it rather than type a sum.

Its batches are for a person driving phases by hand: it walks the *remaining* phases in dependency
order and groups them while every dependency is already satisfied and `floor + slope × Σweight`
stays under the target. It always cuts at gated phases, at unmet dependencies, and at QA boundaries.
Treat them as a suggestion — Claude confirms it against the live context meter.

## 5 · Whether QA runs

Off by default. See [QA gating](qa-gating.md) — it is a real gate, not a report, so turning it on
changes which phases are allowed to start.

## 6 · Which branch the work lands on

**Default: no new branch.** Work commits to whatever branch is already checked out, because scattering
a plan across branches you never asked for is worse than the alternative. If you *do* ask for a
branch, exactly **one** branch carries the whole plan — every phase, including independent ones in
separate sessions — and the plan records its name so every cold session checks out the same one.

The **console** can also impose a branch per run: its Automation settings (or any launch form) can
put a run on the plan-wide work branch `pe/<slug>`, with an optional PR when the plan completes.
That is a run-level choice — it wins for the sessions the console mints, warns when it contradicts
the plan's own `**Branch:**` line, and leaves hand-driven sessions following the plan's prose.
See the console's own docs ([controls](controls.md) § Console automation defaults).

## 7 · Which skills every session must use

If your work needs a particular skill applied consistently — a design skill, a TDD skill — naming it
once on the `Skills (every session):` line means the engine re-injects it into **every** phase's boot
prompt and into the QA brief. Cold sessions cannot forget it.

## 8 · What blocks a phase from starting

Beyond dependencies, a phase can be **gated** on something outside the code — a deploy window, an
approval, someone else's migration. Gated phases are never batched past, and every gate carries a
**category** — who can clear it:

```markdown
- **Gate-check:** ai staging deployed + smoke suite green   # ai — a session clears it itself (prefer)
- **Gate-check:** manual sign-off from ops                  # human — a person approves
- **Gate-check:** date 2026-09-01                           # auto — opens on that date
- **Gate-check:** phase 7                                   # auto — clears when phase 7 is verified
```

An **ai** gate makes the check the booted session's first task: verify each condition in the
`Gates (must clear first)` bullet, do the work to make failing ones true, record the clearance, then
implement. A **human** gate stops everything until a person does the bullet's numbered steps and
approves — on the console's phase-page **Gate card**, or with `gate-approve.sh`. Prefer `ai` unless a
person is genuinely required; the automation should never strand a human on a gate a session could
clear.

```bash
scripts/phase-graph.sh checkout-rewrite --gate-status 9   # exit 0 = clear, 1 = blocked/manual/ai
scripts/phase-graph.sh checkout-rewrite --gate-kind 9     # human | ai | auto | none
scripts/gate-approve.sh checkout-rewrite 9 --by ops --note "window confirmed"   # clears ANY kind
```

Approvals land in `docs/handoffs/<slug>/gate-status.md` (revocable with `--revoke`) — commit and push
it, like the QA table.

## 9 · Which MCP servers the work needs, and what happens when one will not connect

If the work needs MCP servers — a browser, an issue tracker, a docs server — name them once in
§Session budget and the engine re-injects them into **every** phase's boot prompt and the QA brief,
and the console preflights them before a phase boards, so a wall costs a probe rather than an hour:

```markdown
**MCP servers (every session):** `context7`, `playwright`
**MCP policy:** continue          # continue (default) | require
```

Ids are the backticked *registry* ids from Phase Console ▸ MCP — three to six at most. A phase that
needs a server the rest of the plan does not gets its own bullet, and the two are **unioned**:

```markdown
- **MCP:** `github`
- **MCP policy:** require
```

**The policy decides what a failed connection costs.** Under `continue` (the default) the phase boards
without the servers that would not answer, its prompt names them, it is told to record the gap under
**Outstanding** as an operator errand, and you are warned once per run per server. Under `require` the
phase parks instead — use it sparingly: a parked phase with no other ready phase behind it halts the
whole plan. `Park on a required MCP server for` (default 30 min) bounds that park.

**The resolution order reverses here, and deliberately.** It is
`the operator's per-phase choice → the PLAN (phase bullet, then §Session budget) → the run → continue`.
Everywhere else the run outranks the plan, because model and effort are preferences about spending;
this is a claim about the *work*, so only an operator's per-phase choice may overrule it. At the plan
level `continue` and `require` are the recognised words and **silence is a third state** — an explicit
`- **MCP policy:** continue` is how one phase carves itself out of a plan-wide `require`, and silence
is what lets the run's setting speak at all.

```bash
scripts/phase-graph.sh checkout-rewrite --mcp 9          # the servers phase 9 runs with (plan ∪ phase)
scripts/phase-graph.sh checkout-rewrite --mcp-policy 9   # continue | require
```

## 10 · Where the docs live

Scripts find your repo root automatically, including from inside a submodule. Override it when you
need to:

```bash
DOCS_ROOT=/path/to/repo scripts/phase-graph.sh checkout-rewrite
```

## 11 · What a run needs decided before it starts

**Written in `## Decisions`** — the decision manifest, one row per key of a closed vocabulary
(`permission.policy`, `permission.destructive`, `credentials`, `accounts`, `mcp`, `gates`,
`verification.person-check`, `qa.exhausted`, `waits`, `human-acts`, `ambiguity`, `budgets`,
`resume.on-restart`, `plan-health`, `stop`, `relay`, `announce`), each with a value, an owner, a
state (`answered` · `outstanding` · `waived`), whether it blocks the run, where the answer came from
and its evidence. Nothing asks a person mid-run: the skill's plan mode asks these once, before
authoring, and the console refuses to start a run while a blocking row is still `outstanding`.

Some rows resolve from lines in this section — `**Credentials:**` + `**Credential policy:**`,
`**Accounts:**`, `**Permissions:**`, `**May publish:**`, `**QA exhausted:**`, `**When in doubt:**`,
`**Wait budget:**` — and from per-phase bullets (`- **Credentials:**`, `- **Waits on:**`,
`- **Human step:**`, `- **Person-check:**`). Answers that arrive later go to a twin the engine
merges over the table, written only by `scripts/decisions.sh`. The human-step bullet has one grammar
since control-tower phase 41 — `- **Human step:** <kind> · <what> · open: <url or command> · proof:
<ref> · where: host|any · window: <duration> [· auto-open: host] [· due: <ref>]`, one of seventeen
kinds — legal under the plan's `## Operator errands` heading too, as the plan's own act — and the
5.1.0 `<who, what, proof ref>` spelling it replaced fails the lint by name (F37).

**The wait budget is a total, and spending it is never a failure.** `**Wait budget:** 48h` is the
TOTAL wall-clock one phase may spend parked across every wait it declares — not a window per wait;
with the line absent the console's default is 8 h. A phase's `- **Waits on:** <ref>[, <ref>…] · <max>`
overrides it for that phase alone, and a `date:` ref among its refs countersigns a wait up to that
instant. Each declaration is judged against what is left — the budget minus the time the phase has
already spent parked, read from each park's own stamps — at park and again at resume:

- a window that fits what is left parks;
- a window past what is left, but inside the plan's countersign, parks;
- a window past both that names a `--watch` ref the console can poll is granted what is left: the
  ref's landing decides, not the window — as does a park that named no window at all (the 30-minute
  default), which is shortened to what is left;
- a window past both that names no such ref is **refused**, and a refusal is a budget event, not a
  failure: the phase parks `waiting` on its refs with no clock of its own and a `budgets` errand that
  states the arithmetic and names the two lines that would give it more. Nothing is failed and the
  failure streak is not charged; a landing still resumes the session, and raising the budget and
  pressing Retry gives it a clock again.

One phase may declare at most four waits (`WAIT_MAX_PER_PHASE`) unless the plan raises the count —
`**Wait count:** <n>` in this section, or `- **Wait count:** <n>` on the phase, 1 to 99 (control-tower
phase 121, #40); a spent count whose watch ref still polls is a wait on that ref, never an errand. The
console's own watchdog parks spend a separate allowance and never touch this one.

```bash
scripts/phase-graph.sh <slug> --decisions        # the rows as they hold: key, state, owner, blocking, source, value
scripts/phase-graph.sh <slug> --decisions 4      # resolved for phase 4 (its own rows over the plan-wide ones)
scripts/phase-graph.sh <slug> --wait-budget 4    # minutes⇥phase|plan — nothing means the console default
scripts/phase-graph.sh <slug> --waits-on 4       # the refs phase 4's Waits on: bullet names, one per line
scripts/decisions.sh <slug> answer waits --value "gh:acme/x#run/9 · 45m" --by me
scripts/decisions.sh <slug> --phase 4 waive relay --reason "no relay in the gated phase"
```

A session that hits a decision the manifest lacks declares it by key — `phase-outcome.sh <slug> <N>
blocked --needs <key>` — and the console files a defect report rather than an errand. The whole
story: [Decisions](decisions.md).

---


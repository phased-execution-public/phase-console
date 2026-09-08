# Session budget

The ten decisions a plan records, and where each one is written.

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
model's effective window**. That lands a full session near ~60% real window use — clear of
auto-compaction (~83%) and clear of the late-window quality zone. Override it if your session's
effective window is smaller than the model's maximum:

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

Untagged phases are treated as `M`. A phase whose weight exceeds one session's budget is really two
phases — split it.

## 4 · Whether phases share a session

```bash
scripts/phase-graph.sh checkout-rewrite --session-plan opus
```

It walks the *remaining* phases in dependency order and groups them while every dependency is already
satisfied and the summed weight fits the budget. It always cuts at gated phases, at unmet
dependencies, and at QA boundaries. Treat it as a suggestion — Claude confirms it against the live
context meter.

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

---


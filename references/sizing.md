# Sizing — cost model, model budgets, and batching

Contents: [The real cost model](#the-real-cost-model-why-fresh-sessions-help--and-why-not-always) ·
[Step 1 — know your model](#step-1--know-your-model) ·
[Step 2 — pick the session budget](#step-2--pick-the-session-budget-from-the-model) ·
[Step 3 — right-size and batch](#step-3--right-size-and-batch) ·
[The session model](#the-session-model-a-floor-paid-once-plus-a-slope) ·
[Size annotation](#size-annotation-optional-drives-the-engine) ·
[What caps a session](#what-caps-a-session-under-phase-console) ·
[Keep the session lean](#keep-the-session-lean-so-the-budget-goes-further)

This is the source of truth for **how big one session should be** (the prose + rationale). The **machine
values** — the `S=15K M=40K L=90K` weights and the per-model budgets — live in `scripts/sizing.env`, which
`scripts/phase-graph.sh` sources, so the numbers here and the engine can't drift (F5). The model **names**
those numbers are keyed by — which aliases exist, their full ids, which carry the big budget class, and the
`[1m]` window suffix — live next door in `scripts/models.env`, read by the same engine and by the console.
Change a number in `sizing.env`, a name in `models.env`, and keep this doc in step. SKILL.md links here;
`--session-plan` uses those same values.

## The real cost model (why fresh sessions help — and why not always)

The old rationale was "context is re-read every turn, so cost is quadratic." That is **wrong for an
interactive Claude Code session**, because the harness **prompt-caches the conversation prefix
automatically**:

- A cache **read** costs ~**0.1×** base input; a cache **write** costs ~**1.25×** (5-minute TTL).
- So each turn re-sends the whole conversation, but the large stable prefix is served from cache at
  0.1×; you pay full price only on the small new tail + output. **A warm session is roughly *linear*
  in turns, not quadratic.**

So the lever isn't "avoid re-reads." There are three real ones:

1. **Context rot (quality).** As the window fills, recall and precision degrade — the "lost in the
   middle" effect, attention-budget depletion. This is usually the *first* thing to bite, well before
   cost. A focused session simply produces better code.
2. **Cache-busting events (cost spikes).** A few actions throw away the warm cache and force a
   full-price re-read of the (by-now-large) context: **switching model, changing the effort/reasoning
   level, connecting/disconnecting an MCP server, `/compact`, resuming after a Claude Code upgrade, or
   a >5-minute idle gap (the cache TTL expires)**. Several of these in one long session are where the
   "quadratic" feeling actually comes from.
**Attached MCP servers add to a phase's weight.** Each one puts its instructions (capped at 2 KB by
the CLI) and its tool names into the system prompt of *every* turn; tool search defers the full
schemas, which is why the cost is a few hundred tokens per server rather than a few thousand, and why
it flattens as you add more. The engine and the console both charge `MCP_SURCHARGE` per attached
server, capped at `MCP_SURCHARGE_MAX` — canonical values in `scripts/mcp.env` (F5), currently
**1,500 tokens each, capped at 12,000**. The cache-bust above is the bigger cost and is *not* in that
number, which is exactly why servers are attached at a phase boundary and never mid-phase.

3. **Bootstrap overhead (the counterweight).** Every fresh session re-pays a fixed cost: reading the
   handoff + plan + memory and re-exploring the code — plus the closeout ceremony the previous session
   paid to hand off (handoff file, commits, boot prompts). Splitting work into *too many tiny* sessions
   wastes this over and over and throws away a warm cache. **This is exactly why a plan has the fewest
   phases that fit** — the console runs one phase per session, so every phase boundary pays it — **and
   why, driving by hand, adjacent phases that fit one session together may share it.**

**The rule that falls out:** *one coherent, **right-sized** chunk of work per session* — big enough to
amortize bootstrap and keep the cache warm, small enough to stay clear of context rot and the harness
auto-compaction threshold.

## Step 1 — know your model

You (the running agent) already know your own model from your system context (e.g. "powered by Opus
5 / `claude-opus-5`"). Use it. Phases are *executed* in future sessions that may run a **different**
model than the one planning now — the common split is **Fable plans (Mode 1), Opus executes** — so the
plan records a **target execution model** in its `## Session budget` note (default `claude-opus-5`
when the user hasn't said otherwise), and each phase-start re-checks it. If the target is genuinely
unknown, ask with `AskUserQuestion` ("Which Claude model will run these phases?").

**How a model may be written.** Three spellings resolve to the same model: the **alias** (`fable`, `opus`,
`sonnet`, `haiku`), the **full id** (`claude-opus-5`), and either of those carrying the **`[1m]` window
suffix** (`opus[1m]`, `claude-opus-5[1m]`). The mode alias `opusplan` is accepted and passed through
verbatim. All of them read the same everywhere — the plan's `**Target model:**` line, a phase's
`- **Model:**` bullet, `--session-plan`, the console — because the vocabulary is one file,
`scripts/models.env` (F5). `--effort` is a separate axis and takes exactly `low` · `medium` · `high` ·
`xhigh` · `max`.

**A bare alias is rated by family; a `[1m]` name is rated by window.** The suffix selects a context
window, not a model: `claude-opus-5[1m]` is still Opus for quota, for escalation and for account matching,
and only its **budget** differs — which is the whole reason the window has to be written down instead of
assumed. `[1m]` is available on `fable`, `opus` and `sonnet`; `haiku[1m]` is refused by the API today
("the long context beta is not yet available for this subscription"), so it isn't offered in pick lists,
though the name still parses.

## Step 2 — pick the session budget from the model

**Budget is measured in summed phase *weight*** (the `S/M/L` working-set estimates below), **not raw
context.** A phase's weight approximates what its work adds as working set — files opened, tool
output, generated diffs. The budget is **~0.2 × the effective window**, so a session's context
TARGET — **~60% of the window**, the console's own wrap-up line, clear of auto-compaction (~83%) and of
the late-window quality rot zone — is 3 × its budget. What a session's context actually IS comes from
the measured model in [The session model](#the-session-model-a-floor-paid-once-plus-a-slope), never
from a multiple of its weight: every session pays a floor before its weight counts at all.

| Model | Max window | Max output | $ in / out per MTok (as of 2026-07) | Session budget preset (weight) | Use for |
|---|---|---|---|---|---|
| Opus 5 / 4.8 / 4.7 | 1M | 128K | 5 / 25 | **~200K** (its target, 60% of the window, is 600K of context) | the default execution model (Opus 5 is the latest); hard reasoning / architecture |
| Fable 5 | 1M | 128K | 10 / 50 | **~200K** | planning (Mode 1) + the most demanding long-horizon phases; priciest |
| Sonnet 5 / 4.6 | 1M | 64K | 2 / 10 intro (→3 / 15) · 4.6: 3 / 15 | **~200K** | balanced execution / implementation phases |
| Haiku 4.5 | **200K** | 64K | 1 / 5 | **~40K** | mechanical / cheap phases → smaller phases, more of them |

> **Tokenizer caveat.** Opus 4.7+, Fable 5, and Sonnet 5 tokenize ~30% denser text into ~30% *more*
> tokens than older models — don't reuse working-set counts measured on pre-4.7 models; the S/M/L bands
> already assume the newer tokenizer.

> **Effective-window caveat.** These are the models' *max* windows. The window your Claude Code session
> actually exposes may be smaller by configuration (a 200K effective window is possible even on
> 1M-capable models, and the session auto-compacts near its limit). The **~200K presets assume a
> genuinely ≥1M effective window**. Size to the window you actually have — budget ≈ 0.2 × effective
> window: a 200K effective window → a ~**40K** budget (`--session-plan 40000`). Writing `opus[1m]` is how
> you *assert* the 1M window rather than hope for it.

Four budget classes, one `sizing.env` key each:

| Class | `sizing.env` key | Budget (weight) | Matches |
|---|---|---|---|
| 1M window | `BUDGET_1M` | **200K** | any name carrying `[1m]` — checked first, so the suffix wins over the family |
| big | `BUDGET_BIG` | **200K** | `fable` · `opus` · `sonnet` · `mythos` (`MODEL_BIG` in `models.env`) |
| Haiku | `BUDGET_HAIKU` | **40K** | `haiku` |
| default | `BUDGET_DEFAULT` | **40K** | unrecognised or unspecified — assume a 200K effective window |

`BUDGET_1M` and `BUDGET_BIG` are both 200K today and are kept apart so they can move independently: a bare
alias may resolve to a window smaller than 1M — which is precisely why the CLI takes a `[1m]` suffix at
all — so `BUDGET_1M` is the one rating that is measured rather than assumed. Re-rating the bare aliases
down would change how every existing plan batches, so it is an operator decision (one edit, `BUDGET_BIG`)
and not a cleanup.

**Per-phase model selection is a lever too.** You don't have to run every phase on one model. Put hard
reasoning/architecture phases on Opus or Fable, balanced implementation on Sonnet, and mechanical phases
(rename sweeps, codegen, boilerplate) on cheap fast Haiku. A phase can name its preferred model in the
plan — alias, full id, or a `[1m]` variant; just remember switching models mid-*session* busts the
cache, so keep one model per session — a wanted model switch is one of the few boundaries that *earns*
a fresh session.

## Step 3 — right-size and batch

**At plan time (Mode 1) — minimize phase count.** Author the **fewest** phases that each fit one
session by [the session model](#the-session-model-a-floor-paid-once-plus-a-slope) — under the console
every phase is at least one session of its own — then add a boundary only where one is *earned* — an
external gate, a deliberate model switch, or a checkpoint the user asked for. Per-subsystem tidiness earns
nothing: extra phases mostly buy repeated bootstrap + handoff ceremony (~30-40% of a typical handoff is
ceremony). The one split that *does* buy something is along **repo boundaries** — phases with disjoint
scopes may run as concurrent sessions (§Scoped concurrency in `conventions.md`), so a fan-out that
separates repos is real parallelism while a fan-out inside one repo is not. *Don't* author three trivial
phases that should be one. A phase that does not fit one session — the floor plus the slope × its weight
past the target — is two phases; `--session-plan` flags it `over budget — split`.

**At phase boundaries (Mode 3) — the console runs one phase per session; batch only by hand.** Driving
the phases yourself, if any ready phase fits the **remaining** budget (judge with your live context
meter — you should still be comfortably under ~60% of the window when it finishes), continuing into it
in the **same** session is the *efficient* choice — it saves a full bootstrap + closeout and keeps the
cache warm. This is **batching**, and by hand it is encouraged, not a forfeit:

- **Sequential next phase** — the classic case; continue straight into it.
- **Independent siblings (parallel-safe)** — may share a session too: execution inside one session is
  serial, so even same-scope siblings are safe that way. Pick ONE to continue into. The rest run in later
  sessions — **at the same time as this one if their scopes are disjoint** (`conflicts` before each).
- **L-size phases batch like any other** — only the session model decides: the floor, paid once, plus
  the slope × the summed weight, against the target. Measured, that is about 129K of weight in a
  1M-window session — three Ms, or an L with an S (an L and an M miss by a hair) — not the 200K a
  pure multiple allowed.
- **This is a person's move, not the console's.** The console's autopilot boards every phase in a
  session of its own and never batches (`1 phase ≥ 1 session`); what it runs is forecast below.

Stop and open a fresh session when: the budget is spent, the next phase is **GATED** (external gates
never get batched past), it wants a **different model**, or — with QA enabled — it depends on a phase
whose QA verdict isn't recorded yet. Write a handoff for **every** phase as you finish it, even
mid-batch — that's what keeps each phase independently resumable.

### The session model: a floor paid once, plus a slope

Measured over 264 fresh phase sessions on two consoles (control-tower phase 59, #83), a session's
PEAK context is:

```
peak ≈ boot floor + work floor + slope × weight          shipped: 121K + 198K + 2.17 × weight
```

- **Boot floor** — the first API call's context: the system prompt, the tool listing, CLAUDE.md, the
  rules, the memory index and the boot prompt, read before any work. It is per REPOSITORY (the two
  consoles measured 121K and 89K), recorded on every `phase.tokens` line as `firstContext`, and
  reported as its own line — by `--session-plan` and on the plan page — because it is the part a
  repository can shrink, and a smaller one lowers every session it will ever run.
- **Work floor** — what every phase session adds above its boot whatever its size: the plan and
  handoff reads, verification, the closeout.
- **Slope** — what the phase's own weight adds.

`boot + work` is the per-session FLOOR (`SESSION_BOOT_FLOOR` + `SESSION_WORK_FLOOR` in `sizing.env`),
paid ONCE by every session. The line goes through the per-size median peaks with every tag weighing
once — median S 325K, M 447K, L 501K, each within 10% of it — and the console re-fits it on its own
sessions (`analysis/sizing-model.ts`). The model it replaced — "real context ≈ 3 × the summed weight" —
was under 107 of 108 audited phases, S peaks ran 21.6× their weight, and `--session-plan` proposed
pairs a lone L already overflowed.

**Sessions per phase — the unit is `1 phase ≥ 1 session`.** Under the console nothing batches, and a
phase that wraps its context (the 60% steer, the 80% checkpoint) takes more than one. So a plan's
forecast in sessions is the sum of what its phases measurably take, by size and by whether they wrap
(`SESSIONS_*` and `WRAP_*` in `sizing.env`, 156 finished phases, each count winsorised at 5):

| Tag | Sessions if it does not wrap | Sessions if it wraps | Phases that wrap | Expected |
|---|---|---|---|---|
| `S` | 1.69 | 2.00 | 7% | 1.71 |
| `M` | 1.46 | 2.78 | 15% | 1.66 |
| `L` | 1.48 | 2.54 | 42% | 1.93 |

The batching forecast this replaced counted 0.35–0.67 sessions a phase; measured use was 1.1–5.0.
`--session-plan` prints the plan's weight as a GENERATED line too — quote it in §Session budget rather
than typing a sum, which is how "790K" came to stand beside 740K.

### Size annotation (optional, drives the engine)

Tag a phase's rough working-set in its `### Phase N` heading block, mirroring the `Gates` convention:

```
### Phase 3 — wire the endpoint
- **Size:** S
```

| Tag | Rough working set | Looks like |
|---|---|---|
| `S` | ≤ ~15K tokens | a focused edit, a config/migration, one small file, a doc |
| `M` (default) | ~15–50K | a typical feature across a few files with some exploration |
| `L` | ~50–120K | a substantial subsystem, heavy exploration, large diffs |

A phase whose predicted peak — the floor plus the slope × its weight — passes the target is too big for
one session: split it (on a 1M window that is past ≈129K of weight, so an `L` fits and an `L` with an `M`
does not; on a 200K window — Haiku, or an unknown model — the shipped floor alone passes the target, and
`--session-plan` says so). Phases with **no** `Size:` tag are treated as `M`. These map to token weights
`S=15K`, `M=40K`, `L=90K` for batch math (kept in sync with `scripts/phase-graph.sh` via
`scripts/sizing.env`).

### What caps a session under Phase Console

Every session the console spawns carries both a dollar and a turn cap (`--max-budget-usd`,
`--max-turns`), and since control-tower phase 59 they are MEASURED, not chosen: each mode's p99 over
the console's own `phase.session` lines of the last two weeks, plus 50%, rounded up — re-derived hourly
as sessions accrue (`deriveCapTable`, `viewer/server/runner/session-record.ts`). A mode with fewer than
twenty sessions in the window takes the table shipped with the release, measured the same way:

| Mode | Dollars | Turns | Measured over (shipped) |
|---|---|---|---|
| `phase` | $120 | 490 | p99 $77.81 over 274 sessions · p99 322 turns over 321, 2026-09-16 → 2026-09-25 |
| `resume` | the phase's | 120 | p99 74 turns over 27 — the resume floor, `RESUME_MIN_TURNS` |

The size tag no longer sets a cap: measured, it did not separate an M's spend from an L's, and the
per-size rows it set ($25/150, $60/300, $120/600 — "about three times the most any measured session
spent") sat under routine M work while never binding an L. A cap binds on a runaway and never on the
p90, and every `phase.session` records each cap's derivation — percentile, headroom, window, samples —
so drift is visible in the ledger. A run's `phaseBudgetUsd` replaces the dollars when it sets one. A
session that continues the phase's work — a resume with an instruction, a wait-resume — gets the same
dollars and what is left of the phase's turns after its earlier sessions, never under 120
(`RESUME_MIN_TURNS`). The sessions around a phase — a closeout, a QA round, a PR session, the reviewer
— get a quarter of the same dollars (never under $1; a QA round's own budget, when the run set one,
wins) and 60 turns (`CLOSEOUT_MAX_TURNS`); a repair gets 90 (`REPAIR_MAX_TURNS`); a side mode's own
measurement can raise its cap, never lower it. A cap that bites is not a failure: the same session is
resumed with that cap doubled (`raiseCap`).

They are a **runner policy**, not a `sizing.env` key: F5 is unchanged — `scripts/sizing.env` stays the
one source for the weights, the budgets and the session model that decide batching and the forecast;
a session's spending cap is the console's, derived from its own sessions.

### Let the engine propose batches

```
scripts/phase-graph.sh <slug> --session-plan opus     # or: haiku · sonnet · fable · 'opus[1m]' (quote it) · a raw number
```

With no argument it sizes for the plan's own `**Target model:**`, as the board and the console do; only
a plan that names none falls back to the ~40K default.

It states its unit first — `1 phase ≥ 1 session` — then the plan's weight as a generated line, the
forecast in sessions from measured sessions per phase, the context model and this repository's boot
floor (a console passes its own measured floor in `PE_BOOT_FLOOR`). Then the batches, which are for a
person driving by hand: it walks the remaining (not-done) phases in dependency order and groups phases
into sessions wherever every dependency is already satisfied inside or before the group and the floor
plus the slope × the summed weight stays under the target — cutting at GATED phases, at unmet
dependencies, and (when QA gating is on) before any phase whose dependency's QA verdict would land in
the same session. The plain board (`scripts/phase-graph.sh <slug>`) also prints a `SUGGESTED BATCHES:`
line when sizes are present. Treat the batches as a **suggestion** — you confirm them against your live
context meter; absent any `Size:` tags every phase is treated as `M`.

## Keep the session lean (so the budget goes further)

- **Offload high-token work to subagents.** Broad code search, multi-file exploration, and independent
  verification can run in an `Agent` subagent (e.g. the read-only `Explore` type) that reads a lot but
  returns only a short summary — the tokens it burns never enter your phase session. This is the
  biggest in-session lever for both cost and rot. (Don't over-delegate: a single-file read or a
  sequential edit is faster done directly.)
- **Don't bust your own cache mid-phase:** keep one model and one effort level for the session, and
  prefer opening a *fresh* session over running `/compact` in the middle of a phase.

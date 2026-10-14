---
slug: guided
created: 2026-10-12
status: active
phases: 3
handoffs: docs/handoffs/guided/
memory: project_guided
---

# Guided steps — a guide file, options, a deadline, and the errands table

A plan's person's turn carries its steps (turn-by-turn phase 2): a `guide:`
file, a decision's `options:` and the `recommended:` one, a `deadline:`, and
the `## Operator errands` table each bullet binds by the "(E-N…)" its text
ends with. Synthetic, in the shape a real plan writes.

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | A decision with options | — | — | r | x |
| 2 | A task with a guide file | 1 | — | r | x |
| 3 | A task bound to its table row | 2 | — | r | x |

## Phases

### Phase 1 — A decision with options
- **Human step:** decision · choose where the nightly build runs (E-1) · options: box=The build box::the box keeps running all night | cloud=The cloud runner::it bills by the minute | skip=Skip it this week · recommended: box · deadline: 2026-10-20T17:00Z · why: decision · effort: 5m
- **Verification:**
  - `true`

### Phase 2 — A task with a guide file
- **Human step:** operator-act · rotate the deploy key on the build box · open: https://example.com/keys · proof: `cmd:"true"` · why: reserved · effort: 10m · unblocks: 3 · guide: docs/guides/rotate-key.md · deadline: 2026-10-21
- **Verification:**
  - `true`

### Phase 3 — A task bound to its table row
- **Human step:** operator-act · prune the old run branches once the mirror is gone (E-3) · open: git branch --list · proof: `cmd:"true"` · why: reserved · window: 7d
- **Verification:**
  - `true`

## Operator errands

Every `!` line runs from `~/work/acme`. A row is due when its `due:` ref lands.

| Id | Phase · issues | What only the owner can do | Exact steps | Expected | How the agent verifies |
|---|---|---|---|---|---|
| E-1 | 1 · acme #12 | choose where the nightly build runs | read the cost note in `docs/build.md`, then pick one | the build runs where you chose | the answer |
| E-2 | 2 · acme #14 | restart the build box after the upgrade | `! bash scripts/box.sh --check` then `! bash scripts/box.sh restart`; then comment `restarted` on acme #14 | `box.sh --check` prints `up` | `! bash scripts/box.sh --check` |
| E-3 | after 3 | prune the old run branches | `! git -C <repo> branch -d pe/guided` per repo (the phase 3 handoff lists them) | `git branch --list 'pe/*'` names nothing of this plan's | the supervisor |
| E-4 | 3 · acme #20 | count the stale tags | `! git tag \| wc -l` before and after | the count falls | `git tag \| wc -l`
| E-5 | — | read the release notes once | open the notes and skim them | nothing | nobody |

- **Human step:** operator-act · restart the build box after the upgrade and comment restarted on acme #14 (E-2) · open: bash scripts/box.sh --check · proof: `cmd:"true"` · where: host · window: 14d · why: reach · due: phase:guided/2
- **Human step:** operator-act · count the stale tags before and after (E-4, hub #105) · proof: `cmd:"true"` · why: reserved

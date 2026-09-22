---
slug: landing
created: 2026-09-18
status: active
phases: 5
handoffs: docs/handoffs/landing/
memory: project_landing
---

# Landing-directive test plan

Exercises the four shapes every 5.1.0 directive has to survive: **plan-only**
(the §Session budget line answers and the source reads `plan`), **phase-only**
(no plan line, so the bullet answers over the engine's default),
**both-disagreeing** (the bullet wins, and the plan line must not leak into a
sibling phase), and **silence** (the engine's own default, tagged `default` so
a console can tell "this plan chose hold" from "this plan never considered
landing").

The `- **Isolation:**` bullet is the one directive with no engine-owned
default: phases 2, 4 and 5 declare it and phases 1 and 3 answer nothing at all,
because a phase that says nothing inherits the RUN and the run is not in this
document.

Phase 1 lands with `pr` from a checkout it shares, which is advisory F28
(`land-needs-lane`) — deliberately, so the advisory has a fixture that is
otherwise clean. `bad-land-word.md` and `bad-landed-gate.md` carry the two
GATING failures, F27 and F29.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~200K weight/session  ·  **Branch:** current branch (no new branch)

**Landing:** pr

**Base branch:** release/5.1

**Gitlink:** leave

**Conflicts:** park

**Clash zones:** `viewer/shared/`, `scripts/phase-graph.sh`

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Takes the plan's word | — | — | r | x |
| 2 | Overrides it | 1 | — | r | x |
| 3 | Holds, and says so | 1 | — | r | x |
| 4 | Lands on the trunk | 2 | — | r | x |
| 5 | Gated on phase 4 landing *(GATED)* | 4 | — | r | x |

## Phases

### Phase 1 — Takes the plan's word
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — Overrides it
- **Size:** S
- **Land:** integrate
- **Gitlink:** bump
- **Isolation:** worktree
- **Verification:**
  - `true`

### Phase 3 — Holds, and says so
- **Size:** S
- **Land:** hold
- **Verification:**
  - `true`

### Phase 4 — Lands on the trunk
- **Size:** S
- **Land:** trunk
- **Isolation:** worktree
- **Verification:**
  - `true`

### Phase 5 — Gated on phase 4 landing *(GATED)*
- **Size:** S
- **Land:** hold
- **Isolation:** worktree
- **Gates (must clear first):** phase 4's work is actually on the trunk.
- **Gate-check:** landed 4
- **Verification:**
  - `true`

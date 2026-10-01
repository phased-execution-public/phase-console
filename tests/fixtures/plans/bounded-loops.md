---
slug: bounded-loops
created: 2026-01-01
status: active
phases: 4
handoffs: docs/handoffs/bounded-loops/
memory: project_bounded-loops
---

# Bounded loops test plan

F16 fixture for the narrowed loop arms (control-tower phase 47, #52): a loop is
a wait only when it holds a clock — a `sleep`, a timed `read`, a `wait`, or a
network verb in its condition or body. Phase 1 counts to twenty and waits on
nothing; phase 2 polls with a sleep; phase 3 is phase 1's loop followed by a
short, separate `sleep 3`, which the loop must not borrow; phase 4 polls a
remote endpoint with no sleep at all. F16 must name phases 2 and 4 only.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Count      | — | — | repoA | counted |
| 2 | Poll       | 1 | — | repoA | polled |
| 3 | Count, nap | 2 | — | repoA | counted |
| 4 | Busy poll  | 3 | — | repoA | polled |

### Phase 1 — Count

- **Verification:**
  - `i=0; while [ $i -lt 20 ]; do printf '%s\n' "$i"; i=$((i+1)); done`

### Phase 2 — Poll

- **Verification:**
  - `until test -f build/done.flag; do sleep 5; done`

### Phase 3 — Count, nap

- **Verification:**
  - `i=0; while [ $i -lt 3 ]; do echo "$i"; i=$((i+1)); done; sleep 3; test -d build`

### Phase 4 — Busy poll

- **Verification:**
  - `until gh run view 42 --json status -q .status | grep -q completed; do :; done`

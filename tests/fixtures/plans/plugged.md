---
slug: plugged
created: 2026-01-01
status: active
phases: 4
handoffs: docs/handoffs/plugged/
memory: project_plugged
---

# Plugin-sets test plan

Carries a `**Plugins:**` line on §Session budget and `- **Plugins:**` bullets on
phases (measured-console phase 27): each phase's set is the plan's kinds unioned
with its own, never with a neighbour's. Phase 2's set is over a 200 K window's
listing budget and names a word that is no kind; phase 3's is larger, on a 1 M
window, and is not.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~1M working set/session  ·  **Branch:** current branch (no new branch)
**Plugins:** docs

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | a | — | — | r | x |
| 2 | b | 1 | — | r | x |
| 3 | c | 1 | — | r | x |
| 4 | d | 1 | — | r | x |

### Phase 1 — a
- **Size:** S
- **Plugins:** review
- **Verification:**
  - `true`

### Phase 2 — b
- **Size:** S
- **Plugins:** `review`, `security`, `ui`, `revew`
- **Verification:**
  - `true`

### Phase 3 — c
- **Size:** S
- **Model:** `claude-opus-5[1m]`
- **Plugins:** review, security, ui, release
- **Verification:**
  - `true`

### Phase 4 — d
- **Size:** S
- **Verification:**
  - `true`

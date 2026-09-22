---
slug: issues
created: 2026-09-18
status: active
phases: 4
handoffs: docs/handoffs/issues/
memory: project_issues
---

# Issues-directive test plan

`**Issues:**` is the outward-write directive, so its fixture is about the one
property that matters most: a phase may only ever narrow. Phase 2 narrows
`file` to `draft`, phase 3 narrows it to `off`, and phase 4 says nothing and
takes the plan's word. The engine does not ENFORCE narrowing — a bullet is a
bullet — but a reader that resolved the wrong way round would let one phase
open the door for a plan that had closed it, and that is what this fixture
would catch.

Phase 1 also carries the `issues` decision row, which is the manifest key added
in 5.1.0.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~200K weight/session  ·  **Branch:** current branch (no new branch)

**Issues:** file

## Decisions

| key | value | owner | state | blocking | source | evidence |
|---|---|---|---|---|---|---|
| `issues` | file — the repository is ours and the sessions are trusted | operator | answered | no | plan | §Session budget |

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Takes the plan's word | — | — | r | x |
| 2 | Narrows to draft | 1 | — | r | x |
| 3 | Closes the door | 1 | — | r | x |
| 4 | Says nothing | 2, 3 | — | r | x |

## Phases

### Phase 1 — Takes the plan's word
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — Narrows to draft
- **Size:** S
- **Issues:** draft
- **Verification:**
  - `true`

### Phase 3 — Closes the door
- **Size:** S
- **Issues:** off
- **Verification:**
  - `true`

### Phase 4 — Says nothing
- **Size:** S
- **Verification:**
  - `true`

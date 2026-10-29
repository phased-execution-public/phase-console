---
slug: amendable
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/amendable/
memory: project_amendable
---

# Amendable test plan

> Created 2026-01-01 for the amend-plan tests: a two-phase chain, a preamble
> blockquote, and sections after `## Phases` that an amendment must stay above.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | repoA | package builds |
| 2 | Beta  | 1 | — | repoA | unit tests pass |

- **Blocking:** `1 → 2`

## Phases

### Phase 1 — Alpha
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — Beta
- **Size:** M
- **Verification:**
  - `true`

## Operator errands

Nothing waits on these.

## End-to-end verification

Run it.

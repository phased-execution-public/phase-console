---
slug: duplicate-phase
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/duplicate-phase/
memory: project_duplicate-phase
---

# Duplicate phase test plan

Phase 1 is headed by TWO `### Phase 1` sections (#228). Every reader files both
under phase 1 and answers the FIRST section's directives; lint F21 fails the plan
`phase-section-repeated`.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | repoA | package builds |
| 2 | Beta  | 1 | — | repoA | unit tests pass |

## Phases

### Phase 1 — Alpha
- **Size:** S
- **Permission mode:** acceptEdits
- **Model:** sonnet
- **Verification:**
  - `true`

### Phase 2 — Beta
- **Verification:**
  - `true`

### Phase 1 — Alpha, written again
- **Size:** L
- **Permission mode:** plan
- **Model:** opus
- **Verification:**
  - `false`

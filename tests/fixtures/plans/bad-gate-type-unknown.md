---
slug: bad-gate-type-unknown
created: 2026-09-14
status: active
phases: 2
handoffs: docs/handoffs/bad-gate-type-unknown/
memory: project_bad-gate-type-unknown
---

# F24 specimen — a Gate-check whose type is not on the list

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Build | — | — | r | x |
| 2 | Release | 1 | — | r | x |

## Phases

### Phase 1 — Build
- **Verification:**
  - `true`

### Phase 2 — Release *(GATED)*
- **Gates (must clear first):** 1. the design is reviewed
- **Gate-check:** review the design
- **Verification:**
  - `true`

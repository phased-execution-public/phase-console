---
slug: bad-gated-no-check
created: 2026-09-14
status: active
phases: 2
handoffs: docs/handoffs/bad-gated-no-check/
memory: project_bad-gated-no-check
---

# F24 specimen — a *(GATED)* heading with no Gate-check directive

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
- **Gates (must clear first):** 1. the operator signs the release
- **Verification:**
  - `true`

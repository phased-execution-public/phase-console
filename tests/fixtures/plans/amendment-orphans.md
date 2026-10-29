---
slug: amendment-orphans
created: 2026-01-01
status: active
phases: 2
handoffs: docs/handoffs/amendment-orphans/
memory: project_amendment-orphans
---

# Amendment orphans (F49)

> *(Amendment 1, 2026-10-28)* Phase 9 — Ghost: names a phase the plan lacks
>
> *(Amendment 3 2026-10-28)* Phase 2 — Beta: a note missing its comma
>
> *(Amendment 4, 2026-10-28)* an amendment that names no phase and has no carrier

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | repoA | package builds |
| 2 | Beta  | 1 | — | repoA | unit tests pass |

## Phases

### Phase 1 — Alpha
- **Size:** S
- **Verification:**
  - `true`
- **Amendment:** 2 (2026-10-28)

### Phase 2 — Beta
- **Size:** M
- **Verification:**
  - `true`

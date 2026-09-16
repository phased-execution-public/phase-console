---
slug: five-column
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/five-column/
memory: project_five-column
---

# Five-column test plan

The canonical table minus the decorative "Parallel-safe with" column — a
perfectly natural thing for an author or a wizard to write. Positionally, Repos
now sits where Exit criteria used to and the Depends-on column has not moved,
which is exactly the shape that used to hand every phase a scope invented out of
its Exit criteria text. Read by NAME it is simply a correct plan, and it must
lint clean.

## Phase graph

| Phase | Title | Depends on | Repos | Exit criteria |
|------:|-------|-----------|-------|---------------|
| 1 | Alpha | — | api | tests pass |
| 2 | Beta  | 1 | api | docs updated |
| 3 | Gamma | 2 | web | deploy succeeds |

## Phases

### Phase 1 — Alpha
- **Verification:**
  - `true`

### Phase 2 — Beta
- **Verification:**
  - `true`

### Phase 3 — Gamma
- **Verification:**
  - `true`


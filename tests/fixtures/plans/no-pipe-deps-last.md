---
slug: no-pipe-deps-last
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/no-pipe-deps-last/
memory: project_no-pipe-deps-last
---

# Depends-on in the last column, and no trailing pipe

The other half of the same defect, and the dangerous half. With `Depends on`
last and no trailing pipe, the header scan never found the column, `di` fell
back to -1, and EVERY phase parsed as having no dependencies — so a board that
should read `1 ready, 2 waiting, 3 waiting` reported all three ready at once
and the engine would happily board work on top of work that had not run.

## Phase graph

| Phase | Title | Repos | Exit criteria | Depends on
|------:|-------|-------|---------------|-----------
| 1 | Alpha | api | tests pass | —
| 2 | Beta | api | docs updated | 1
| 3 | Gamma | web | deploy succeeds | 2

### Phase 1 — Alpha
- **Goal:** the root.
- **Verification:** `true`

### Phase 2 — Beta
- **Goal:** after the root.
- **Verification:** `true`

### Phase 3 — Gamma
- **Goal:** after Beta.
- **Verification:** `true`

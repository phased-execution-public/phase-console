---
slug: bad-empty-verification-open
created: 2026-09-14
status: active
phases: 4
handoffs: docs/handoffs/bad-empty-verification-open/
memory: project_bad-empty-verification-open
---

# F14's specimens — every way a §Verification can hold nothing runnable

Since 5.0.0 F14 is a gate (`verification-empty-open`): an OPEN phase whose
§Verification would extract nothing runnable fails `--lint`. Phase 4 is the
control — it verifies with a real command and must not be named.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Numbers only | — | — | r | x |
| 2 | No bullet at all | 1 | — | r | x |
| 3 | Prose only | 2 | — | r | x |
| 4 | Runnable (control) | 3 | — | r | x |

## Phases

### Phase 1 — Numbers only
- **Verification:**
  - the exit codes seen in the wild were `1` and `128 112 3 12 124`

### Phase 2 — No bullet at all
- **Goal:** ship it.
- **Exit criteria:** 1. shipped

### Phase 3 — Prose only
- **Verification:** ask a person to look at the preview and confirm it renders.

### Phase 4 — Runnable (control)
- **Verification:**
  - `true`

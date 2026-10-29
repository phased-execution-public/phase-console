---
slug: directive-mid-line
created: 2026-10-25
status: active
phases: 3
handoffs: docs/handoffs/directive-mid-line/
memory: project_directive-mid-line
---

# Directives that share a line (#419)

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current
> **Wait budget:** 8h · **Wait count:** 8 · **Verify timeout:** 90m · **Gitlink:** leave · **Issues:** draft · **Messaging:** off
> The conflict word sits after prose, **Conflicts:** park — no reader reads it, and F50 says so.
> A label in backticks is prose too: `**Landing:** pr` is never read, and never named.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Plain | — | — | r | x |
| 2 | A second label inside a bullet | 1 | — | r | x |
| 3 | A bullet of its own | 2 | — | r | x |

## Phases

### Phase 1 — Plain
- **Verification:**
  - `true`

### Phase 2 — A second label inside a bullet
- **Size:** S · **Verify timeout:** 45m
- **Verification:**
  - `true`

### Phase 3 — A bullet of its own
- **Verify timeout:** 30m
- **Wait count:** 3
- **Verification:**
  - `true`

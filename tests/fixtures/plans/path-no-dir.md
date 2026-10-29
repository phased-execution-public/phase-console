---
slug: path-no-dir
created: 2026-10-25
status: active
phases: 3
handoffs: docs/handoffs/path-no-dir/
memory: project_path-no-dir
---

# Paths that name no directory (#402)

The bats suite makes `app/` under the docs root; nothing else exists there.

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | A directory that exists | — | — | app | x |
| 2 | A path that names nothing | 1 | — | nowhere/ | x |
| 3 | A Verify in that names nothing | 2 | — | app | x |

## Phases

### Phase 1 — A directory that exists
- **Verification:**
  - **Verify in:** app
  - `true`

### Phase 2 — A path that names nothing
- **Verification:**
  - `true`

### Phase 3 — A Verify in that names nothing
- **Verification:**
  - **Verify in:** app/missing
  - `true`

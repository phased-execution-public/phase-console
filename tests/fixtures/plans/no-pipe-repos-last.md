---
slug: no-pipe-repos-last
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/no-pipe-repos-last/
memory: project_no-pipe-repos-last
---

# Repos in the last column, and no trailing pipe

GitHub renders a pipe table with or without the trailing `|`, so plenty of
authors (and every markdown formatter that trims trailing whitespace runs)
write one without. The header scan used to walk fields `2 .. NF-1`, which is
right only when a trailing pipe leaves an empty field after the last cell —
without one, the LAST column was never examined.

Here that column is `Repos`, so `--repos` fell back to `all` for every phase:
every phase claimed the whole world, so no two could ever run beside each
other, and the plan silently lost all of its concurrency.

## Phase graph

| Phase | Title | Depends on | Exit criteria | Repos
|------:|-------|-----------|---------------|-------
| 1 | Alpha | — | tests pass | api
| 2 | Beta | 1 | docs updated | api
| 3 | Gamma | 1 | deploy succeeds | web

### Phase 1 — Alpha
- **Goal:** the root.
- **Verification:** `true`

### Phase 2 — Beta
- **Goal:** after the root.
- **Verification:** `true`

### Phase 3 — Gamma
- **Goal:** beside Beta, on another repo.
- **Verification:** `true`

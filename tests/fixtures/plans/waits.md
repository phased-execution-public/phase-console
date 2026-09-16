---
slug: waits
created: 2026-09-14
status: active
phases: 5
handoffs: docs/handoffs/waits/
memory: project_waits
---

# Wait budget — the plan line, the phase bullet, and silence

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current
> **Wait budget:** 12h
> Decoy prose mentioning a wait budget of 99h that must NOT be read as the line.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Plain | — | — | r | x |
| 2 | Waits on a run, bounded | 1 | — | r | x |
| 3 | Waits until a date | 2 | — | r | x |
| 4 | Bare refs, days | 3 | — | r | x |
| 5 | A bullet with no max | 4 | — | r | x |

## Phases

### Phase 1 — Plain
- **Verification:**
  - `true`

### Phase 2 — Waits on a run, bounded
- **Waits on:** `gh:acme/app#run/42` · ~45m
- **Verification:**
  - `true`

### Phase 3 — Waits until a date
- **Waits on:** `date:2026-09-20T06:00:00Z`, `gh:acme/app#pr/7` · 3d
- **Verification:**
  - `true`

### Phase 4 — Bare refs, days
- **Waits on:** lock:other/2, date:2026-09-21T09:00:00Z · 2 days
- **Verification:**
  - `true`

### Phase 5 — A bullet with no max
- **Waits on:** `gh:acme/app#run/43`
- **Verification:**
  - `true`

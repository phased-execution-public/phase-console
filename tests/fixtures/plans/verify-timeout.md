---
slug: verify-timeout
created: 2026-09-26
status: active
phases: 4
handoffs: docs/handoffs/verify-timeout/
memory: project_verify-timeout
---

# Verify timeout — the plan line, the phase bullet, and silence

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current
> **Verify timeout:** 45m
> Decoy prose mentioning a verify timeout of 99m that must NOT be read as the line.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Plain | — | — | r | x |
| 2 | A slow suite | 1 | — | r | x |
| 3 | Hours, unbolded | 2 | — | r | x |
| 4 | An unreadable bullet | 3 | — | r | x |

## Phases

### Phase 1 — Plain
- **Verification:**
  - `true`

### Phase 2 — A slow suite
- **Verify timeout:** 90m — the full bats suite under autopilot load
- **Verification:**
  - `true`

### Phase 3 — Hours, unbolded
- Verify timeout: 2h
- **Verification:**
  - `true`

### Phase 4 — An unreadable bullet
- **Verify timeout:** soon
- **Verification:**
  - `true`

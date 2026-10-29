---
slug: verification-tier
created: 2026-10-26
status: active
phases: 4
handoffs: docs/handoffs/verification-tier/
memory: project_verification-tier
---

# Verification tier — the plan line, the phase bullet, and silence

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current
> **Verification tier:** impact
> Decoy prose: a verification tier of full must NOT be read as the line.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Plain | — | — | r | x |
| 2 | A release | 1 | — | r | x |
| 3 | Unbolded, upper case | 2 | — | r | x |
| 4 | An unreadable bullet | 3 | — | r | x |

## Phases

### Phase 1 — Plain
- **Verification:**
  - `true`

### Phase 2 — A release
- **Verification tier:** full — the release verifies everything
- **Verification:**
  - `true`

### Phase 3 — Unbolded, upper case
- Verification tier: IMPACT
- **Verification:**
  - `true`

### Phase 4 — An unreadable bullet
- **Verification tier:** sometimes
- **Verification:**
  - `true`

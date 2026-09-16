---
slug: credentials
created: 2026-09-14
status: active
phases: 4
handoffs: docs/handoffs/credentials/
memory: project_credentials
---

# Credentials directive — the MCP shapes, verbatim

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current
> **Credentials:** `gh`, `claude-login`
> **Credential policy:** require
> **Accounts:** `default:20`, `work:10`, `spare`
> **QA exhausted:** `waive`
> Decoy prose with a backticked `credential v2` token that must NOT be read as an id.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Plain | — | — | r | x |
| 2 | Adds one | 1 | — | r | x |
| 3 | Carves out | 2 | — | r | x |
| 4 | Repeats the plan's | 3 | — | r | x |

## Phases

### Phase 1 — Plain
- **Verification:**
  - `true`

### Phase 2 — Adds one
- **Credentials:** `npm-token`, `gh`
- **Person-check:** allow
- **Verification:**
  - `true`

### Phase 3 — Carves out
- **Credential policy:** continue
- **Person-check:** **dev-lead** — they know the UI
- **Verification:**
  - `true`

### Phase 4 — Repeats the plan's
- **Credentials:** `gh`
- **Credential policy:** whenever
- **Person-check:** Halt.
- **Verification:**
  - `true`

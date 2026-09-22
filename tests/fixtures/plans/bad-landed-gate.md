---
slug: bad-landed-gate
created: 2026-09-18
status: active
phases: 2
handoffs: docs/handoffs/bad-landed-gate/
memory: project_bad_landed_gate
---

# A landing gate on a phase that does not exist (F29)

A `landed 99` gate on a two-phase plan can never clear: the ledger has no row
for phase 99 and never will, so the gate reads as blocked for ever and looks
exactly like a phase that has simply not landed yet.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~200K weight/session

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | First | — | — | r | x |
| 2 | Gated on a ghost *(GATED)* | 1 | — | r | x |

## Phases

### Phase 1 — First
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — Gated on a ghost *(GATED)*
- **Size:** S
- **Gates (must clear first):** phase 99 landed.
- **Gate-check:** landed 99
- **Verification:**
  - `true`

---
slug: amended
created: 2026-01-01
status: active
phases: 4
handoffs: docs/handoffs/amended/
memory: project_amended
---

# Amended test plan

> Created 2026-01-01. Phase 3 came in by amend-plan.sh; phase 4's graph row is
> GATED and its section is not written yet (#416), so its gate fails closed.
>
> *(Amendment 1, 2026-10-28)* Phase 3 — Gamma: cover the gap (from deferred D-7)

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | repoA | package builds |
| 2 | Beta  | 1 | — | repoA | unit tests pass |
| 3 | Gamma | 2 | — | repoA | TODO |
| 4 | Delta *(GATED)* | 3 | — | repoA | TODO |

## Phases

### Phase 1 — Alpha
- **Size:** S
- **Out of scope:** the payment rail.
- **Verification:**
  - `true`

### Phase 2 — Beta
- **Size:** M
- **Out of scope:** the queue screens
  - nothing under `client/`
    the release scripts
- **Verification:**
  - `true`

### Phase 3 — Gamma
- **Goal:** cover the gap
- **Size:** M
- **Verification:**
  - `true`
- **Amendment:** 1 (2026-10-28) · from D-7

## Not yet specified

- Phase 3's exit criteria are a placeholder.
-   the retry policy for Gamma

## End-to-end verification

Run it.

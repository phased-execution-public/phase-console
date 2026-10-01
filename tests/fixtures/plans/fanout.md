---
slug: fanout
created: 2026-01-01
status: active
phases: 5
handoffs: docs/handoffs/fanout/
memory: project_fanout
---

# Fan-out test plan

One root unblocks three siblings that differ where real siblings do: one brings a
stack up, one is gated, one works in another repository under a model of its own.
Phase 5 stands apart and is done first, so it can leave notes for the three.

## Session budget

> **Target model:** `claude-opus-5-5[1m]`
>
> **Skills (every session):** `tdd`

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Root  | —    | 5       | core | builds |
| 2 | Stack | 1    | 3, 4    | core | builds |
| 3 | Gate  | 1    | 2, 4    | core | builds |
| 4 | Model | 1    | 2, 3    | site | builds |
| 5 | Aside | —    | 1       | docs | builds |

## Phases

### Phase 1 — Root
- **Verification:**
  - `true`

### Phase 2 — Stack
- **Size:** L
- **Setup:** `npm ci`
- **Verification:**
  - `true`

### Phase 3 — Gate *(GATED)*
- **Gates (must clear first):** the fixture's condition holds
- **Gate-check:** ai the fixture's condition holds
- **Verification:**
  - `true`

### Phase 4 — Model
- **Size:** S
- **Model:** `claude-sonnet-5`
- **Verification:**
  - `true`

### Phase 5 — Aside
- **Verification:**
  - `true`

---
slug: model-policy
created: 2026-09-24
status: active
phases: 4
handoffs: docs/handoffs/model-policy/
memory: project_model_policy
---

# Model-policy test plan

Carries a plan-wide `**Model policy:**` line and a mix of per-phase
`- **Model policy:**` bullets (control-tower phase 54, #91). A model policy is
ONE answer, so the more specific statement wins — the phase's bullet overrides
the plan's line — and a word that is not a policy falls through to the plan's.

## Session budget
> **Target model:** `claude-opus-5-5[1m]` · **Budget:** ~200K weight/session · **Branch:** current branch (no new branch)
>
> **Model policy:** pinned

A sentence here that says the model policy of a phase is up to its author is
prose, not a directive.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Inherits the plan's | — | 2 | r | x |
| 2 | Lets the ladder move it | — | 1 | r | x |
| 3 | Says something that is not a policy | 1, 2 | — | r | x |
| 4 | Restates it in bold and case | 3 | — | r | x |

## Phases

### Phase 1 — Inherits the plan's
- **Size:** S
- **Model:** claude-opus-5-5[1m]
- **Verification:**
  - `true`

### Phase 2 — Lets the ladder move it
- **Size:** S
- **Model policy:** ladder
- **Verification:**
  - `true`

### Phase 3 — Says something that is not a policy
- **Size:** S
- **Model policy:** frozen
- **Verification:**
  - `true`

### Phase 4 — Restates it in bold and case
- **Size:** S
- **Model policy:** **Pinned**
- **Verification:**
  - `true`

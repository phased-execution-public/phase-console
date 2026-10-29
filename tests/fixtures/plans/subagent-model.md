---
slug: subagent-model
created: 2026-10-25
status: active
phases: 5
handoffs: docs/handoffs/subagent-model/
memory: project_subagent_model
---

# Subagent-model, fast-gate and may-delete-tests test plan

Carries a plan-wide `**Subagent model:**` line (quoted, the way §Session
budget lines may be) and the three per-phase bullets measured-console phase 6
adds: `- **Subagent model:**` over the plan's line, and `- **Fast gate:**` and
`- **May delete tests:**`, which have no plan level and a default of their own.
A word off a bullet's vocabulary is silence: the next level answers.

## Session budget
> **Target model:** `claude-opus-5-5[1m]` · **Budget:** ~200K weight/session · **Branch:** current branch (no new branch)
>
> **Subagent model:** `claude-sonnet-5-5` (the explorers and the reviewers)

A sentence here that says the subagent model of a phase is up to its author
is prose, not a directive.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Inherits the plan's and the defaults | — | 2 | r | x |
| 2 | Says all three | — | 1 | r | x |
| 3 | Says something that is not a word | 1, 2 | — | r | x |
| 4 | Restates them in bold and case | 3 | — | r | x |
| 5 | Turns the defaults on explicitly | 4 | — | r | x |

## Phases

### Phase 1 — Inherits the plan's and the defaults
- **Size:** S
- **Model:** claude-opus-5-5[1m]
- **Verification:**
  - `true`

### Phase 2 — Says all three
- **Size:** S
- **Subagent model:** claude-haiku-4-5
- **Fast gate:** off
- **May delete tests:** yes — the old suite this phase replaces
- **Verification:**
  - `true`

### Phase 3 — Says something that is not a word
- **Size:** S
- **Subagent model:**
- **Fast gate:** maybe
- **May delete tests:** perhaps
- **Verification:**
  - `true`

### Phase 4 — Restates them in bold and case
- **Size:** S
- **Subagent model:** **`claude-opus-5-5[1m]`** for the reviewers
- **Fast gate:** **OFF**
- **May delete tests:** **Yes**.
- **Verification:**
  - `true`

### Phase 5 — Turns the defaults on explicitly
- **Size:** S
- **Fast gate:** on
- **May delete tests:** no
- **Verification:**
  - `true`

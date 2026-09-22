---
slug: messaging
created: 2026-09-18
status: active
phases: 3
handoffs: docs/handoffs/messaging/
memory: project_messaging
---

# Messaging-directive test plan

`**Messaging:**` is plan-wide and has no per-phase form: whether the sessions of
a run may talk to each other is a property of the run, not of one phase inside
it. So this plan's job is to prove the three things a plan-wide directive has
to get right — the line is read, an unbolded spelling still reads, and the arm
REFUSES a phase argument rather than quietly ignoring it.

Phase 3 carries a `- **Messaging:** off` bullet that must be ignored entirely:
a reader that honoured it would let one phase silently turn off a run-wide
transport the other phases are relying on.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~200K weight/session  ·  **Branch:** current branch (no new branch)

messaging: off

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | First | — | — | r | x |
| 2 | Second | 1 | — | r | x |
| 3 | Says something it may not say | 1 | — | r | x |

## Phases

### Phase 1 — First
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — Second
- **Size:** S
- **Verification:**
  - `true`

### Phase 3 — Says something it may not say
- **Size:** S
- **Messaging:** on
- **Verification:**
  - `true`

---
slug: checkout
created: 2026-08-31
status: active
phases: 4
handoffs: docs/handoffs/checkout/
memory: project_checkout
---

# Checkout-directive test plan

Carries the per-phase `- **Checkout:** <branch>` bullet in the shapes a person
writes it, so `--checkout` must emit the value verbatim (bold and backticks
stripped), empty for a phase without one, and empty — status 0 — with no phase
argument at all.

Phase 4 writes the bullet unbolded with an asterisk marker: the engine's reader
is deliberately bold-optional (like the MCP family). The JS field reader is
stricter — bold required — and that asymmetry is pinned on its side in
`viewer/test/parse.test.ts`.

Phases 1, 3 and 4 also each carry a `- **Wall-clock floor:**` bullet — two
readable spellings and one unreadable value — and, unlike `Checkout`, this
reader IS bold-optional on both sides of the parser (Phase 4's unbolded
`wall-clock floor:` line reads the same as a bolded one). Phase 2 carries none,
doubling as the "this phase has no floor" case.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~200K weight/session  ·  **Branch:** current branch (no new branch)

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Detaches | — | — | r | x |
| 2 | Says nothing | 1 | — | r | x |
| 3 | Documents a branch | 1 | — | r | x |
| 4 | Unbolded | 2, 3 | — | r | x |

## Phases

### Phase 1 — Detaches
- **Size:** S
- **Checkout:** main
- **Wall-clock floor:** 95 min — a full gates.sh run
- **Verification:**
  - `true`

### Phase 2 — Says nothing
- **Size:** S
- **Verification:**
  - `true`

### Phase 3 — Documents a branch
- **Size:** S
- **Checkout:** `release/2.0`
- **Wall-clock floor:** 1h 30m
- **Verification:**
  - `true`

### Phase 4 — Unbolded
- **Size:** S
* checkout: master
* wall-clock floor: soon
- **Verification:**
  - `true`

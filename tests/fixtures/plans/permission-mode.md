---
slug: permission-mode
created: 2026-09-23
status: active
phases: 5
handoffs: docs/handoffs/permission-mode/
memory: project_permission_mode
---

# Permission-mode test plan

Carries a plan-wide `**Permission mode:**` line and a mix of per-phase
`- **Permission mode:**` bullets. A permission mode is ONE answer, so the more
specific statement wins — the phase's bullet overrides the plan's line, exactly
as `- **MCP policy:**` does and `- **MCP:**` deliberately does not.

Phase 4 is the one the lint exists for: a word that is not a mode must fail the
plan by name, never be read as "no opinion" and quietly run the phase in
whatever the run happens to default to.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~1M working set/session  ·  **Branch:** current branch (no new branch)
**Permission mode:** plan

The prose here is the coercion regression: a sentence that mentions plan mode,
or says the permission mode of a phase is up to its author, is not a directive.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Inherits the plan's | — | 2 | r | x |
| 2 | Overrides it | — | 1 | r | x |
| 3 | Restates it | 1, 2 | — | r | x |
| 4 | Says something that is not a mode | 3 | — | r | x |
| 5 | Backticks and case | 4 | — | r | x |

## Phases

### Phase 1 — Inherits the plan's
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — Overrides it
- **Size:** S
- **Permission mode:** acceptEdits
- **Verification:**
  - `true`

### Phase 3 — Restates it
- **Size:** S
- **Permission mode:** plan
- **Verification:**
  - `true`

### Phase 4 — Says something that is not a mode
- **Size:** S
- **Permission mode:** whenever
- **Verification:**
  - `true`

### Phase 5 — Backticks and case
- **Size:** S
- **Permission mode:** `DontAsk`
- **Verification:**
  - `true`

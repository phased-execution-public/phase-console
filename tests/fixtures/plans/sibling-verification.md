---
slug: sibling-verification
created: 2026-08-23
status: active
phases: 3
handoffs: docs/handoffs/sibling-verification/
memory: project_sibling-verification
---

# Sibling verification test plan

The other way people write a §Verification list: the commands are bullets at
**column 0**, siblings of the `- **Verification:**` label rather than nested
under it. `nested-verification.md` covers the indented shape; this covers the
flat one, and the two must read identically.

The engine has always accepted it — `_verification_reach` takes every
backtick-carrying line from the Verification bullet to the end of the phase
block, whatever its indent — so F14 stays silent here. The JS side used to
close the field on the first un-indented sibling and throw the line away, so
`plan.phases[N].verification` came back EMPTY and the runner's preflight parked
the phase with "the console could not read a runnable command out of it"
(parse-recovery-2). One plan, two answers, and the disagreement only showed up
at boarding time.

Phase 3 is the negative control: no Verification bullet at all, so F14 warns and
both sides agree there is nothing to run.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Flat     | —    | 2 | api-server | green |
| 2 | Mixed    | —    | 1 | web-app    | green |
| 3 | Bare     | 1, 2 | — | all        | shipped |

**Blocking:** {1, 2} → 3.
**Independent:** 1 ∥ 2 (disjoint scopes).

## Phases

### Phase 1 — Flat
- **Goal:** commands as un-indented siblings of the label.
- **Size:** S
- **Exit criteria:**
  1. Both parsers find two commands.
- **Verification:**
- `pytest -q`
- `task audit:schema`
- **Handoff must record:** that the flat shape parsed.

### Phase 2 — Mixed
- **Goal:** a nested `Verify in:` followed by flat command siblings.
- **Size:** S
- **Exit criteria:**
  1. The directive and the commands survive together.
- **Verification:**
  - **Verify in:** web-app
- `npm test`
- `npm run lint`

### Phase 3 — Bare
- **Goal:** ship it — deliberately no verification bullet (F14's specimen).
- **Size:** S
- **Exit criteria:** 1. shipped

## End-to-end verification

`true`

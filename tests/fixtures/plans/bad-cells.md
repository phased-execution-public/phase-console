---
slug: bad-cells
created: 2026-01-01
status: active
phases: 4
handoffs: docs/handoffs/bad-cells/
memory: project_bad-cells
---

# Bad-cells test plan

Every cell-level silence F21 exists to break, in one table:

- phase `08` is zero-padded — a legal-looking number that bash reads as invalid
  octal, so it used to vanish from the board and take its dependents with it;
- phase 3's Depends-on cell is `2-`, a half-deleted range, and phase 4's is
  `4-2`, written high-to-low — both were discarded in silence, which made the
  phase report READY before the work it depends on had run;
- phase 2 appears twice, and the second row's dependencies used to overwrite the
  first's while the phase number stayed in the list twice.

The board must still be RIGHT (the numbers normalise, the first row of a
duplicate wins) and the lint must still FAIL, naming each one.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Alpha | — | — | repoA | package builds |
| 2 | Beta  | 1 | — | repoA | unit tests pass |
| 2 | Beta again | — | — | repoA | duplicated row |
| 3 | Gamma | 2- | — | repoA | deploy succeeds |
| 08 | Delta | 3 | — | repoA | padded number |
| 4 | Epsilon | 4-2 | — | repoA | descending range |

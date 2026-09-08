---
slug: bad-no-repos
created: 2026-01-01
status: active
phases: 3
handoffs: docs/handoffs/bad-no-repos/
memory: project_bad-no-repos
---

# No-Repos-column test plan

A table with no Repos column at all. Every phase reads as scope `all`, which
serializes the whole plan and is very probably not what the author meant — F20
says so instead of letting it pass as a healthy plan.

## Phase graph

| Phase | Title | Depends on | Exit criteria |
|------:|-------|-----------|---------------|
| 1 | Alpha | — | tests pass |
| 2 | Beta  | 1 | docs updated |
| 3 | Gamma | 2 | deploy succeeds |

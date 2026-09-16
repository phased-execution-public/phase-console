---
slug: bad-decision-unowned
created: 2026-09-14
status: active
phases: 1
handoffs: docs/handoffs/bad-decision-unowned/
memory: project_bad-decision-unowned
---

# F25 specimens — an outstanding row nobody owns, a key outside the vocabulary, a state outside the three, a source outside the four

## Decisions

| key | value | owner | state | blocking | source | evidence |
|---|---|---|---|---|---|---|
| `credentials` | | | outstanding | yes | plan | |
| `gates` | delegated | operator | answered | no | plan | |
| `gate` | a typo for gates | operator | answered | no | plan | |
| `relay` | off | operator | decided | no | plan | |
| `stop` | keep-going | operator | answered | no | guess | |

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Build | — | — | r | x |

## Phases

### Phase 1 — Build
- **Verification:**
  - `true`

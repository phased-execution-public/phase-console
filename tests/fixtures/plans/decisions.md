---
slug: decisions
created: 2026-09-14
status: active
phases: 3
handoffs: docs/handoffs/decisions/
memory: project_decisions
---

# The decision manifest — parity fixture

Every one of the seventeen keys, in a deliberately noisy table: bold cells,
backticked cells, an `outstanding` row WITH an owner (legal), a `waived` row,
`TRUE` for blocking, and a phase-scoped row. Phase 3 is `*(GATED)*` with NO
Gate-check directive, so `--gate-kind 3` must answer the default (`ai`) in
both engines — and `--lint` must name it.

## Session budget

> **Target model:** `claude-opus-5[1m]` · **Budget:** ~200K · **Branch:** current
>
> **Credentials:** `gh`, `npm-token` · **Credential policy:** require
>
> **Accounts:** `default:20`, `work:35`, `spare`

## Decisions

Prose before the table is ignored by both readers.

| key | value | owner | state | blocking | source | evidence | phase |
|---|---|---|---|---|---|---|---|
| `permission.policy` | the console's `guarded` profile | operator | answered | yes | plan | decision 3 | |
| `permission.destructive` | deny; nothing publishes | operator | answered | yes | plan | | |
| **`credentials`** | `gh`, `npm-token` | operator | **answered** | TRUE | plan | errand E7 | — |
| `accounts` | `default` at 20 % | operator | answered | yes | plan | | |
| `mcp` | none | operator | answered | no | plan | | |
| `gates` | delegated | operator | answered | no | plan | | |
| `verification.person-check` | halt | operator | answered | no | plan | | |
| `qa.exhausted` | QA is off on this plan | operator | waived | no | plan | decision 4 | |
| `waits` | | dev-lead | outstanding | yes | plan | to be bounded | |
| `waits` | `gh:acme/widgets#run/1` · 45m | dev-lead | answered | yes | plan | phase 2's CI | 2 |
| `human-acts` | E5 publish | operator | answered | yes | plan | | |
| `ambiguity` | ruling | policy | answered | no | default | chapter 13 | |
| `budgets` | $150 / $300 | operator | answered | no | plan | | |
| `resume.on-restart` | continue | policy | answered | no | default | | |
| `plan-health` | advisories gate | operator | answered | no | plan | | |
| `stop` | keep-going | operator | answered | no | plan | | |
| `relay` | off | operator | answered | yes | plan | | |
| `announce` | needs-you, halted | operator | answered | no | plan | E2 | |

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Build | — | — | r | x |
| 2 | Ship (waits on CI) | 1 | — | r | x |
| 3 | Undeclared gate *(GATED)* | 2 | — | r | x |

## Phases

### Phase 1 — Build
- **Credentials:** `docker-hub`
- **Verification:**
  - `true`

### Phase 2 — Ship (waits on CI)
- **Credential policy:** continue
- **Verification:**
  - `true`

### Phase 3 — Undeclared gate *(GATED)*
- **Gates (must clear first):** 1. someone looks at it
- **Verification:**
  - `true`

---
slug: operator-acts
created: 2026-10-05
status: active
phases: 3
handoffs: docs/handoffs/operator-acts/
memory: project_operator_acts
---

# Operator acts — a person's task, due when its ref lands

An act only the operator does is a human step of kind `operator-act`; a `due:`
ref keeps it *Coming up* until it lands (control-tower phase 121). The plan's
own acts live under `## Operator errands`, as phase 0. Prose that says the
operator must restart something is not a directive.

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current
>
> **Wait count:** 6

## Operator errands

- **E1 — restart the hub once the release is out.** The bullet below is the act itself.
- **Human step:** operator-act · restart the hub console on the new build · open: `phase-console update hub --when-idle` · proof: `cmd:"curl -sf http://127.0.0.1:4123/api/state"` · due: `phase:operator-acts/2`

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Build | — | — | r | x |
| 2 | Release | 1 | — | r | x |
| 3 | Announce | 2 | — | r | x |

## Phases

### Phase 1 — Build
- **Goal:** build it; the session may declare up to eight waits.
- **Wait count:** 8
- **Verification:**
  - `true`

### Phase 2 — Release
- **Goal:** cut the release; a person pushes the tag once the build is green.
- **Human step:** operator-act · push the release tag · open: `git push origin v1.0.0` · proof: `gh:acme/app#run/42` · where: any · due: `date:2026-10-06T09:00:00Z`
- **Verification:**
  - `true`

### Phase 3 — Announce
- **Goal:** tell people; a sign-in with no due date is due at once.
- **Human step:** browser-login · sign the gh CLI in · open: `gh auth login --web` · proof: `cmd:"gh auth status"`
- **Verification:**
  - `true`

---
slug: commented-human-step
created: 2026-10-17
status: active
phases: 2
handoffs: docs/handoffs/commented-human-step/
memory: project_commented_human_step
---

# Commented human steps — a bullet inside an HTML comment is no step

`templates/plan.md` teaches the Human step grammar with an example bullet
inside an HTML comment (#346, one-pool phase 14). Neither engine reads a bullet
there as a step, and no lint sees one: a comment on one line, one across
several lines, one trailing a real bullet, and one that is never closed.
Read as steps, every commented bullet below would fail the lint.

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | A comment on one line | — | — | r | x |
| 2 | A comment across lines | 1 | — | r | x |

## Phases

### Phase 1 — A comment on one line
<!-- - **Human step:** browser-login · <what> · open: <url or command> · proof: <ref> · where: host|any · window: <duration> -->
- **Human step:** browser-login · sign the gh CLI in to the org · open: `gh auth login --web` · proof: `cmd:"gh auth status"` · why: identity <!-- a note the reader never sees -->
- **Verification:**
  - `true`

### Phase 2 — A comment across lines
<!--
The superseded spelling, an unknown kind and an errand's bullet, all commented out:
- **Human step:** the owner signs the release, proof: the tag
- **Human step:** credential · paste a token · proof: `cmd:"true"`
- **Human step:** operator-act · restart the build box (E-2) · proof: `cmd:"true"` · why: reserved
-->
- **Human step:** operator-act · rotate the deploy key (E-1) · open: https://example.com/keys · proof: `cmd:"true"` · why: reserved
- **Verification:**
  - `true`

## Operator errands

| Id | Phase · issues | What only the owner can do | Exact steps | Expected | How the agent verifies |
|---|---|---|---|---|---|
| E-1 | 2 | rotate the deploy key | open the keys page and rotate it | the old key is refused | the step's proof |
| E-2 | 2 | restart the build box | restart it from its console | it answers again | nobody |

<!-- - **Human step:** operator-act · restart the build box (E-2) · proof: `cmd:"true"` · why: reserved -->
<!-- a note never closed: everything below it is a comment
- **Human step:** decision · never asked · options: a=A

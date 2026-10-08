---
slug: turn
created: 2026-10-06
status: active
phases: 2
handoffs: docs/handoffs/turn/
memory: project_turn
---

# Your turn — a reason, the minutes, what it unblocks, a guide

A plan's person's turn says why only a person fits it (control-tower phase
130). A bullet with no `why:` is given its kind's default and advised about.

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Every new field | — | — | r | x |
| 2 | No reason: inferred, advised | 1 | — | r | x |

## Phases

### Phase 1 — Every new field
- **Human step:** browser-login · sign the gh CLI in · open: `gh auth login` · proof: `cmd:"gh auth status"` · why: identity · effort: 5m · unblocks: 2,03 · guide: `guides/gh-sign-in.md`
- **Human step:** decision · pick the region · why: Money · effort: 1h
- **Verification:**
  - `true`

### Phase 2 — No reason: inferred, advised
- **Human step:** operator-act · restart the box · open: `sudo systemctl restart app` · proof: `cmd:"true"`
- **Verification:**
  - `true`

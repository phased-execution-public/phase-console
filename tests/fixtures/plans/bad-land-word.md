---
slug: bad-land-word
created: 2026-09-18
status: active
phases: 2
handoffs: docs/handoffs/bad-land-word/
memory: project_bad_land_word
---

# A plan whose landing words are not words (F27)

Both levels are wrong, so both must be named: the plan-wide `**Landing:**` line
says `sometimes` and phase 2's bullet says `yes`. Every reader falls THROUGH an
unrecognised word — which is right for a reader, since a typo must not silently
become a policy — and `land-word-unknown` is the only thing that ever says so.

## Session budget
**Target model:** `claude-opus-5`  ·  **Budget:** ~200K weight/session

**Landing:** sometimes

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | First | — | — | r | x |
| 2 | Second | 1 | — | r | x |

## Phases

### Phase 1 — First
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — Second
- **Size:** S
- **Land:** yes
- **Issues:** maybe
- **Verification:**
  - `true`

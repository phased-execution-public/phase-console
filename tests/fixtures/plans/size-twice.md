---
slug: size-twice
created: 2026-08-23
status: active
phases: 4
handoffs: docs/handoffs/size-twice/
memory: project_size-twice
---

# Size-bullet anchoring test plan

A `**Size:**` bullet that says the word "size" more than once, which is what an
author does the moment they justify the letter they chose.

`phase_size` reads the letter with `sed -E 's/.*[Ss]ize[^A-Za-z]*([A-Za-z]).*/\1/'`,
whose leading `.*` is greedy — so it anchors on the LAST occurrence and reads
whatever follows *that*. The JS reader used a non-anchored regex and took the
FIRST (parse-recovery-6). On an ordinary bullet the two agree; on these they did
not, and a plan the engine batched at M was drawn and forecast at L.

The letters below are therefore deliberately NOT what a careless reader expects:

- Phase 1 — `L (sized against opus)`: the last "size" is inside "sized", the
  next letter is `d`, and `d` is not S/M/L, so **both sides read M**.
- Phase 2 — `S — resized after the audit`: last "size" is inside "resized",
  next letter `d` → **M**.
- Phase 3 — `L`, said once → **L**. The control.
- Phase 4 — `size: M (the size we agreed)`: last "size" is followed by ` we`,
  so the letter is `w` → **M**, arrived at by a different route than phase 3.

The point of the fixture is not the letters themselves — it is that ONE rule
produces them on both sides.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Justified   | —  | 2 | api-server | green |
| 2 | Revised     | —  | 1 | api-server | green |
| 3 | Plain       | 1  | — | api-server | green |
| 4 | Restated    | 2  | — | api-server | green |

**Blocking:** 1 → 3, 2 → 4.
**Independent:** 1 ∥ 2 (same repo — serialize, never parallel).

## Phases

### Phase 1 — Justified
- **Goal:** the letter is followed by a parenthetical that repeats the word.
- **Size:** L (sized against opus)
- **Exit criteria:**
  1. Both readers agree.
- **Verification:**
  - `true`

### Phase 2 — Revised
- **Goal:** the word appears again after an em-dash.
- **Size:** S — resized after the audit
- **Exit criteria:**
  1. Both readers agree.
- **Verification:**
  - `true`

### Phase 3 — Plain
- **Goal:** the control — the word said exactly once.
- **Size:** L
- **Exit criteria:**
  1. Both readers agree.
- **Verification:**
  - `true`

### Phase 4 — Restated
- **Goal:** the word repeated after the letter, without punctuation between.
- **Size:** M (the size we agreed)
- **Exit criteria:**
  1. Both readers agree.
- **Verification:**
  - `true`

## End-to-end verification

`true`

---
slug: scale-72
created: 2026-09-24
status: active
phases: 72
handoffs: docs/handoffs/scale-72/
memory: project_scale-72
---

# Plan-read scale fixture — 72 phases, three dependency edges each

The size the console now reads every day (#44, #58): 72 phases, where every phase
depends on the three before it, so the graph has roughly three times as many
edges as phases. The plan gates on QA; phases 20 and 50 turn QA off for
themselves and phases 10 and 40 say `on` explicitly. `plan-read-scale.bats`
counts the `awk` processes one `--memory-block` read costs over it.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Step 1 | — | — | r | step 1 builds |
| 2 | Step 2 | 1 | — | r | step 2 builds |
| 3 | Step 3 | 1, 2 | — | r | step 3 builds |
| 4 | Step 4 | 1, 2, 3 | — | r | step 4 builds |
| 5 | Step 5 | 2, 3, 4 | — | r | step 5 builds |
| 6 | Step 6 | 3, 4, 5 | — | r | step 6 builds |
| 7 | Step 7 | 4, 5, 6 | — | r | step 7 builds |
| 8 | Step 8 | 5, 6, 7 | — | r | step 8 builds |
| 9 | Step 9 | 6, 7, 8 | — | r | step 9 builds |
| 10 | Step 10 | 7, 8, 9 | — | r | step 10 builds |
| 11 | Step 11 | 8, 9, 10 | — | r | step 11 builds |
| 12 | Step 12 | 9, 10, 11 | — | r | step 12 builds |
| 13 | Step 13 | 10, 11, 12 | — | r | step 13 builds |
| 14 | Step 14 | 11, 12, 13 | — | r | step 14 builds |
| 15 | Step 15 | 12, 13, 14 | — | r | step 15 builds |
| 16 | Step 16 | 13, 14, 15 | — | r | step 16 builds |
| 17 | Step 17 | 14, 15, 16 | — | r | step 17 builds |
| 18 | Step 18 | 15, 16, 17 | — | r | step 18 builds |
| 19 | Step 19 | 16, 17, 18 | — | r | step 19 builds |
| 20 | Step 20 | 17, 18, 19 | — | r | step 20 builds |
| 21 | Step 21 | 18, 19, 20 | — | r | step 21 builds |
| 22 | Step 22 | 19, 20, 21 | — | r | step 22 builds |
| 23 | Step 23 | 20, 21, 22 | — | r | step 23 builds |
| 24 | Step 24 | 21, 22, 23 | — | r | step 24 builds |
| 25 | Step 25 | 22, 23, 24 | — | r | step 25 builds |
| 26 | Step 26 | 23, 24, 25 | — | r | step 26 builds |
| 27 | Step 27 | 24, 25, 26 | — | r | step 27 builds |
| 28 | Step 28 | 25, 26, 27 | — | r | step 28 builds |
| 29 | Step 29 | 26, 27, 28 | — | r | step 29 builds |
| 30 | Step 30 | 27, 28, 29 | — | r | step 30 builds |
| 31 | Step 31 | 28, 29, 30 | — | r | step 31 builds |
| 32 | Step 32 | 29, 30, 31 | — | r | step 32 builds |
| 33 | Step 33 | 30, 31, 32 | — | r | step 33 builds |
| 34 | Step 34 | 31, 32, 33 | — | r | step 34 builds |
| 35 | Step 35 | 32, 33, 34 | — | r | step 35 builds |
| 36 | Step 36 | 33, 34, 35 | — | r | step 36 builds |
| 37 | Step 37 | 34, 35, 36 | — | r | step 37 builds |
| 38 | Step 38 | 35, 36, 37 | — | r | step 38 builds |
| 39 | Step 39 | 36, 37, 38 | — | r | step 39 builds |
| 40 | Step 40 | 37, 38, 39 | — | r | step 40 builds |
| 41 | Step 41 | 38, 39, 40 | — | r | step 41 builds |
| 42 | Step 42 | 39, 40, 41 | — | r | step 42 builds |
| 43 | Step 43 | 40, 41, 42 | — | r | step 43 builds |
| 44 | Step 44 | 41, 42, 43 | — | r | step 44 builds |
| 45 | Step 45 | 42, 43, 44 | — | r | step 45 builds |
| 46 | Step 46 | 43, 44, 45 | — | r | step 46 builds |
| 47 | Step 47 | 44, 45, 46 | — | r | step 47 builds |
| 48 | Step 48 | 45, 46, 47 | — | r | step 48 builds |
| 49 | Step 49 | 46, 47, 48 | — | r | step 49 builds |
| 50 | Step 50 | 47, 48, 49 | — | r | step 50 builds |
| 51 | Step 51 | 48, 49, 50 | — | r | step 51 builds |
| 52 | Step 52 | 49, 50, 51 | — | r | step 52 builds |
| 53 | Step 53 | 50, 51, 52 | — | r | step 53 builds |
| 54 | Step 54 | 51, 52, 53 | — | r | step 54 builds |
| 55 | Step 55 | 52, 53, 54 | — | r | step 55 builds |
| 56 | Step 56 | 53, 54, 55 | — | r | step 56 builds |
| 57 | Step 57 | 54, 55, 56 | — | r | step 57 builds |
| 58 | Step 58 | 55, 56, 57 | — | r | step 58 builds |
| 59 | Step 59 | 56, 57, 58 | — | r | step 59 builds |
| 60 | Step 60 | 57, 58, 59 | — | r | step 60 builds |
| 61 | Step 61 | 58, 59, 60 | — | r | step 61 builds |
| 62 | Step 62 | 59, 60, 61 | — | r | step 62 builds |
| 63 | Step 63 | 60, 61, 62 | — | r | step 63 builds |
| 64 | Step 64 | 61, 62, 63 | — | r | step 64 builds |
| 65 | Step 65 | 62, 63, 64 | — | r | step 65 builds |
| 66 | Step 66 | 63, 64, 65 | — | r | step 66 builds |
| 67 | Step 67 | 64, 65, 66 | — | r | step 67 builds |
| 68 | Step 68 | 65, 66, 67 | — | r | step 68 builds |
| 69 | Step 69 | 66, 67, 68 | — | r | step 69 builds |
| 70 | Step 70 | 67, 68, 69 | — | r | step 70 builds |
| 71 | Step 71 | 68, 69, 70 | — | r | step 71 builds |
| 72 | Step 72 | 69, 70, 71 | — | r | step 72 builds |

## Session budget

**QA gate:** on

## Phases

### Phase 1 — Step 1
- **Goal:** step 1 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 2 — Step 2
- **Goal:** step 2 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 3 — Step 3
- **Goal:** step 3 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 4 — Step 4
- **Goal:** step 4 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 5 — Step 5
- **Goal:** step 5 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 6 — Step 6
- **Goal:** step 6 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 7 — Step 7
- **Goal:** step 7 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 8 — Step 8
- **Goal:** step 8 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 9 — Step 9
- **Goal:** step 9 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 10 — Step 10
- **Goal:** step 10 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **QA:** on
- **Verification:**
  - `true`

### Phase 11 — Step 11
- **Goal:** step 11 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 12 — Step 12
- **Goal:** step 12 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 13 — Step 13
- **Goal:** step 13 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 14 — Step 14
- **Goal:** step 14 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 15 — Step 15
- **Goal:** step 15 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 16 — Step 16
- **Goal:** step 16 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 17 — Step 17
- **Goal:** step 17 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 18 — Step 18
- **Goal:** step 18 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 19 — Step 19
- **Goal:** step 19 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 20 — Step 20
- **Goal:** step 20 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **QA:** off
- **Verification:**
  - `true`

### Phase 21 — Step 21
- **Goal:** step 21 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 22 — Step 22
- **Goal:** step 22 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 23 — Step 23
- **Goal:** step 23 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 24 — Step 24
- **Goal:** step 24 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 25 — Step 25
- **Goal:** step 25 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 26 — Step 26
- **Goal:** step 26 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 27 — Step 27
- **Goal:** step 27 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 28 — Step 28
- **Goal:** step 28 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 29 — Step 29
- **Goal:** step 29 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 30 — Step 30
- **Goal:** step 30 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 31 — Step 31
- **Goal:** step 31 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 32 — Step 32
- **Goal:** step 32 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 33 — Step 33
- **Goal:** step 33 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 34 — Step 34
- **Goal:** step 34 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 35 — Step 35
- **Goal:** step 35 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 36 — Step 36
- **Goal:** step 36 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 37 — Step 37
- **Goal:** step 37 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 38 — Step 38
- **Goal:** step 38 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 39 — Step 39
- **Goal:** step 39 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 40 — Step 40
- **Goal:** step 40 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **QA:** on
- **Verification:**
  - `true`

### Phase 41 — Step 41
- **Goal:** step 41 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 42 — Step 42
- **Goal:** step 42 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 43 — Step 43
- **Goal:** step 43 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 44 — Step 44
- **Goal:** step 44 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 45 — Step 45
- **Goal:** step 45 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 46 — Step 46
- **Goal:** step 46 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 47 — Step 47
- **Goal:** step 47 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 48 — Step 48
- **Goal:** step 48 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 49 — Step 49
- **Goal:** step 49 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 50 — Step 50
- **Goal:** step 50 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **QA:** off
- **Verification:**
  - `true`

### Phase 51 — Step 51
- **Goal:** step 51 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 52 — Step 52
- **Goal:** step 52 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 53 — Step 53
- **Goal:** step 53 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 54 — Step 54
- **Goal:** step 54 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 55 — Step 55
- **Goal:** step 55 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 56 — Step 56
- **Goal:** step 56 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 57 — Step 57
- **Goal:** step 57 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 58 — Step 58
- **Goal:** step 58 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 59 — Step 59
- **Goal:** step 59 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 60 — Step 60
- **Goal:** step 60 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 61 — Step 61
- **Goal:** step 61 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 62 — Step 62
- **Goal:** step 62 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 63 — Step 63
- **Goal:** step 63 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 64 — Step 64
- **Goal:** step 64 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 65 — Step 65
- **Goal:** step 65 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 66 — Step 66
- **Goal:** step 66 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 67 — Step 67
- **Goal:** step 67 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 68 — Step 68
- **Goal:** step 68 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 69 — Step 69
- **Goal:** step 69 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

### Phase 70 — Step 70
- **Goal:** step 70 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** M
- **Verification:**
  - `true`

### Phase 71 — Step 71
- **Goal:** step 71 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** L
- **Verification:**
  - `true`

### Phase 72 — Step 72
- **Goal:** step 72 of the scale fixture; its prose stands in for the paragraphs a real
  phase carries, so the plan is big enough for a per-edge re-read to cost something.
- **Size:** S
- **Verification:**
  - `true`

---
slug: section
created: 2026-10-25
status: active
phases: 3
handoffs: docs/handoffs/section/
memory: project_section
---

# One phase, read whole — `--section N`

## Context

Prose the section must never carry: **Size:** L, and a mention of Phase 2.

## Session budget

> **Target model:** `claude-opus-5` (1M window) · **Budget:** ~200K weight/session
> **Branch:** `pe/section`, cut at launch from the checkout's
> head; this line continues the branch directive.
>
> **QA gate:** off · **Verify timeout:** 60m · **Wait budget:** 10h
> **Issues:** file
>
> A paragraph that opens with no bold label is prose, and is left out, even
> when it mentions **Landing:** mid-line.
> **Driver:** the console's autopilot; a label that opens a line after prose
> is a directive again.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Before | — | — | r | x |
| 2 | The one read whole | 1 | — | r | `--section` works |
| 3 | After | 2 | — | r | x |

## Phases

### Phase 1 — Before
- **Size:** S
- **Verification:**
  - `true`

### Phase 2 — The one read whole
- **Goal:** the section, verbatim — its bullets, its nested bullets, its fence.
- **Size:** M
- **Model:** claude-opus-5-5[1m]
- **Verify timeout:** 90m
- **Steps:**
  1. one
  2. two

#### A sub-heading stays inside the section

```text
a fenced line stays inside the section, verbatim
```
- **Verification:**
  - **Verify in:** r
  - `true`


### Phase 3 — After
- **Size:** L
- **Verification:**
  - `false`

## End-to-end verification

Nothing of this reaches phase 2's section.

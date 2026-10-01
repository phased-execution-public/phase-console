---
slug: lint-f17-spans
created: 2026-01-01
status: active
phases: 36
handoffs: docs/handoffs/lint-f17-spans/
memory: project_lint-f17-spans
---

# F17 span-loop fixture — the shape that took `--lint` down

The plan whose lint crashed bash 3.2 (#17), rebuilt with neutral names: 36
phases, each with a §Verification the F17/F18 span extractors walk span by
span, and a phase 36 carrying the reproducer's own five command bullets at
the SAME byte lengths (39 / 170 / 154 / 23 / 101 / 132). The bisect turned on
length and count, not on the words — truncated to 35 phases the plan linted
OK; with 36 the engine died in the allocator with nothing on either stream.

It must lint OK, repeatedly, under /bin/bash.

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Step 1 | — | — | web-frontend | checked |
| 2 | Step 2 | 1 | — | web-frontend | checked |
| 3 | Step 3 | 2 | — | web-frontend | checked |
| 4 | Step 4 | 3 | — | web-frontend | checked |
| 5 | Step 5 | 4 | — | web-frontend | checked |
| 6 | Step 6 | 5 | — | web-frontend | checked |
| 7 | Step 7 | 6 | — | web-frontend | checked |
| 8 | Step 8 | 7 | — | web-frontend | checked |
| 9 | Step 9 | 8 | — | web-frontend | checked |
| 10 | Step 10 | 9 | — | web-frontend | checked |
| 11 | Step 11 | 10 | — | web-frontend | checked |
| 12 | Step 12 | 11 | — | web-frontend | checked |
| 13 | Step 13 | 12 | — | web-frontend | checked |
| 14 | Step 14 | 13 | — | web-frontend | checked |
| 15 | Step 15 | 14 | — | web-frontend | checked |
| 16 | Step 16 | 15 | — | web-frontend | checked |
| 17 | Step 17 | 16 | — | web-frontend | checked |
| 18 | Step 18 | 17 | — | web-frontend | checked |
| 19 | Step 19 | 18 | — | web-frontend | checked |
| 20 | Step 20 | 19 | — | web-frontend | checked |
| 21 | Step 21 | 20 | — | web-frontend | checked |
| 22 | Step 22 | 21 | — | web-frontend | checked |
| 23 | Step 23 | 22 | — | web-frontend | checked |
| 24 | Step 24 | 23 | — | web-frontend | checked |
| 25 | Step 25 | 24 | — | web-frontend | checked |
| 26 | Step 26 | 25 | — | web-frontend | checked |
| 27 | Step 27 | 26 | — | web-frontend | checked |
| 28 | Step 28 | 27 | — | web-frontend | checked |
| 29 | Step 29 | 28 | — | web-frontend | checked |
| 30 | Step 30 | 29 | — | web-frontend | checked |
| 31 | Step 31 | 30 | — | web-frontend | checked |
| 32 | Step 32 | 31 | — | web-frontend | checked |
| 33 | Step 33 | 32 | — | web-frontend | checked |
| 34 | Step 34 | 33 | — | web-frontend | checked |
| 35 | Step 35 | 34 | — | web-frontend | checked |
| 36 | Step 36 | 35 | — | web-frontend | checked |


### Phase 1 — Step 1

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-1 src/components/step-1 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-1/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 2 — Step 2

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-2 src/components/step-2 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-2/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 3 — Step 3

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-3 src/components/step-3 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-3/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 4 — Step 4

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-4 src/components/step-4 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-4/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 5 — Step 5

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-5 src/components/step-5 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-5/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 6 — Step 6

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-6 src/components/step-6 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-6/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 7 — Step 7

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-7 src/components/step-7 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-7/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 8 — Step 8

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-8 src/components/step-8 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-8/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 9 — Step 9

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-9 src/components/step-9 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-9/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 10 — Step 10

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-10 src/components/step-10 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-10/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 11 — Step 11

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-11 src/components/step-11 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-11/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 12 — Step 12

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-12 src/components/step-12 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-12/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 13 — Step 13

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-13 src/components/step-13 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-13/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 14 — Step 14

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-14 src/components/step-14 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-14/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 15 — Step 15

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-15 src/components/step-15 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-15/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 16 — Step 16

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-16 src/components/step-16 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-16/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 17 — Step 17

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-17 src/components/step-17 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-17/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 18 — Step 18

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-18 src/components/step-18 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-18/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 19 — Step 19

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-19 src/components/step-19 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-19/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 20 — Step 20

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-20 src/components/step-20 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-20/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 21 — Step 21

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-21 src/components/step-21 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-21/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 22 — Step 22

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-22 src/components/step-22 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-22/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 23 — Step 23

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-23 src/components/step-23 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-23/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 24 — Step 24

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-24 src/components/step-24 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-24/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 25 — Step 25

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-25 src/components/step-25 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-25/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 26 — Step 26

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-26 src/components/step-26 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-26/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 27 — Step 27

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-27 src/components/step-27 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-27/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 28 — Step 28

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-28 src/components/step-28 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-28/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 29 — Step 29

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-29 src/components/step-29 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-29/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 30 — Step 30

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-30 src/components/step-30 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-30/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 31 — Step 31

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-31 src/components/step-31 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-31/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 32 — Step 32

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-32 src/components/step-32 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-32/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 33 — Step 33

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-33 src/components/step-33 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-33/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 34 — Step 34

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-34 src/components/step-34 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-34/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 35 — Step 35

- **Size:** S
- **Verification:**
  - **Verify in:** web-frontend
  - `pnpm vitest run src/features/step-35 src/components/step-35 src/hooks`
  - `git log --oneline -1`
  - `test "$(ls src/features/step-35/*.tsx 2>/dev/null | wc -l | tr -d ' ')" = 4`

### Phase 36 — Step 36

- **Size:** S
- **Verification:**
  - **Verify in:** widgets/web-frontend
  - `pnpm vitest run src/components/waybar src/panels src/features/asset-catalogue src/components/action-palette src/features/firstrun src/features/walkthrough src/hooks`
  - `test "$(ls src/panels/{summaries,filters,saved-searches,drafts-orders,deal-stages,indicators}/\[id\]/index.tsx 2>/dev/null | wc -l | tr -d ' ')" = 6`
  - `pnpm verify:local`
  - `gh pr checks pe/web-frontend-audit-remediation-p36 -R ExampleOrg/widget-web-frontend --required`
  - `python3 ../../scripts/audits-coverage-check.py --status ../../docs/audits/sept/web-frontend/remediation-status.yaml --phase 36`

---
slug: setupb
status: active
phases: 5
created: 2026-08-31
---

# Setup bullet — fixture

## Session budget

**Target model:** `claude-opus-5` · **Budget:** ~200K weight/session · **Branch:** `main`
**Setup (every phase):** `docker compose up -d`, `sleep 8`

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
| 1 | Clean | — | 2 | app | it passes |
| 2 | Bring-up inside Verification | — | 1 | app | it passes |
| 3 | Expected failure in prose | 1 | — | app | it passes |
| 4 | Multi-line poll loop | 1 | — | app | it passes |
| 5 | Fenced Setup block | 1 | — | app | it passes |

### Phase 1 — Clean
- **Setup:** `npm ci`
- **Verification:**
  - **Verify in:** .
  - `npm test`
- **Handoff must record:** the `npm ci` decision

### Phase 2 — Bring-up inside Verification
- **Verification:**
  - **Verify in:** .
  - `docker compose up -d`
  - `sleep 8`
  - `npm test`

### Phase 3 — Expected failure in prose
- **Verification:**
  - **Verify in:** .
  - `task verify:local` — expected to fail until Phase 9 lands

### Phase 4 — Multi-line poll loop
- **Verification:**
  - **Verify in:** .
  ```bash
  until curl -sf localhost:8080/health
  do
    sleep 5
  done
  ```

### Phase 5 — Fenced Setup block
- **Setup:**
  ```bash
  # the stack, then a pause for it
  docker compose up -d
  npm ci
  ```
- **Verification:**
  - **Verify in:** .
  - `npm test`

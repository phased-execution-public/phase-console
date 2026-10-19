---
plan: model-provider
phases: 4
---

# Model provider — a plan that names provider models

## Session budget

> **Target model:** `deepseek-v4-pro[1m]` (DeepSeek, 1M window) · **Budget:** ~200K weight/session
>
> **Model policy:** pinned

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
| 1 | Plan's own model | — | — | app | the target model |
| 2 | An OpenAI model | 1 | — | app | gpt |
| 3 | A Claude model | 1 | — | app | claude |
| 4 | A window in prose | 2, 3 | — | app | prose window |

## Phases

### Phase 1 — Plan's own model
- **Size:** S
- **Verification:** `true`

### Phase 2 — An OpenAI model
- **Size:** M
- **Model:** `gpt-6.1-sol`
- **Verification:** `true`

### Phase 3 — A Claude model
- **Size:** M
- **Model:** claude-opus-5-5[1m]
- **Verification:** `true`

### Phase 4 — A window in prose
- **Size:** S
- **Model:** `deepseek-flash` (Flash, 1M window)
- **Verification:** `true`

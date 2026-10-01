---
slug: human-steps
created: 2026-09-30
status: active
phases: 5
handoffs: docs/handoffs/human-steps/
memory: project_human_steps
---

# Human steps — the plan bullet, every field, and silence

A phase may name the acts only a person can do, so the launch door can ask for
them before anything spawns (control-tower phase 41). Prose that mentions a
human step, or says a person must sign in, is not a directive.

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Silence | — | — | r | x |
| 2 | Every field, and auto-open | 1 | — | r | x |
| 3 | Two steps, defaults | 2 | — | r | x |
| 4 | A secret, and a step with no proof | 3 | — | r | x |
| 5 | Case, spacing and bold | 4 | — | r | x |

## Phases

### Phase 1 — Silence
- **Goal:** a phase that asks nothing of a person. The human step here is prose.
- **Verification:**
  - `true`

### Phase 2 — Every field, and auto-open
- **Human step:** browser-login · sign the gh CLI in to the org · open: `gh auth login --web` · proof: `cmd:"gh auth status"` · where: host · window: 2d · auto-open: host
- **Verification:**
  - `true`

### Phase 3 — Two steps, defaults
- **Human step:** device-code · enter the code the CLI prints · open: https://github.com/login/device · proof: `cmd:"gh auth status"`
- **Human step:** third-party-approval · the org owner approves the app · proof: `gh:acme/app#pr/7` · window: 3 days
- **Verification:**
  - `true`

### Phase 4 — A secret, and a step with no proof
- **Human step:** secret-entry · paste the npm automation token · credential: npm-token · proof: `cmd:"security find-generic-password -s phase-console-npm-token"` · where: any
- **Human step:** physical · plug the signing key in
- **Verification:**
  - `true`

### Phase 5 — Case, spacing and bold
- **Human step**: `OS-Permission`  ·  grant screen recording to the terminal  ·  where: HOST  ·  window: 90m  ·  open: https://support.example.com/screen?tab=privacy
* **Human step:** person-check · look at the rendered page on a phone · where: any · auto-open: host
- **Verification:**
  - `true`

---
slug: bad-human-steps
created: 2026-09-30
status: active
phases: 4
handoffs: docs/handoffs/bad-human-steps/
memory: project_bad_human_steps
---

# Human steps the lint refuses (F37)

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | The superseded spelling | — | — | r | x |
| 2 | An unknown kind | 1 | — | r | x |
| 3 | Fields the grammar does not have | 2 | — | r | x |
| 4 | A good step beside them | 3 | — | r | x |

## Phases

### Phase 1 — The superseded spelling
- **Human step:** the owner signs the release (proof: `cmd:"gh release view v1"`)
- **Verification:**
  - `true`

### Phase 2 — An unknown kind
- **Human step:** credential · the npm token in the keychain · proof: `cmd:"security find-generic-password -s npm"`
- **Verification:**
  - `true`

### Phase 3 — Fields the grammar does not have
- **Human step:** captcha · pass the bot wall · where: phone
- **Human step:** email-link · click the link · open: javascript:alert(1)
- **Human step:** mcp-login · sign in the server · credential: mcp-token
- **Human step:** physical · plug it in · colour: blue
- **Verification:**
  - `true`

### Phase 4 — A good step beside them
- **Human step:** os-prompt · unlock the keychain · proof: `cmd:"security show-keychain-info"`
- **Verification:**
  - `true`

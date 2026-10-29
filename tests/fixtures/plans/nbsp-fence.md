---
slug: nbsp-fence
created: 2026-10-25
status: active
phases: 3
handoffs: docs/handoffs/nbsp-fence/
memory: project_nbsp-fence
---

# No-break spaces — one reading under every locale (#410)

A no-break space (U+00A0) is whitespace to macOS awk, grep and sed under a
UTF-8 locale and text under C. The engine reads under C in every locale, as
CommonMark does (only a space or a tab indents), and the JS readers it is
held to read these same spots as text.

## Session budget

> **Target model:** `claude-opus-5` · **Budget:** ~200K · **Branch:** current
> **Wait budget:** 8h
> **Verify timeout:** 90m

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | A fence after a no-break space | — | — | r | x |
| 2 | A label joined by one | 1 | — | r | x |
| 3 | Plain | 2 | — | r | x |

## Phases

### Phase 1 — A fence after a no-break space
- **Size:** S
- **Verification:**
  - `true`
   ```bash
  pnpm test
   ```

### Phase 2 — A label joined by one
- **Size:** L
- **Model policy:** pinned
- **Verification:**
  - `true`

### Phase 3 — Plain
- **Verification:**
  - `true`

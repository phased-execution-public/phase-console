---
slug: unbolded
created: 2026-08-23
status: active
phases: 3
handoffs: docs/handoffs/unbolded/
memory: project_unbolded
---

# Unbolded-directive test plan

Every directive here is written **without** the bold markers the templates use.
The engine's readers make the asterisks optional — `plan_skills` and `plan_mcp`
match on the phrase alone, `mcp_directive` and `mcp_policy_directive` both match
`\*{0,2}MCP\*{0,2}[[:space:]]*:` — while the JS side required the exact bold
span and therefore saw nothing (parse-recovery-7, parse-recovery-14). The
consequences were one-sided and silent: boot prompts carried skills the QA brief
omitted, and a phase whose `- MCP:` bullet the engine honoured would have
boarded without the server, since it is the JS reading the attach and preflight
paths use.

`- **QA gate:** off` also carries a BULLET PREFIX here. `qa_mode()` grew an
optional `[-*][[:space:]]+` for exactly that reason (its own comment names the
bug); the JS `qaGate` regex never did, so this plan read as QA-on to one side
and QA-off to the other (parse-recovery-11).

The one directive that must still require its bold is `- **QA:**` on a phase:
`qa_phase_directive` matches `\*\*QA:?\*\*`, so phase 3's unbolded `QA: on`
below is silence to BOTH sides and inherits the plan's word.

## Session budget

**Target model:** `claude-opus-5` (1M window) · **Budget:** ~200K weight/session
Skills (every session): `tdd`, `design-system`
MCP servers (every session): `context7`
MCP policy: require
- **QA gate:** off

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|------:|-------|-----------|--------------------|-------|---------------|
| 1 | Servers    | —  | 2 | api-server | green |
| 2 | Carve-out  | —  | 1 | web-app    | green |
| 3 | Inherit    | 1, 2 | — | all      | green |

**Blocking:** {1, 2} → 3.
**Independent:** 1 ∥ 2 (disjoint scopes).

## Phases

### Phase 1 — Servers
- **Goal:** an unbolded phase MCP bullet adds to the plan-wide line.
- **Size:** S
- MCP: `playwright`, `sentry`
- **Exit criteria:**
  1. The union is context7 + playwright + sentry, on both sides.
- **Verification:**
  - `true`

### Phase 2 — Carve-out
- **Goal:** an unbolded phase policy overrides the plan-wide `require`.
- **Size:** S
- MCP policy: continue
- **Exit criteria:**
  1. Both sides read `continue` for this phase and `require` for the others.
- **Verification:**
  - `true`

### Phase 3 — Inherit
- **Goal:** an UNBOLDED `QA:` is silence — the one directive that keeps its bold.
- **Size:** S
- QA: on
- **Exit criteria:**
  1. Both sides inherit the plan's QA word rather than reading `on`.
- **Verification:**
  - `true`

## End-to-end verification

`true`

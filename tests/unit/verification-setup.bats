#!/usr/bin/env bats
# The `- **Setup:**` bullet, and the two advisories that send a plan towards it.
#
# F22 — bring-up inside §Verification. 19 hub plans wrote `docker compose up -d`
# there because the format had nowhere else to put it, and every such line is a
# command the boarding preflight asks a person to vouch for AND a line that can
# turn a phase red for a reason unrelated to its work (register R27).
#
# F23 — an expected failure stated in PROSE. "`task verify` — expected to fail
# until Phase 9" reads as passing to a person and as FAILING to the runner,
# which executes the command and takes its exit code.
#
# Both are ADVISORY: they ride stderr, they never move an exit code, and they
# never touch the LINT OK line.
load ../helpers/test_helper

@test "--setup: the plan-wide line and the phase's own bullet, plan first" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 1
  [ "$status" -eq 0 ]
  # Ordered, because bring-up is ordered: the shared stack has to be up before
  # a phase's own step against it can work.
  [ "$(printf '%s\n' "$output" | sed -n 1p)" = "docker compose up -d" ]
  [ "$(printf '%s\n' "$output" | sed -n 2p)" = "sleep 8" ]
  [ "$(printf '%s\n' "$output" | sed -n 3p)" = "npm ci" ]
}

@test "--setup: a phase with no bullet of its own still gets the plan-wide preamble" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "docker compose up -d"
  [[ "$output" != *"npm ci"* ]]
}

@test "--setup: Setup does not swallow the Verification bullet that follows it" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 1
  # The reach ends at the next top-level labelled bullet. Without that, the
  # first command bullet absorbs the second and F22 fires on every phase that
  # did exactly what F22 asks for.
  [[ "$output" != *"npm test"* ]]
}

@test "--setup: a phase number is required" {
  setup_docs setup-bullet setupb
  run pg setupb --setup
  [ "$status" -eq 2 ]
}

@test "F22: bring-up inside §Verification is named, exit stays 0" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  assert_contains "$output" "F22 phase 2"
  assert_contains "$output" "docker compose up"
}

@test "F22: a phase that puts its bring-up in Setup is not nagged" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [[ "$output" != *"F22 phase 1"* ]]
}

@test "F22: a done phase is not nagged about history" {
  setup_docs setup-bullet setupb
  write_handoff setupb 2 bringup complete
  run pg setupb --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F22 phase 2"* ]]
}

@test "F23: an expected failure stated in prose is named" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F23 phase 3"
  assert_contains "$output" "exit codes, not sentences"
}

@test "F23: a phase whose verification simply passes says nothing" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [[ "$output" != *"F23 phase 1"* ]]
  [[ "$output" != *"F23 phase 2"* ]]
}

@test "F16: a poll loop written across three fenced lines is still a poll loop" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  [ "$status" -eq 0 ]
  # The fold is the point: the shared alternation spells its spaces literally
  # (one string, two dialects), so a multi-line construct cannot match until it
  # is one line — and the runtime side folds too.
  assert_contains "$output" "F16 phase 4"
}

@test "F16: the carve-out — a DETACHED compose up is not a wait" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  # Phase 2 runs `docker compose up -d`, which returns. It earns an F22 (it is
  # bring-up) and must NOT earn an F16 (it is not a wait).
  [[ "$output" != *"F16 phase 2"* ]]
}

@test "F22/F23: validate.sh inherits both without failing" {
  setup_docs setup-bullet setupb
  run pe_validate setupb
  [ "$status" -eq 0 ]
  assert_contains "$output" "F22 phase 2"
  assert_contains "$output" "F23 phase 3"
  assert_contains "$output" "VALIDATE OK"
}

@test "--setup: a FENCED Setup block is commands, not silence (QA M6)" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 5
  [ "$status" -eq 0 ]
  # `--setup` used to grep backtick spans only, so a fenced block printed
  # NOTHING and the boot prompt omitted "Bring the stack up first" entirely —
  # while the runner's own extractor ran the block. Two readers of one bullet
  # disagreeing about whether it exists.
  assert_contains "$output" "docker compose up -d"
  assert_contains "$output" "npm ci"
  # …and the plan-wide line still comes first.
  [ "$(printf '%s\n' "$output" | sed -n 1p)" = "docker compose up -d" ]
}

@test "--setup: a fenced block's comments and blanks are not commands" {
  setup_docs setup-bullet setupb
  run pg setupb --setup 5
  [[ "$output" != *"# the stack"* ]]
  [[ "$output" != *"npm test"* ]]
}

@test "F22: the message is a whole sentence" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  # It ended "…never marks the phase red for" — mid-sentence, in the one line
  # an author reads to decide whether to act on it.
  [[ "$output" != *"red for"* ]]
  assert_contains "$output" "can never mark the phase red"
}

@test "F22: a poll loop's pacing is not bring-up (QA L9)" {
  setup_docs setup-bullet setupb
  run pg setupb --lint
  # Unanchored, `sleep [0-9]` matched the `sleep 5` INSIDE phase 4's
  # `until …; do sleep 5; done` — telling an author to move a fragment of a
  # command into a Setup bullet. F22 now matches at a command HEAD only.
  [[ "$output" != *"F22 phase 4"* ]]
  # …while the real bring-up, at a head, still fires.
  assert_contains "$output" "F22 phase 2"
}

# --------------------------------------------------------------------------
# F39 `setup-deps-missing` (#185 ask 1) — a §Verification line that runs a
# package-manager script or a `.venv/bin/*` binary in repository X, in a phase
# whose resolved Setup installs nothing for X. A superproject mirror mounts
# every scoped repository as a fresh worktree with no node_modules and no
# .venv, so `cd hetzner && npm run verify:local` read red in 1.7 s at
# baseline. Phases 1–3 are the shapes that must fire, 4–6 the ones that must
# not (phase 4 is control-tower's own), 7–10 the edges.
# --------------------------------------------------------------------------
deps_docs() {
  setup_docs setup-bullet deps
  cat > "$DOCS_ROOT/docs/plans/deps.md" <<'EOF'
---
slug: deps
status: active
phases: 14
---

# Setup deps — fixture

## Session budget

**Target model:** `claude-opus-5` · **Budget:** ~200K weight/session · **Branch:** `main`

## Phase graph

| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |
|---|---|---|---|---|---|
| 1 | Setup installs only another repo | — | — | app | it passes |
| 2 | A venv binary, nothing installs Python | — | — | app | it passes |
| 3 | A prefixed script under Verify in, no Setup | — | — | app | it passes |
| 4 | The control-tower shape | — | — | app | it passes |
| 5 | The venv is made in Setup | — | — | app | it passes |
| 6 | Setup cds where the line cds | — | — | app | it passes |
| 7 | The other ecosystem is not an install | — | — | app | it passes |
| 8 | An install inside Verification is F22's | — | — | app | it passes |
| 9 | Done, with the defect | — | — | app | it passes |
| 10 | Two lines in one repository | — | — | app | it passes |
| 11 | A fenced command continued with a backslash | — | — | app | it passes |
| 12 | Directories the run does not mount | — | — | app | it passes |
| 13 | A bash -c wrapper | — | — | app | it passes |
| 14 | Setup cds into its own Verify in | — | — | app | it passes |

### Phase 1 — Setup installs only another repo
- **Setup:** `npm --prefix aws ci`
- **Verification:**
  - `cd hetzner && npm run verify:local`

### Phase 2 — A venv binary, nothing installs Python
- **Verification:**
  - **Verify in:** .
  - `.venv/bin/pytest -q`

### Phase 3 — A prefixed script under Verify in, no Setup
- **Verification:**
  - **Verify in:** phased-execution
  - `npm --prefix viewer run test`

### Phase 4 — The control-tower shape
- **Setup:** `npm --prefix viewer ci`
- **Verification:**
  - **Verify in:** phased-execution
  - `npm --prefix viewer run test:client`
  - `bash tests/run-tests.sh`
  - `node --test viewer/test/skill-sync.test.ts`

### Phase 5 — The venv is made in Setup
- **Setup:** `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
- **Verification:**
  - **Verify in:** .
  - `.venv/bin/pytest -q`

### Phase 6 — Setup cds where the line cds
- **Setup:** `cd hetzner && npm ci`
- **Verification:**
  - `cd hetzner && npm run x`

### Phase 7 — The other ecosystem is not an install
- **Setup:** `cd hetzner && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
- **Verification:**
  - `cd hetzner && npm run verify:local`
  - `cd hetzner && .venv/bin/pytest -q`

### Phase 8 — An install inside Verification is F22's
- **Verification:**
  - **Verify in:** .
  - `npm ci`
  - `node --version`

### Phase 9 — Done, with the defect
- **Verification:**
  - `cd hetzner && npm run verify:local`

### Phase 10 — Two lines in one repository
- **Verification:**
  - `cd hetzner && npm run lint`
  - `cd hetzner && npm test`

### Phase 11 — A fenced command continued with a backslash
- **Verification:**
  ```bash
  cd aws \
    && npm run verify:local
  ```

### Phase 12 — Directories the run does not mount
- **Verification:**
  - `cd ~/elsewhere && npm test`
  - `npm --prefix /opt/tool run check`
  - `cd "$(git rev-parse --show-toplevel)" && npm test`
  - `cd ../outside && npm test`

### Phase 13 — A bash -c wrapper
- **Verification:**
  - `bash -c 'cd admin-ui && yarn test'`

### Phase 14 — Setup cds into its own Verify in
- **Setup:** `cd app/app-frontend && pnpm install --frozen-lockfile`
- **Verification:**
  - **Verify in:** app/app-frontend
  - `pnpm vitest run`
EOF
}

@test "F39: a script in a repository the Setup does not install is named, exit stays 0" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "LINT OK"
  # (a) the Setup installs `aws` only; the line runs in `hetzner`.
  assert_contains "$output" 'F39 phase 1: setup-deps-missing — `cd hetzner && npm run verify:local` runs an npm script in `hetzner`'
  assert_contains "$output" "the phase's Setup installs nothing for \`hetzner\`"
  # The fix names the install, spelled from where Setup runs.
  assert_contains "$output" '"- **Setup:** npm --prefix hetzner ci"'
}

@test "F39: a .venv binary with no Python install is named" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # (b)
  assert_contains "$output" 'F39 phase 2: setup-deps-missing — `.venv/bin/pytest -q` runs a .venv binary in `.`'
  assert_contains "$output" 'python3 -m venv .venv'
}

@test "F39: a package-manager directory flag joins onto Verify in" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # (c) the line means phased-execution/viewer, and Setup — which runs where
  # §Verification runs — would install it as `npm --prefix viewer ci`.
  assert_contains "$output" 'F39 phase 3: setup-deps-missing — `npm --prefix viewer run test` runs an npm script in `phased-execution/viewer`'
  assert_contains "$output" '"- **Setup:** npm --prefix viewer ci"'
}

@test "F39: an install for the line's own repository silences it" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # (d) control-tower's own shape; (e) the venv made in Setup; (f) the same cd.
  [[ "$output" != *"F39 phase 4"* ]]
  [[ "$output" != *"F39 phase 5"* ]]
  [[ "$output" != *"F39 phase 6"* ]]
}

@test "F39: an install of the OTHER ecosystem is no install for this line" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # #185's phase 21: its Setup made hetzner's venv, its line ran hetzner's npm.
  assert_contains "$output" 'F39 phase 7: setup-deps-missing — `cd hetzner && npm run verify:local`'
  # …while the venv binary in the same repository is satisfied by that Setup.
  [[ "$output" != *'`cd hetzner && .venv/bin/pytest -q`'* ]]
}

@test "F39: an install, node or bash inside Verification is not a script run" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # `npm ci` in §Verification is bring-up, F22's to name; `node` is a lead.
  assert_contains "$output" 'F22 phase 8: `npm ci`'
  [[ "$output" != *"F39 phase 8"* ]]
}

@test "F39: a done phase is not nagged about history" {
  deps_docs
  # Open, phase 9 is named like any other…
  run pg deps --lint
  [ "$status" -eq 0 ]
  assert_contains "$output" "F39 phase 9:"
  # …and once its handoff says complete, it is history.
  write_handoff deps 9 done complete
  run pg deps --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F39 phase 9"* ]]
}

@test "F39: one line per repository, not one per command" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -c '^F39 phase 10:')" -eq 1 ]
}

@test "F39: a fenced command continued with a backslash is judged whole" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # The `cd aws` on the first line moves the second; judged apart, the
  # script would have been placed at the root.
  assert_contains "$output" 'F39 phase 11: setup-deps-missing — `cd aws && npm run verify:local` runs an npm script in `aws`'
}

@test "F39: a directory the run does not mount, or nobody can place, is not judged" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # Home, absolute, a command substitution, above the root: no isolated
  # checkout mounts any of them, so "it has no node_modules there" would be
  # a claim about nothing.
  [[ "$output" != *"F39 phase 12"* ]]
}

@test "F39: a bash -c wrapper runs its own cd" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # The line is quoted as the plan writes it — wrapper and all — so a reader
  # finds it by searching the plan; the repository is the one its own cd names.
  assert_contains "$output" "F39 phase 13: setup-deps-missing — \`bash -c 'cd admin-ui && yarn test'\` runs a yarn script in \`admin-ui\`"
  assert_contains "$output" '"- **Setup:** yarn --cwd admin-ui install"'
}

@test "F39: Setup runs where Verification does, so its cd into Verify in installs nothing" {
  deps_docs
  run pg deps --lint
  [ "$status" -eq 0 ]
  # The runner hands Setup and §Verification one cwd — the Verify-in
  # directory — so this Setup's `cd app/app-frontend` means
  # app/app-frontend/app/app-frontend and installs nothing. The line
  # says where Setup runs, and the fix is spelled from there.
  assert_contains "$output" 'F39 phase 14: setup-deps-missing — `pnpm vitest run` runs a pnpm script in `app/app-frontend`'
  assert_contains "$output" '(Setup runs where §Verification does, in `app/app-frontend`)'
  assert_contains "$output" '"- **Setup:** pnpm install"'
}

@test "F39: the plan-wide Setup line installs for every phase" {
  deps_docs
  # The resolved Setup is the plan-wide line UNIONED with the phase's own.
  local f="$DOCS_ROOT/docs/plans/deps.md"
  awk '{ print } /^\*\*Target model:\*\*/ { print "**Setup (every phase):** `cd hetzner && npm ci`" }' "$f" > "$f.new"
  mv "$f.new" "$f"
  grep -q 'Setup (every phase)' "$f"
  run pg deps --lint
  [ "$status" -eq 0 ]
  [[ "$output" != *"F39 phase 1:"* ]]
  [[ "$output" != *"F39 phase 10:"* ]]
  # …and a line in another repository still fires.
  assert_contains "$output" "F39 phase 3:"
}

@test "F39: validate.sh inherits it without failing" {
  deps_docs
  run pe_validate deps
  [ "$status" -eq 0 ]
  assert_contains "$output" "F39 phase 1"
  assert_contains "$output" "VALIDATE OK"
}

#!/usr/bin/env bats
# phase-lane.sh — a hand session's own checkout, made where the console keeps
# its own (<root>/.worktrees/hand/<slug>/p<N>[-qa<r>]) on pe/<slug>-p<N>[-qa<r>],
# locked while it lives, folded back with ff-then-no-ff, and removed by the same
# hand. The shape that replaced `~/work/pe-p14`.
load ../helpers/test_helper

# A hub with docs/plans/demo.md (every phase scoped to `sub`), one submodule
# `sub` whose MAIN checkout stands on the run branch pe/demo, and nothing else.
setup_lane_hub() {
  scrub_pe_env
  HUB="$BATS_TEST_TMPDIR/hub"; SUB_SRC="$BATS_TEST_TMPDIR/subsrc"
  mkdir -p "$SUB_SRC"
  git -C "$SUB_SRC" init -q -b main
  git -C "$SUB_SRC" config user.email t@t.t; git -C "$SUB_SRC" config user.name t
  echo x > "$SUB_SRC/f"; git -C "$SUB_SRC" add f; git -C "$SUB_SRC" commit -qm init
  mkdir -p "$HUB/docs/plans" "$HUB/docs/handoffs/demo"
  sed 's/repo[A-Z]/sub/g' "$PE_DIR/tests/fixtures/plans/linear.md" > "$HUB/docs/plans/demo.md"
  git -C "$HUB" init -q -b main
  git -C "$HUB" config user.email t@t.t; git -C "$HUB" config user.name t
  git -C "$HUB" -c protocol.file.allow=always submodule add -q "$SUB_SRC" sub >/dev/null 2>&1
  git -C "$HUB" add -A; git -C "$HUB" commit -qm hub
  git -C "$HUB/sub" config user.email t@t.t; git -C "$HUB/sub" config user.name t
  git -C "$HUB/sub" checkout -q -b pe/demo
  export DOCS_ROOT="$HUB"
  HUB_P="$(cd "$HUB" && pwd -P)"
}

commit_in() { # <dir> <file> <body> <message>
  printf '%s\n' "$3" > "$1/$2"; git -C "$1" add "$2"; git -C "$1" commit -qm "$4"
}

@test "lane: create makes a locked worktree of the phase's repository under <root>/.worktrees/hand, on pe/<slug>-p<N>" {
  setup_lane_hub
  run pe_lane demo create 2
  [ "$status" -eq 0 ]
  dir="$HUB/.worktrees/hand/demo/p2/sub"
  [ -d "$dir" ]
  [ "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" = "pe/demo-p2" ]
  porcelain="$(git -C "$HUB/sub" worktree list --porcelain)"
  assert_contains "$porcelain" "worktree $HUB_P/.worktrees/hand/demo/p2/sub"
  assert_contains "$porcelain" "locked"
  # The hub's own status stays clean: the folder is excluded, not committed.
  grep -qx '/.worktrees/' "$HUB/.git/info/exclude"
  [ -z "$(git -C "$HUB" status --porcelain)" ]
  # And the session is told how to claim, qualified by the checkout it now has.
  assert_contains "$output" "claim 2 --scope"
  assert_contains "$output" "--here"
  assert_contains "$output" "$dir"
}

@test "lane: --qa names a QA-fix lane, --detach a review-only one with no branch" {
  setup_lane_hub
  run pe_lane demo create 2 --qa 2
  [ "$status" -eq 0 ]
  [ "$(git -C "$HUB/.worktrees/hand/demo/p2-qa2/sub" rev-parse --abbrev-ref HEAD)" = "pe/demo-p2-qa2" ]
  run pe_lane demo create 3 --detach
  [ "$status" -eq 0 ]
  [ "$(git -C "$HUB/.worktrees/hand/demo/p3/sub" rev-parse --abbrev-ref HEAD)" = "HEAD" ]
  [ -z "$(git -C "$HUB/sub" branch --list 'pe/demo-p3')" ]
}

@test "lane: create refuses a root-scoped token, a multi-token scope, a missing run branch and a lane that exists" {
  setup_lane_hub
  run pe_lane demo create 2 --repo all
  [ "$status" -eq 2 ]; assert_contains "$output" "root"
  run pe_lane demo create 2 --repo "sub,web"
  [ "$status" -eq 2 ]; assert_contains "$output" "--repo"
  run pe_lane demo create 2 --repo nowhere
  [ "$status" -eq 2 ]
  pe_lane demo create 2
  run pe_lane demo create 2
  [ "$status" -eq 1 ]; assert_contains "$output" "exists"
  git -C "$HUB/sub" checkout -q main; git -C "$HUB/sub" branch -q -D pe/demo
  run pe_lane demo create 1
  [ "$status" -eq 1 ]; assert_contains "$output" "pe/demo"
}

@test "lane: merge fast-forwards when it can, and makes a merge commit when it cannot" {
  setup_lane_hub
  pe_lane demo create 2
  lane="$HUB/.worktrees/hand/demo/p2/sub"
  commit_in "$lane" g y "lane work"
  run pe_lane demo merge 2
  [ "$status" -eq 0 ]; assert_contains "$output" "fast-forward"
  [ "$(git -C "$HUB/sub" rev-parse HEAD)" = "$(git -C "$lane" rev-parse HEAD)" ]
  # Diverge: the main checkout moves on too.
  commit_in "$lane" h z "more lane work"
  commit_in "$HUB/sub" k w "main work"
  run pe_lane demo merge 2
  [ "$status" -eq 0 ]; assert_contains "$output" "merge commit"
  [ "$(git -C "$HUB/sub" rev-list --count --merges HEAD~0 -1)" = "1" ]
  [ "$(git -C "$HUB/sub" rev-list --count pe/demo..pe/demo-p2)" = "0" ]
}

@test "lane: merge refuses a main checkout off the run branch, and a conflict is aborted with nothing lost" {
  setup_lane_hub
  pe_lane demo create 2
  lane="$HUB/.worktrees/hand/demo/p2/sub"
  commit_in "$lane" f lane "lane edits f"
  git -C "$HUB/sub" checkout -q main
  run pe_lane demo merge 2
  [ "$status" -eq 1 ]; assert_contains "$output" "pe/demo"
  git -C "$HUB/sub" checkout -q pe/demo
  commit_in "$HUB/sub" f main "main edits f"
  run pe_lane demo merge 2
  [ "$status" -eq 1 ]; assert_contains "$output" "f"
  [ -z "$(git -C "$HUB/sub" status --porcelain)" ]
  [ -n "$(git -C "$HUB/sub" branch --list 'pe/demo-p2')" ]
  run pe_lane demo merge 2 --detach
  [ "$status" -eq 2 ]
}

@test "lane: remove refuses a dirty or unmerged lane, and after a merge cleans up tree, branch and lock" {
  setup_lane_hub
  pe_lane demo create 2
  lane="$HUB/.worktrees/hand/demo/p2/sub"
  echo dirty > "$lane/scratch"
  run pe_lane demo remove 2
  [ "$status" -eq 1 ]; assert_contains "$output" "uncommitted"
  rm "$lane/scratch"
  commit_in "$lane" g y "lane work"
  run pe_lane demo remove 2
  [ "$status" -eq 1 ]; assert_contains "$output" "unmerged"
  pe_lane demo merge 2
  run pe_lane demo remove 2
  [ "$status" -eq 0 ]
  [ ! -e "$lane" ]
  [ ! -e "$HUB/.worktrees/hand/demo/p2" ]
  [ -z "$(git -C "$HUB/sub" branch --list 'pe/demo-p2')" ]
  [ "$(git -C "$HUB/sub" worktree list --porcelain | grep -c '^worktree ')" = "1" ]
  assert_contains "$output" "release 2"
}

@test "lane: remove --force drops a dirty tree but never -D's an unmerged branch" {
  setup_lane_hub
  pe_lane demo create 2
  lane="$HUB/.worktrees/hand/demo/p2/sub"
  commit_in "$lane" g y "lane work"
  echo dirty > "$lane/scratch"
  run pe_lane demo remove 2 --force
  [ "$status" -eq 0 ]
  [ ! -e "$lane" ]
  [ -n "$(git -C "$HUB/sub" branch --list 'pe/demo-p2')" ]
  assert_contains "$output" "kept"
}

@test "lane: list shows every hand lane with its repository, branch, lock and dirtiness" {
  setup_lane_hub
  run pe_lane list
  [ "$status" -eq 0 ]; [ -z "$output" ]
  pe_lane demo create 2
  pe_lane demo create 3 --qa 1
  echo dirty > "$HUB/.worktrees/hand/demo/p3-qa1/sub/scratch"
  run pe_lane list demo
  [ "$status" -eq 0 ]
  assert_contains "$output" ".worktrees/hand/demo/p2/sub"
  assert_contains "$output" "pe/demo-p2"
  assert_contains "$output" ".worktrees/hand/demo/p3-qa1/sub"
  assert_contains "$output" "pe/demo-p3-qa1"
  [ "$(printf '%s\n' "$output" | grep -c 'dirty=yes')" = "1" ]
  [ "$(printf '%s\n' "$output" | grep -c 'locked=yes')" = "2" ]
}

@test "lane: a plain repository (no .gitmodules) gets a lane of the root itself" {
  scrub_pe_env
  root="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$root/docs/plans" "$root/docs/handoffs/demo"
  sed 's/repo[A-Z]/sub/g' "$PE_DIR/tests/fixtures/plans/linear.md" > "$root/docs/plans/demo.md"
  git -C "$root" init -q -b main
  git -C "$root" config user.email t@t.t; git -C "$root" config user.name t
  git -C "$root" add -A; git -C "$root" commit -qm init
  git -C "$root" checkout -q -b pe/demo
  export DOCS_ROOT="$root"
  run pe_lane demo create 2
  [ "$status" -eq 0 ]
  [ "$(git -C "$root/.worktrees/hand/demo/p2" rev-parse --abbrev-ref HEAD)" = "pe/demo-p2" ]
  [ -z "$(git -C "$root" status --porcelain)" ]
}

@test "lane: from inside a lane the script finds the hub by itself — no DOCS_ROOT needed" {
  setup_lane_hub
  pe_lane demo create 2
  lane="$HUB/.worktrees/hand/demo/p2/sub"
  run env -u DOCS_ROOT bash -c "cd '$lane' && /bin/bash '$PE_SCRIPTS/phase-lane.sh' list demo"
  [ "$status" -eq 0 ]
  assert_contains "$output" "pe/demo-p2"
}

@test "lane: a RELATIVE DOCS_ROOT still puts the lane under the hub, never inside the sub-repository" {
  setup_lane_hub
  run bash -c "cd '$HUB' && DOCS_ROOT=. /bin/bash '$PE_SCRIPTS/phase-lane.sh' demo create 3 --repo sub"
  [ "$status" -eq 0 ]
  [ -d "$HUB/.worktrees/hand/demo/p3/sub" ]
  [ ! -e "$HUB/sub/.worktrees" ]
  assert_contains "$(git -C "$HUB/sub" worktree list --porcelain)" "worktree $HUB_P/.worktrees/hand/demo/p3/sub"
  [ -z "$(git -C "$HUB/sub" status --porcelain)" ]
}

@test "lane: a NESTED sub-repository's lane is listed, and removed without leaving its parents behind" {
  setup_lane_hub
  inner="$BATS_TEST_TMPDIR/innersrc"
  mkdir -p "$inner"
  git -C "$inner" init -q -b main
  git -C "$inner" config user.email t@t.t; git -C "$inner" config user.name t
  echo y > "$inner/g"; git -C "$inner" add g; git -C "$inner" commit -qm init
  git -C "$HUB/sub" -c protocol.file.allow=always submodule add -q "$inner" inner >/dev/null 2>&1
  git -C "$HUB/sub" commit -qm inner
  git -C "$HUB/sub/inner" config user.email t@t.t; git -C "$HUB/sub/inner" config user.name t
  git -C "$HUB/sub/inner" checkout -q -b pe/demo
  run pe_lane demo create 3 --repo sub/inner
  [ "$status" -eq 0 ]
  [ -d "$HUB/.worktrees/hand/demo/p3/sub/inner" ]
  run pe_lane list demo
  [ "$status" -eq 0 ]
  assert_contains "$output" ".worktrees/hand/demo/p3/sub/inner"
  assert_contains "$output" "repo=sub/inner"
  run pe_lane demo remove 3 --repo sub/inner
  [ "$status" -eq 0 ]
  [ ! -e "$HUB/.worktrees/hand/demo/p3" ]
  [ ! -e "$HUB/.worktrees/hand" ]
}

@test "lane: a plan that lanes its phases itself refuses a build lane and offers a review or QA lane" {
  setup_lane_hub
  printf '\n## Session budget\n- **Worktrees:** on\n' >> "$HUB/docs/plans/demo.md"
  run pe_lane demo create 2
  [ "$status" -eq 1 ]; assert_contains "$output" "Worktrees"; assert_contains "$output" "--detach"
  run pe_lane demo create 2 --detach
  [ "$status" -eq 0 ]
  run pe_lane demo create 2 --qa 1
  [ "$status" -eq 0 ]
}

@test "lane: create ADOPTS an existing lane branch and says how far it stands from the run branch" {
  setup_lane_hub
  git -C "$HUB/sub" branch pe/demo-p2 pe/demo
  git -C "$HUB/sub" checkout -q pe/demo-p2; commit_in "$HUB/sub" g y "earlier lane work"; git -C "$HUB/sub" checkout -q pe/demo
  commit_in "$HUB/sub" k w "main moved on"
  run pe_lane demo create 2
  [ "$status" -eq 0 ]
  assert_contains "$output" "adopted the existing pe/demo-p2"
  assert_contains "$output" "1 commit(s) ahead of and 1 behind pe/demo"
}

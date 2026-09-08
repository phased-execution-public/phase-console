#!/usr/bin/env bats
# xcut-4 — the bash half of instance identity must answer exactly what the JS
# half answers.
#
# `instanceId()` hashes `resolve(root)`; `pe_instance_id` hashes what
# `pe_instance_root` hands it. Those two used to differ for any denormalised
# path: the bash side did "lexical normalisation only" (trailing slash off,
# relative path prefixed) and left `/tmp/x/../y` exactly as it found it. A hook
# then wrote a session into one instance's state directory while the console
# that owned the repository watched another — reproduced live, and invisible
# from either side, because each is internally consistent.
#
# The parity is asserted against the real module, not against a restatement of
# the rule: a test that re-implements the thing it is checking agrees with
# itself forever.
load ../helpers/test_helper

INSTANCES_MJS="$PE_DIR/viewer/shared/instances.mjs"

setup() {
  command -v node >/dev/null 2>&1 || skip "node is required for the JS half"
}

# js_instance_id <root> — `instanceId(root)` from viewer/shared/instances.mjs,
# run with the SAME working directory, since a relative root resolves against it.
js_instance_id() {
  node --input-type=module -e '
    const { instanceId } = await import("file://" + process.env.PE_INSTANCES_MJS);
    process.stdout.write(instanceId(process.argv[1]));
  ' "$1"
}

# bash_instance_id <root> — under /bin/bash 3.2, the way the hooks run it.
bash_instance_id() {
  "$SYS_BASH" -c '. "$1"; pe_instance_id "$(pe_path_resolve "$2")"' _ "$PE_SCRIPTS/instance.sh" "$1"
}

assert_identity_agrees() {
  local root="$1" b j
  b="$(bash_instance_id "$root")"
  j="$(PE_INSTANCES_MJS="$INSTANCES_MJS" js_instance_id "$root")"
  [ -n "$b" ] || { echo "bash produced no id for: $root" >&2; return 1; }
  if [ "$b" != "$j" ]; then
    echo "identity disagrees for: $root" >&2
    echo "  bash: $b" >&2
    echo "  js:   $j" >&2
    return 1
  fi
}

@test "identity: an already-canonical absolute path agrees" {
  assert_identity_agrees "/tmp/project"
  assert_identity_agrees "/a/b/c"
}

@test "identity: a trailing slash agrees" {
  assert_identity_agrees "/tmp/project/"
  assert_identity_agrees "/"
}

@test "identity: '..' segments are collapsed the same way" {
  assert_identity_agrees "/tmp/x/../y"
  assert_identity_agrees "/a/b/../../c"
  assert_identity_agrees "/a/b/../../../c"   # popping past the root is a no-op in both
}

@test "identity: '.' segments and duplicate separators are collapsed the same way" {
  assert_identity_agrees "/tmp/./a/./b"
  assert_identity_agrees "/tmp//a///b"
  assert_identity_agrees "//a//b/"
}

@test "identity: a relative path resolves against the same working directory" {
  # This is the case that needed `pwd -P`: node prefixes `process.cwd()`, which
  # is PHYSICAL, while bash's `pwd` is the shell's logical $PWD — and on macOS
  # everything under /tmp and /var differs between the two (`/private/…`).
  mkdir -p "$BATS_TEST_TMPDIR/sub/deep"
  cd "$BATS_TEST_TMPDIR/sub"
  assert_identity_agrees "."
  assert_identity_agrees ".."
  assert_identity_agrees "deep"
  assert_identity_agrees "./deep/../deep"
}

@test "identity: pe_instance_root normalises DOCS_ROOT before hashing it" {
  # The live path: DOCS_ROOT is what a session exports, and it is not always
  # canonical — a `cd ../repo` or a trailing slash is enough.
  mkdir -p "$BATS_TEST_TMPDIR/work"
  local canonical denormalised
  canonical="$(DOCS_ROOT="$BATS_TEST_TMPDIR/work" "$SYS_BASH" -c \
    '. "$1"; pe_instance_id "$(pe_instance_root)"' _ "$PE_SCRIPTS/instance.sh")"
  denormalised="$(DOCS_ROOT="$BATS_TEST_TMPDIR/work/../work/" "$SYS_BASH" -c \
    '. "$1"; pe_instance_id "$(pe_instance_root)"' _ "$PE_SCRIPTS/instance.sh")"
  [ "$canonical" = "$denormalised" ]
}

@test "identity: a symlinked root keeps its own identity — never realpath" {
  # Deliberate: someone keeping two symlinks to one tree is asking for two
  # instances, and the JS half documents the same choice.
  mkdir -p "$BATS_TEST_TMPDIR/real"
  ln -s "$BATS_TEST_TMPDIR/real" "$BATS_TEST_TMPDIR/link"
  local a b
  a="$(bash_instance_id "$BATS_TEST_TMPDIR/real")"
  b="$(bash_instance_id "$BATS_TEST_TMPDIR/link")"
  [ "$a" != "$b" ]
  assert_identity_agrees "$BATS_TEST_TMPDIR/link"
}

@test "identity: the Claude config dir never claims a session — both halves agree" {
  # The CLI's config dir has a `plans/` of its own (plan-mode documents),
  # which made it "look like a project": presence events from any session
  # under it filed into a phantom candidate no console would ever boot.
  local config="$BATS_TEST_TMPDIR/cli-config"
  mkdir -p "$config/plans" "$config/projects/some-project/memory"
  local b j
  b="$(CLAUDE_CONFIG_DIR="$config" "$SYS_BASH" -c \
    '. "$1"; pe_project_root_for "$2" || printf none' _ "$PE_SCRIPTS/instance.sh" \
    "$config/projects/some-project/memory")"
  [ "$b" = "none" ]
  j="$(CLAUDE_CONFIG_DIR="$config" PE_INSTANCES_MJS="$INSTANCES_MJS" node --input-type=module -e '
    const { resolveInstance } = await import("file://" + process.env.PE_INSTANCES_MJS);
    process.stdout.write(resolveInstance(process.argv[1]).kind);
  ' "$config/projects/some-project/memory")"
  [ "$j" = "none" ]
  # A project INSIDE it still answers for itself.
  mkdir -p "$config/skills/some-skill/docs/plans" "$config/skills/some-skill/src"
  b="$(CLAUDE_CONFIG_DIR="$config" "$SYS_BASH" -c \
    '. "$1"; pe_project_root_for "$2" || printf none' _ "$PE_SCRIPTS/instance.sh" \
    "$config/skills/some-skill/src")"
  [ "$b" = "$config/skills/some-skill" ]
}

@test "identity: a lane of a submodule and the submodule's own checkout name ONE instance" {
  # A hook firing inside a hand lane, or a session declaring an outcome there,
  # must find the console that owns the HUB — the same state directory the
  # submodule's main checkout resolves to — or its presence lands in a phantom
  # instance nobody watches.
  setup_super_lane "$BATS_TEST_TMPDIR/hub"
  local from_lane from_sub
  from_lane="$(cd "$LANE" && env -u DOCS_ROOT "$SYS_BASH" -c '. "$1"; pe_instance_id "$(pe_instance_root)"' _ "$PE_SCRIPTS/instance.sh")"
  from_sub="$(cd "$HUB/sub" && env -u DOCS_ROOT "$SYS_BASH" -c '. "$1"; pe_instance_id "$(pe_instance_root)"' _ "$PE_SCRIPTS/instance.sh")"
  [ -n "$from_lane" ]
  [ "$from_lane" = "$from_sub" ]
  case "$from_lane" in *-hub) : ;; *) echo "expected the hub's identity, got $from_lane" >&2; return 1 ;; esac
}

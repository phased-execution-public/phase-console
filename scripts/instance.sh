# shellcheck shell=bash
# Instance identity for phased-execution — the bash half of the naming rule in
# viewer/shared/instances.mjs.
#
# Sourced (never executed) by phase-outcome.sh and session-hook.sh, which need
# to find Phase Console's state for the repository they are standing in WITHOUT
# a console answering and WITHOUT node: a human session declaring an outcome,
# a hook firing while the console is down. The rule must therefore be the same
# one `instanceId()` computes, or the console looks in one directory while the
# scripts write to another:
#
#   id        = sha256(<root path, as given — lexical, not realpath>)[:8] "-" basename(root)
#   state     = ${XDG_STATE_HOME:-~/.local/state}/phase-console
#   runs dir  = <state>/runs/<id>/<slug>            (shared across instances, keyed by id)
#   instance  = <state>                             for the default instance,
#               <state>/instances/<id>              for every other one
#
# The root is resolved by `pe_docs_root` below — the ONE resolver every script
# sources (phase-graph.sh, phase-lock.sh, … all of them): $DOCS_ROOT when set,
# else the outermost git superproject, else the main tree a linked worktree
# belongs to, else the git toplevel, else the working directory. bash 3.2.

# pe_state_home → the console's state home on stdout
pe_state_home() {
  printf '%s/phase-console' "${XDG_STATE_HOME:-$HOME/.local/state}"
}

# pe_path_resolve <path> → node's `path.resolve`, in bash 3.2.
#
# Absolute, with `.`, `..` and duplicate separators collapsed, and no trailing
# slash. This function is the whole reason identity works: `instanceId()` hashes
# `resolve(root)`, and this side used to do "lexical normalisation only" — a
# trailing slash off, a relative path prefixed — while leaving `/tmp/x/../y`
# exactly as it found it. The two then hashed different strings for the same
# directory, so a hook wrote a session into one instance's state while the
# console that owned the repository watched another. Reproduced live.
#
# Purely lexical, never `realpath`: a symlinked path keeps its own identity,
# which is what someone deliberately keeping two symlinks to one tree is asking
# for, and it is what the JS half does.
pe_path_resolve() {
  local p="${1:-.}" out="" seg noglob_was_set=0 IFS=/
  # `pwd -P`, not `pwd`: node prefixes a relative path with `process.cwd()`,
  # which is PHYSICAL, while bash's `pwd` is the shell's logical `$PWD`. On macOS
  # those differ for anything under /tmp or /var (`/private/…`), so a relative
  # root hashed to two different ids for the same directory. The path ARGUMENT
  # is still treated lexically — only the cwd prefix comes from the filesystem,
  # exactly as in JS.
  case "$p" in /*) : ;; *) p="$(pwd -P)/$p" ;; esac
  case "$-" in *f*) noglob_was_set=1 ;; esac
  set -f                                  # a segment may legitimately be `*`
  for seg in $p; do
    case "$seg" in
      ''|.) ;;                            # empty (a doubled or trailing slash) or no-op
      ..)   out="${out%/*}" ;;            # pop; at the root this is a no-op, as in JS
      *)    out="$out/$seg" ;;
    esac
  done
  [ "$noglob_was_set" = 1 ] || set +f
  printf '%s' "${out:-/}"
}

# pe_git_main_root → the MAIN working tree that owns the current directory, seen
# through a linked worktree, on stdout; exit 1 when git has no such answer.
#
# `--show-superproject-working-tree` answers NOTHING inside a linked worktree
# (`git worktree add`) of a submodule: a lane is not a submodule checkout, it is
# a second tree of the submodule's repository. What git does know there is the
# common git directory, and for a submodule that directory lives INSIDE the
# superproject — `<hub>/.git/modules/<path>` — so the hub is its prefix. `%%`
# strips the longest suffix, so a nested submodule (`<hub>/.git/modules/a/
# modules/b`) answers the OUTERMOST hub directly; a plain repository's
# `<root>/.git` answers its root. `pwd -P` because git prints the common dir
# RELATIVE to the cwd from inside a main tree and absolute from a linked one;
# the lexical rule of `pe_path_resolve` still applies to what callers do with
# the answer. Reproduced live: every script run from `~/work/pe-p14` (a lane of
# the pe-hub submodule) answered the lane as its docs root and found no plan.
pe_git_main_root() {
  local d="${1:-.}" c
  c="$(git -C "$d" rev-parse --git-common-dir 2>/dev/null || true)"
  [ -n "$c" ] || return 1
  # Relative answers are relative to the directory git ran in.
  c="$(cd "$d" 2>/dev/null && cd "$c" 2>/dev/null && pwd -P)" || return 1
  case "$c" in
    # A submodule initialised INSIDE a linked worktree of its superproject:
    # `<hub>/.git/worktrees/<id>/modules/<sub>` — the hub's main tree owns it.
    */.git/worktrees/*/modules/*) printf '%s' "${c%%/.git/worktrees/*}" ;;
    */.git/modules/*)             printf '%s' "${c%%/.git/modules/*}" ;;
    */.git)                       printf '%s' "${c%/.git}" ;;
    *)                            return 1 ;;
  esac
}

# pe_docs_root → the docs root every script agrees on, on stdout: $DOCS_ROOT
# when set; else the OUTERMOST git superproject of the cwd (the probe answers
# ONE level, and a nested submodule would otherwise resolve the MIDDLE root — a
# split docs universe the hub-rooted scans never read, G9); else — inside a
# linked worktree, where that probe is silent — the main tree the worktree
# belongs to (`pe_git_main_root`), walked outward the same way; else the git
# toplevel; else the working directory. ONE definition, sourced by every
# script: twelve private copies once agreed about a submodule checkout and
# disagreed about a lane, and the drift lint in tests/integration/gitroot.bats
# keeps it at one.
pe_docs_root() {
  local r up
  if [ -n "${DOCS_ROOT:-}" ]; then printf '%s' "$DOCS_ROOT"; return 0; fi
  r="$(git rev-parse --show-superproject-working-tree 2>/dev/null || true)"
  [ -n "$r" ] || r="$(pe_git_main_root . 2>/dev/null || true)"
  while [ -n "$r" ]; do
    up="$(git -C "$r" rev-parse --show-superproject-working-tree 2>/dev/null || true)"
    # A step that lands in a linked worktree — a nested submodule initialised
    # inside a lane — answers no superproject; its MAIN tree is the step up.
    # A main tree answers itself, which is where the walk stops.
    [ -n "$up" ] || up="$(pe_git_main_root "$r" 2>/dev/null || true)"
    [ -n "$up" ] && [ "$up" != "$r" ] || break
    r="$up"
  done
  if [ -n "$r" ]; then printf '%s' "$r"; return 0; fi
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

# pe_instance_root → the repository root this session is working in
pe_instance_root() {
  pe_path_resolve "$(pe_docs_root)"
}

# pe_project_root_for <dir> → the console root that would claim <dir>: the
# nearest ancestor that looks like a project (`docs/plans`, `plans`, or a
# `.phase-console.json` — the same test `instances.mjs` `looksLikeProject`
# makes). Prints NOTHING when no ancestor does: a directory no console could
# own has no presence to record. Used where the question is about a DIRECTORY
# rather than about the repository a script is standing in.
# The Claude CLI's own config dir is never a project, whatever it contains —
# its `plans/` (plan-mode documents) made it claim every session under
# `~/.claude` as a phantom candidate. Same rule as `looksLikeProject`.
pe_project_root_for() {
  local dir probe config
  dir="$(pe_path_resolve "$1")"
  config="$(pe_path_resolve "${CLAUDE_CONFIG_DIR:-$HOME/.claude}")"
  probe="$dir"
  while :; do
    if [ "$probe" != "$config" ] \
      && { [ -d "$probe/docs/plans" ] || [ -d "$probe/plans" ] || [ -f "$probe/.phase-console.json" ]; }; then
      printf '%s' "$probe"; return 0
    fi
    [ "$probe" != "/" ] && [ -n "$probe" ] || break
    probe="$(dirname "$probe")"
  done
  return 1
}

# pe_find_node → a node binary on stdout, or exit 1. PATH first, then the
# places a Desktop-launched shell does not have on its PATH (Homebrew,
# /usr/local, volta, the newest nvm) — the same order viewer/run looks in.
# Shared by session-hook.sh and phase-outcome.sh, whose --remember global
# has to find the console the way the hook does.
pe_find_node() {
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  local candidates="/opt/homebrew/bin /usr/local/bin $HOME/.volta/bin" v c
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for v in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -r); do
      candidates="$candidates $HOME/.nvm/versions/node/$v/bin"
    done
  fi
  for c in $candidates; do
    if [ -x "$c/node" ]; then printf '%s' "$c/node"; return 0; fi
  done
  return 1
}

# pe_console_url [docs-root] → the URL of the console that owns this root, on
# stdout (empty when nothing can say). $PHASE_CONSOLE_URL wins; else the
# registry is asked through viewer/shared/instances.mjs `shell`, which needs
# node — no node, no answer, and the caller says what it does without one.
pe_console_url() {
  if [ -n "${PHASE_CONSOLE_URL:-}" ]; then printf '%s' "$PHASE_CONSOLE_URL"; return 0; fi
  local root="${1:-}" node_bin shell_out skill_dir
  skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  node_bin="$(pe_find_node 2>/dev/null || true)"
  [ -n "$node_bin" ] && [ -f "$skill_dir/viewer/shared/instances.mjs" ] || return 0
  if [ -n "$root" ]; then
    shell_out="$("$node_bin" "$skill_dir/viewer/shared/instances.mjs" shell --root "$root" 2>/dev/null || true)"
  else
    shell_out="$("$node_bin" "$skill_dir/viewer/shared/instances.mjs" shell --cwd "$(pwd)" 2>/dev/null || true)"
  fi
  printf '%s
' "$shell_out" | sed -n 's/^url=//p' | head -1 | tr -d '
'
}

# pe_sha256_hex <text> → sha256(text) as 64 lowercase hex chars (empty when no
# digest tool is installed). One routine, so every id derived from a digest —
# the instance id below, the ruling id phase-outcome.sh stamps — is the same
# bytes the console's `createHash('sha256')` produces over the same UTF-8.
pe_sha256_hex() {
  local hex=""
  if command -v shasum >/dev/null 2>&1; then
    hex="$(printf '%s' "$1" | shasum -a 256 2>/dev/null | cut -c1-64)"
  elif command -v sha256sum >/dev/null 2>&1; then
    hex="$(printf '%s' "$1" | sha256sum 2>/dev/null | cut -c1-64)"
  elif command -v openssl >/dev/null 2>&1; then
    hex="$(printf '%s' "$1" | openssl dgst -sha256 2>/dev/null | sed 's/^.*= *//' | cut -c1-64)"
  fi
  printf '%s' "$hex"
}

# pe_sha256_prefix <text> → the first 8 hex chars of sha256(text)
pe_sha256_prefix() {
  printf '%s' "$(pe_sha256_hex "$1" | cut -c1-8)"
}

# pe_instance_id <root> → "<sha8>-<basename>" (basename `root` for "/")
pe_instance_id() {
  local root="$1" base hex
  base="$(basename "$root")"
  [ -n "$base" ] && [ "$base" != "/" ] || base="root"
  hex="$(pe_sha256_prefix "$root")"
  printf '%s-%s' "$hex" "$base"
}

# pe_runs_dir <root> <slug> → where the console keeps this plan's runs
pe_runs_dir() {
  printf '%s/runs/%s/%s' "$(pe_state_home)" "$(pe_instance_id "$1")" "$2"
}

# pe_registered_state_dir <root> → the state directory of the console the
# REGISTRY holds for exactly this root, read with no node at all; prints nothing
# (exit 1) when no registered console has this root. The registry is the
# pretty-printed JSON `instances.mjs` writes — each row an object opened at
# four spaces of indent and closed by a lone `}` at four — so the row is cut
# out by its id and asked whether it says `"default": true`. It replaces the
# guess `pe_instance_state_dir` makes from what exists on disk, which filed a
# directory no console owns against the default one (FLT-8).
pe_registered_state_dir() {
  local id registry block
  id="$(pe_instance_id "$1")"
  registry="${XDG_CONFIG_HOME:-$HOME/.config}/phase-console/instances.json"
  [ -f "$registry" ] || return 1
  block="$(sed -n "/^    \"$id\": {/,/^    },\{0,1\}\$/p" "$registry" 2>/dev/null)"
  [ -n "$block" ] || return 1
  if printf '%s' "$block" | grep -q '"default": true'; then
    pe_state_home
  else
    printf '%s/instances/%s' "$(pe_state_home)" "$id"
  fi
}

# pe_unowned_inbox → where a presence event no registered console claims is
# recorded, machine-wide: <state home>/fleet/sessions/inbox (FLT-8).
pe_unowned_inbox() {
  printf '%s/fleet/sessions/inbox' "$(pe_state_home)"
}

# pe_instance_state_dir <root> → this root's per-instance state directory.
# Without the registry (JSON, which bash 3.2 should not parse) the default
# instance is told apart by what exists: a console that was ever started for a
# non-default root created <state>/instances/<id>; the default instance keeps
# the flat state home.
pe_instance_state_dir() {
  local home id
  home="$(pe_state_home)"
  id="$(pe_instance_id "$1")"
  if [ -d "$home/instances/$id" ]; then printf '%s/instances/%s' "$home" "$id"; else printf '%s' "$home"; fi
}

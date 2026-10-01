# shellcheck shell=bash
# Scope reading for phased-execution — the bash half of viewer/shared/scope.js.
#
# Sourced (never executed) by phase-lock.sh and phase-graph.sh so there is ONE
# bash reading of a plan's Repos column, not two that drift. The JavaScript half
# is viewer/shared/scope.js; viewer/test/engine-parity.test.ts holds the two
# against every real plan, which is the only thing that keeps them honest.
#
# The rules, kept small enough to be the same in awk and in JS:
#   - parenthetical asides come off first  — `api (+web snapshot)` is one repo
#   - `,` `+` and whitespace separate; a bare `and` is a conjunction, not a repo
#   - `/` never separates: `packages/cart-api` is the one path it looks like
#   - lowercase; only [a-z0-9._/-] survives; 2..64 characters
#   - `*` means `all`
#
# Intersection: `all` hits everything, equal hits, and a SEGMENT-WISE path prefix
# hits — `packages` ∩ `packages/cart-api`, but `api` ∩ `api-gateway` is disjoint.
# Unknown (either side empty) counts as a collision: a missed conflict lets two
# sessions write one working tree, a false one only costs parallelism.
#
# Branch+tree qualification (`claim_disjoint`, below) is the one narrowing allowed on
# top of that: two claims whose scopes intersect are still disjoint when BOTH
# name a branch and the branches differ, AND both name a tree and the trees
# differ. It is a lock FIELD, never a scope token — `@` does not survive
# `norm()` above, and mutating the token grammar would churn the engine-parity
# surface for nothing. A `detached@<sha12>` branch is a qualification, not a
# ref: two EQUAL ones fall through to the tree test (see `claim_disjoint`).

# scope_normalize <cell> → normalized csv on stdout ('' for a cell with no repos)
scope_normalize() {
  printf '%s' "${1:-}" | awk '
    # Fold `.` and `..` out of a token, segment-wise — the twin of `foldRelative`
    # in viewer/shared/scope.js. A Repos cell is written by a person, and
    # `packages/../docs` is a path a person writes; nothing folded it, so it read
    # as DISJOINT from `docs` and cleared two sessions into one working tree by a
    # spelling. Segment-wise on purpose: `..b` and `b..` are names, not climbs,
    # and a `..` with nothing to pop is dropped rather than kept.
    function fold(s,   n, i, parts, out, top) {
      if (index(s, ".") == 0) return s
      n = split(s, parts, "/")
      top = 0
      for (i = 1; i <= n; i++) {
        if (parts[i] == "." || parts[i] == "") continue
        if (parts[i] == "..") { if (top > 0) top-- ; continue }
        out[++top] = parts[i]
      }
      s = ""
      for (i = 1; i <= top; i++) s = (s == "" ? out[i] : s "/" out[i])
      return s
    }
    function norm(t,   s) {
      s = tolower(t)
      if (s == "*") return "all"
      if (s == "and") return ""          # a conjunction between repos
      gsub(/[^a-z0-9._\/-]/, "", s)
      while (s ~ /\/\//) sub(/\/\//, "/", s)
      s = fold(s)
      sub(/^[^a-z0-9]+/, "", s)
      sub(/[^a-z0-9]+$/, "", s)
      if (length(s) < 2 || length(s) > 64) return ""
      return s
    }
    {
      line = $0
      gsub(/\([^)]*\)?/, " ", line)      # asides off before anything splits
      gsub(/[,+]/, " ", line)
      n = split(line, toks, /[ \t]+/)
      out = ""; seen = " "
      for (i = 1; i <= n; i++) {
        t = norm(toks[i])
        if (t == "") continue
        if (index(seen, " " t " ") > 0) continue
        seen = seen t " "
        out = (out == "" ? t : out "," t)
      }
      printf "%s", out
    }'
}

# scope_of_row <cell> → normalized csv, never empty (a phase that said nothing
# might touch anything, so it runs alone).
scope_of_row() {
  local s
  s="$(scope_normalize "${1:-}")"
  [ -n "$s" ] || s="all"
  printf '%s' "$s"
}

# scope_intersects <csv-a> <csv-b> → exit 0 if the two scopes overlap.
scope_intersects() {
  local a b
  # Either side unstated ⇒ assume they collide.
  [ -n "${1:-}" ] && [ -n "${2:-}" ] || return 0
  for a in $(printf '%s' "$1" | tr ',' ' '); do
    for b in $(printf '%s' "$2" | tr ',' ' '); do
      if [ "$a" = all ] || [ "$b" = all ]; then return 0; fi
      if [ "$a" = "$b" ]; then return 0; fi
      # Trailing slash on both sides is what makes the prefix segment-wise.
      case "$b/" in "$a"/*) return 0 ;; esac
      case "$a/" in "$b"/*) return 0 ;; esac
    done
  done
  return 1
}

# claim_disjoint <branch-a> <tree-a> <branch-b> <tree-b> → exit 0 iff the
# branch AND the working tree each claim rides make the two disjoint, even
# though their scopes intersect.
#
# The rule, stated once here and once as `claimsDisjoint` in
# viewer/shared/scope.js: *both claims declare a branch AND the branches
# differ, AND both declare a tree AND the trees differ ⇒ disjoint; anything
# else ⇒ collide.* An unqualified claim — either dimension missing on either
# side — collides with everything, exactly like an unstated scope and for the
# same reason.
#
# TWO dimensions, because either alone is a false witness: branches alone
# carved out two sessions editing ONE shared checkout on different branches
# (same directory, same files); trees alone would carve out two checkouts of
# one repository on ONE branch, whose commits land on top of each other.
# This is a NARROWING applied on top of `scope_intersects`, never a
# replacement, and the same slug+phase never carves whatever it declares.
#
# One reading of "the branches differ", mirrored from `claimsDisjoint`: an
# equal pair spelled `detached@<sha12>` names no ref, so two trees detached at
# one commit have no ref for their commits to collide on and are decided by
# the tree test alone — the same tree, or one inside the other, still
# collides. Two equal REAL refs are the same work, however many trees.
# Pure-bash whitespace trim, because the TS reader `.trim()`s every value and
# the rule must compare the same strings in both languages.
_claim_trim() {
  local v="${1:-}"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}

claim_disjoint() {
  local ab at bb bt
  ab="$(_claim_trim "${1:-}")"; at="$(_claim_trim "${2:-}")"
  bb="$(_claim_trim "${3:-}")"; bt="$(_claim_trim "${4:-}")"
  # Unqualified in either dimension, on either side ⇒ collide.
  if [ -z "$ab" ] || [ -z "$bb" ] || [ -z "$at" ] || [ -z "$bt" ]; then return 1; fi
  # The same REF is the same work, however many trees. An equal `detached@`
  # pair is not a ref: it goes on to the tree test below.
  if [ "$ab" = "$bb" ]; then
    case "$ab" in detached@*) : ;; *) return 1 ;; esac
  fi
  # Trailing slashes are spelling, not geography — ALL of them, as the JS twin
  # strips all (`/\/+$/`); one `${at%/}` left `/w/t1//` reading as `/w/t1/`
  # here and `/w/t1` there (QA F4 on console-parallel-repaint P1).
  while [ -n "$at" ] && [ "${at%/}" != "$at" ]; do at="${at%/}"; done
  while [ -n "$bt" ] && [ "${bt%/}" != "$bt" ]; do bt="${bt%/}"; done
  # The same tree — or one INSIDE the other (a mirror's mount, a cwd-derived
  # toplevel under a run's workspace) — is the same ground. Segment-wise via a
  # literal-prefix strip (quoted pattern), so `/w/a-b` is not inside `/w/a`.
  if [ "$at" = "$bt" ]; then return 1; fi
  if _same_ground "$bt" "$at"; then return 1; fi
  if _same_ground "$at" "$bt"; then return 1; fi
  return 0
}

# The console's own worktree home, as a path SEGMENT. `WORKTREES_DIR` in
# viewer/server/runner/worktree.ts is the definition; this and
# `WORKTREE_HOME_SEGMENT` in viewer/shared/scope.js are its two mirrors.
WORKTREE_HOME_SEGMENT='.worktrees'

# _same_ground <outer> <inner> → exit 0 iff <inner> is inside <outer> in the
# sense that makes two claims contend. The twin of `sameGround` in scope.js.
#
# Plain containment was the whole test, and under `worktreeRoot: project` — the
# shipped default — that is wrong: the home is `<root>/.worktrees/`, so EVERY
# tree the console makes is literally inside the shared root and a cap-refused
# shared run collided with all three isolated runs beside it, while the same
# three under `state` carved cleanly. The home is a BOUNDARY, not a step down:
# crossing it at any depth means the two are not the same ground. Beyond it
# nesting is normal again (a mirror's submodule mount inside a run's tree is
# still the same ground), and the branch dimension must still differ before
# `claim_disjoint` clears anything.
_same_ground() {
  local outer="$1" inner="$2" rest
  [ "$inner" = "$outer" ] && return 0
  rest="${inner#"$outer"/}"
  [ "$rest" = "$inner" ] && return 1        # not inside at all
  case "/$rest/" in *"/$WORKTREE_HOME_SEGMENT/"*) return 1 ;; esac
  return 0
}

# claim_disjoint_hold <held-branch> <held-repo> <branch> <tree>
#   → exit 0 when a claim is carved away from a RUN's hold on a shared tree.
# The twin of `holdDisjoint` in viewer/shared/scope.js (control-tower phase 40,
# #41): a lock is per PHASE, a hold is per RUN — "this repository stands on my
# branch until my run settles". Against a hold the SAME branch is no collision
# (the tree already stands where the claim needs it), and a different branch on
# the same ground is exactly the collision a lock never saw. A claim naming no
# branch (a run on the trunk) or no tree (a hand session anywhere) collides.
claim_disjoint_hold() {
  local hb ht cb ct
  hb="$(_claim_trim "${1:-}")"; ht="$(_claim_trim "${2:-}")"
  cb="$(_claim_trim "${3:-}")"; ct="$(_claim_trim "${4:-}")"
  if [ -z "$hb" ] || [ -z "$ht" ]; then return 1; fi
  if [ -n "$cb" ] && [ "$cb" = "$hb" ]; then return 0; fi
  [ -n "$ct" ] || return 1
  while [ -n "$ht" ] && [ "${ht%/}" != "$ht" ]; do ht="${ht%/}"; done
  while [ -n "$ct" ] && [ "${ct%/}" != "$ct" ]; do ct="${ct%/}"; done
  if [ "$ht" = "$ct" ]; then return 1; fi
  if _same_ground "$ct" "$ht"; then return 1; fi
  if _same_ground "$ht" "$ct"; then return 1; fi
  return 0
}

# hold_lapsed <run-file> → exit 0 when the run behind a hold has SETTLED: its
# state file is gone, reads `finished`, or reads `interrupted` by an operator's
# stop. The twin of `holdLapsed` in viewer/server/runner/tree-state.ts; the
# top-level keys of a run file sit exactly two spaces in, which is what makes a
# line-shaped read of JSON safe here (bash 3.2 parses no JSON).
hold_lapsed() {
  local rf="${1:-}" st
  [ -n "$rf" ] || return 1
  [ -f "$rf" ] || return 0
  st="$(grep -m1 '^  "status": ' "$rf" 2>/dev/null | sed 's/^  "status": "\([a-z-]*\)".*/\1/' || true)"
  [ "$st" = finished ] && return 0
  if [ "$st" = interrupted ] && grep -q '^  "stoppedBy": "operator"' "$rf" 2>/dev/null; then return 0; fi
  return 1
}

# hold_in_scope <root> <scope-csv> <held-repo> → exit 0 when a token of the
# scope reaches the held repository the way the console's `resolveMounts` does:
# `all` reaches the root and every repository under it; any other token reaches
# the repository its path is in, and every repository under THAT (a
# superproject scope considers its submodules). The root's OWN name reaches the
# root repository alone (control-tower phase 90, #150 — `holdReach` in
# `runner/tree-state.ts`): a hub-root phase commits by explicit pathspec and
# never stages a held submodule's gitlink, so a run-long hold on one does not
# reach it.
hold_in_scope() {
  local root="${1:-}" csv="${2:-}" repo="${3:-}" t dir top rootp own
  [ -n "$root" ] && [ -n "$repo" ] || return 1
  rootp="$(cd "$root" 2>/dev/null && pwd -P || printf '%s' "$root")"
  own="$(scope_normalize "$(basename "$rootp")")"
  for t in $(printf '%s' "$csv" | tr ',' ' '); do
    if [ -n "$own" ] && [ "$t" = "$own" ]; then
      [ "$repo" = "$rootp" ] && return 0
      continue
    fi
    if [ "$t" = all ]; then
      dir="$rootp"
    else
      dir="$rootp/$t"
      [ -e "$dir" ] || continue
      [ -d "$dir" ] || dir="$(dirname "$dir")"
    fi
    top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$top" ] || continue
    top="$(cd "$top" 2>/dev/null && pwd -P || printf '%s' "$top")"
    [ "$repo" = "$top" ] && return 0
    _same_ground "$top" "$repo" && return 0
  done
  return 1
}

# scope_overlap <csv-a> <csv-b> → the colliding tokens, space separated (for
# saying WHICH repo collided instead of only that something did).
scope_overlap() {
  local a b out=""
  for a in $(printf '%s' "${1:-}" | tr ',' ' '); do
    for b in $(printf '%s' "${2:-}" | tr ',' ' '); do
      scope_intersects "$a" "$b" || continue
      case " $out " in *" $a "*) continue ;; esac
      out="$out $a"
    done
  done
  printf '%s' "${out# }"
}

# The docs root's per-slug path token (control-tower phase 63, #88): the part
# of the ROOT a phase writes whatever its Repos cell says — its handoffs, INDEX,
# locks and ledgers under `docs/handoffs/<slug>/`. Declared, never admitted on:
# a plan's own lanes all write it, and the root's critical section in
# `phase-lock.sh` orders those writes for the length of a commit rather than
# serialising whole phases. Mirrored by `rootScopeToken` in `shared/scope.js`;
# empty for a slug with nothing usable left.
scope_root_token() {
  local s
  s="$(scope_normalize "${1:-}")"
  case "$s" in *[,\ ]*|'') return 0 ;; esac
  printf 'docs/handoffs/%s' "$s"
}

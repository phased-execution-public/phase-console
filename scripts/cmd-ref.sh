# shellcheck shell=bash
# cmd-ref.sh — how a `cmd:` ref reads, in bash. SOURCED, never executed.
#
# One reader for every bash caller of a `cmd:` ref: `phase-outcome.sh` (a
# declared `--watch` or `--proof`, refused with exit 2 when the console could
# not run it as written) and `phase-graph.sh --lint` (F45 `proof-unparsable`,
# F46 `proof-script-run-branch-only`, one-pool phase 13). The JS twins are
# `shared/proof-words.js` `cmdOfRef` (the one reader of the ref's quoting,
# #345) and `server/watch-refs.ts` `relativePathIn` / `cmdRefProblem` /
# `scriptOfCommand`; `viewer/test/watch-refs.test.ts` holds the two halves to
# one table. Never edit one half alone. bash 3.2: no arrays of arrays, no
# `${var,,}`, no `mapfile`.

# The command a cmd: ref runs. The ref's own quote pair is punctuation, never
# part of what runs. Inside a double-quoted body an escaped quote is the
# COMMAND's quote, read as the shell reads a double-quoted word (#345):
# cmd:"python3 -c \"import x\"" runs  python3 -c "import x". A body whose
# inner quotes are not escaped keeps the reading it always had — the outer pair
# dropped, the inside as written.
_cmd_body() {  # _cmd_body <ref>
  local body inner out c nx n m i closes q
  body="$(printf '%s' "${1#cmd:}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  n=${#body}
  if [ "$n" -ge 2 ]; then
    q="${body:0:1}"
    if { [ "$q" = '"' ] || [ "$q" = "'" ]; } && [ "${body:$((n - 1)):1}" = "$q" ]; then
      inner="${body:1:$((n - 2))}"
      case "$q$inner" in
        '"'*'\"'*)
          out="" closes=1 i=0 m=${#inner}
          while [ "$i" -lt "$m" ]; do
            c="${inner:$i:1}"
            nx="${inner:$((i + 1)):1}"
            if [ "$c" = '\' ] && { [ "$nx" = '"' ] || [ "$nx" = '\' ]; }; then
              out="$out$nx"; i=$((i + 2)); continue
            fi
            if [ "$c" = '"' ]; then closes=0; break; fi
            out="$out$c"; i=$((i + 1))
          done
          [ "$closes" -eq 1 ] && inner="$out"
          ;;
      esac
      body="$(printf '%s' "$inner" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    fi
  fi
  printf '%s' "$body"
}

# Does every quote in <text> close? Backslash escapes outside single quotes, as
# the shell the console runs it in reads them (control-tower phase 88, #125).
_quotes_balanced() {  # _quotes_balanced <text>
  local s="$1" i=0 n="${#1}" c q=""
  while [ "$i" -lt "$n" ]; do
    c="${s:$i:1}"
    if [ -z "$q" ]; then
      case "$c" in \\) i=$((i + 1)) ;; "'") q="'" ;; '"') q='"' ;; esac
    elif [ "$q" = "'" ]; then
      [ "$c" = "'" ] && q=""
    else
      case "$c" in \\) i=$((i + 1)) ;; '"') q="" ;; esac
    fi
    i=$((i + 1))
  done
  [ -z "$q" ]
}

# The first word of <command> that is a path relative to the session's working
# directory, or nothing. The console runs a cmd: ref from ITS root, so such a
# path names another file, or none (#152). Read as words with the quotes
# dropped; a flag, a URL, an assignment, `owner/repo` after -R/--repo and a sed
# expression are not paths. Each command of a chain is read with its lead
# (#350): after `git`, `refs/…` (and `+refs/…`, `:refs/…`) and any word with a
# `:` is a ref; after `gh`, `repos/…` and its kin are API routes; and
# `git -C /abs`, or anything after `cd /abs`, names files from that directory.
_relative_path_in() {  # _relative_path_in <command>
  local words raw word prev="" after found="" lead="" anchored=0 first of ends
  words="$(printf '%s' "$1" | tr "\"'" '  ')"
  set -f
  for raw in $words; do
    word="$raw"
    while :; do
      case "$word" in
        *';') word="${word%;}" ;;
        *'&&') word="${word%&&}" ;;
        *'||') word="${word%||}" ;;
        *) break ;;
      esac
    done
    ends=0; [ "$word" != "$raw" ] && ends=1
    after="$prev"; prev="$word"
    if [ -z "$word" ] || [ "$word" = '|' ]; then lead=""; continue; fi
    first=0
    if [ -z "$lead" ]; then first=1; lead="$word"; fi
    of="$lead"
    [ "$ends" -eq 1 ] && lead=""
    if [ "$first" -eq 0 ]; then
      if [ "$after" = cd ]; then case "$word" in /*) anchored=1; continue ;; esac; fi
      if [ "$after" = -C ] && [ "$of" = git ]; then case "$word" in /*) anchored=1; continue ;; esac; fi
      case "$after" in -R|--repo) continue ;; esac
      if [ "$of" = git ]; then case "$word" in refs/*|+refs/*|:refs/*|*:*) continue ;; esac; fi
      if [ "$of" = gh ] && printf '%s' "$word" | grep -Eq '^/?(repos|orgs|users|user|teams|search|gists|enterprises|notifications|graphql)(/|$)'; then
        continue
      fi
    fi
    [ "$anchored" -eq 1 ] && continue
    case "$word" in
      ./*|../*) found="$word"; break ;;
      /*|\~*|-*|*://*|*=*|s/*|y/*) continue ;;
      */*) ;;
      *) continue ;;
    esac
    case "$word" in *[!A-Za-z0-9._/@+-]*) continue ;; esac
    if printf '%s' "$word" | grep -Eq '/.*/|\.[A-Za-z0-9]{1,8}$'; then found="$word"; break; fi
  done
  set +f
  [ -n "$found" ] && printf '%s' "$found"
  return 0
}

# Why the console could not run a cmd: ref AS WRITTEN — the shapes that exit 2
# in phase-outcome.sh rather than park on a ref nothing can land (control-tower
# phase 88, #125, #152), and that the plan lint names (F45). A cmd: ref is
# self-contained: absolute paths, no shell variable, no substitution, every
# quote closed. The console's own policy is asked too, at declaration
# (`_probe_declaration`), and its refusal also exits 2.
_cmd_ref_problem() {  # _cmd_ref_problem <ref>
  local body rel
  body="$(_cmd_body "$1")"
  case "$body" in
    *'$'*) printf '%s' 'it carries a shell variable or substitution ($) — the console runs a cmd: ref in a shell of its own, where your session'"'"'s variables do not exist; write the value out'; return 0 ;;
    *'`'*) printf '%s' 'it carries a command substitution (a backtick) whose inner command the console cannot judge'; return 0 ;;
  esac
  if ! _quotes_balanced "$body"; then
    printf '%s' 'its quoting does not balance (a quote never closes) — the console would refuse it as unreadable; close every quote'
    return 0
  fi
  rel="$(_relative_path_in "$body")"
  [ -n "$rel" ] && printf '%s' "it names a relative path ($rel) — the console runs a cmd: ref from its own root, not your working directory; write the absolute path"
  return 0
}

# The program a command runs FROM A FILE — the first absolute path after an
# interpreter (bash, sh, python3, node, …), else the command's own first word
# when it is one — or nothing. The JS twin is `watch-refs.ts` `scriptOfCommand`.
_cmd_script() {  # _cmd_script <command>
  local words word lead
  words="$(printf '%s' "$1" | tr "\"'" '  ')"
  set -f
  set -- $words
  set +f
  [ "$#" -eq 0 ] && return 0
  lead="$1"
  case "$lead" in /*) printf '%s' "$lead"; return 0 ;; esac
  if printf '%s' "$lead" | grep -Eq '^((ba|z|k|da)?sh|python[0-9.]*|node|ruby|perl|deno|bun|tsx)$'; then
    shift
    for word in "$@"; do
      case "$word" in -*) continue ;; /*) printf '%s' "$word"; return 0 ;; *) return 0 ;; esac
    done
  fi
  return 0
}

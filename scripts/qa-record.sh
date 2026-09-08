#!/usr/bin/env bash
# Record a phase's QA result into docs/handoffs/<slug>/test-status.md — the source
# of truth the phased-execution engine reads to gate dependents. Deterministic, so
# the QA skill never hand-edits the table inconsistently (idempotent upsert).
#
# Usage: qa-record.sh <slug> <phase> <result> [--report REL_PATH] [--round N] [--reason TEXT]
#   result: pass | fail | waived | pending
#
# ## Two tables, because a verdict and a history are different questions
#
# `## QA status` holds ONE row per phase — the CURRENT verdict, which is what
# gates dependents — now with a fourth `Round` column saying which round produced
# it. `## QA rounds` is the append-only ledger: one row per (phase, round), which
# is what `phase-graph.sh --qa-history N` lists.
#
# The split is deliberate. Keeping one row per phase in the gating table is what
# makes every existing reader (this script's own upsert, `qa_result()` in the
# bash engine, `parseTestStatus` in the JS parser, the plan pages) go on answering
# identically — a second row per phase would have made "the verdict" ambiguous in
# four places at once, and the duplicate-row bug this script already self-heals
# was exactly that ambiguity arriving by accident. History is additive instead.
#
# A THREE-column table still reads: `Result` is the third cell either way, and a
# row with no `Round` cell reads as a round nobody numbered, which is what every
# row written before rounds existed genuinely is.
#
# ## What counts as a round
#
# A round is a review that HAPPENED, so only a verdict (`pass`/`fail`/`waived`)
# takes one; `pending` is the absence of a review and is recorded roundless. That
# is why `--round` with `pending` is refused rather than accepted and ignored —
# see the `--note` note below for the same reasoning applied once already.
#
# There is deliberately no --note. It used to be accepted, validated, and then
# echoed to stdout and thrown away: test-status.md has three columns and no
# reader could have seen a fourth. A flag that looks like it records something
# and does not is worse than no flag — the place for a QA note is the report the
# --report path points at.
#
# ## --reason, and why it is `waived`-only and lands in a THIRD table
#
# `--reason` is that lesson applied in the other direction: a waiver is the one
# verdict whose justification exists nowhere else. `pass` and `fail` point at a
# report a reviewer wrote; a waiver is a DECISION — "this finding does not apply
# to this phase" — and is regularly recorded with no report at all (`-`), so
# without a reason the row says only that somebody decided something. It is
# refused on the other three rather than accepted and dropped, for the --note
# reason above.
#
# It lands in `## QA waivers` rather than a fifth cell on either table, because
# both of those are COUNTED: `qa_history` in the engine and `parseQaRounds` in
# JS index the round ledger's cells positionally, and prose is the one value that
# cannot promise to be short. A third append-only section keyed (phase, round) is
# the same move `## QA rounds` itself made, and every existing reader is
# untouched by it.
set -euo pipefail
slug="${1:?usage: qa-record.sh <slug> <phase> <result> [--report PATH] [--round N] [--reason TEXT]}"
phase="${2:?phase number required}"
result="${3:?result required: pass|fail|waived|pending}"
shift 3
report=""
round=""
reason=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report) report="${2:?--report needs a path}"; shift 2 ;;
    --round)  round="${2:?--round needs a number}"; shift 2 ;;
    --reason) reason="${2:?--reason needs text}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$result" in pass|fail|waived|pending) : ;; *) echo "invalid result: $result (want pass|fail|waived|pending)" >&2; exit 2 ;; esac
# A pipe cannot survive a markdown table cell — it splits the row, and every
# reader on both sides of this seam counts cells. Refused rather than escaped or
# silently truncated: a path with a `|` in it is a mistake, and a row that
# reads as five columns when it should read as four is a corrupt ledger.
case "$report" in
  *"|"*) echo "--report may not contain a pipe: $report" >&2; exit 2 ;;
  *"
"*) echo "--report may not contain a newline" >&2; exit 2 ;;
esac
if [ -n "$reason" ]; then
  # `waived`-only, and refused rather than dropped — see the header.
  [ "$result" = waived ] || { echo "--reason is only meaningful with waived, not $result" >&2; exit 2 ; }
  # The same two characters `--report` refuses, for the same reason: a pipe
  # splits the row for every reader that counts cells, and a newline ends it.
  case "$reason" in
    *"|"*) echo "--reason may not contain a pipe: $reason" >&2; exit 2 ;;
    *"
"*) echo "--reason may not contain a newline" >&2; exit 2 ;;
  esac
  # Bounded so one paste cannot make the table unreadable. The reason is a
  # sentence about a decision, not the argument for it — that belongs in the
  # handoff's Outstanding section, which the waiver's own wording should name.
  [ "${#reason}" -le 280 ] || { echo "--reason is limited to 280 characters, got ${#reason}" >&2; exit 2 ; }
fi
case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
phase=$((10#$phase))   # `08` is a handoff filename, not a number — normalise once
if [ -n "$round" ]; then
  case "$round" in ''|*[!0-9]*) echo "round must be a number, got: $round" >&2; exit 2 ;; esac
  # Bounded to six digits, exactly like the filename-derived round below it. An
  # unbounded `--round` was the one half of the `08` fix that stayed open (QA
  # round 7, Low 3): `$((10#$round))` on twenty digits overflows into a negative
  # cell that every reader then sorts to the front of the ledger.
  [ "${#round}" -le 6 ] || { echo "round is limited to six digits, got: $round" >&2; exit 2 ; }
  round=$((10#$round))
  [ "$round" -ge 1 ] || { echo "round must be 1 or more, got: $round" >&2; exit 2 ; }
  # `pending` is the absence of a review, so there is no round it could be the
  # Nth of. Refused rather than silently dropped: this file already carries one
  # lesson about a flag that looks like it records something and does not.
  if [ "$result" = pending ]; then
    echo "--round makes no sense with pending: a round is a review that happened" >&2; exit 2
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"
dir="$DOCS_ROOT/docs/handoffs/$slug"
mkdir -p "$dir"
f="$dir/test-status.md"
if [ ! -f "$f" ]; then
  {
    printf '# QA / test status — %s\n\n' "$slug"
    printf 'Per-phase QA results recorded by phased-execution'\''s QA step. The engine reads the\n'
    printf '"Result" column to gate dependents: a phase is *verified* only when its handoff is\n'
    printf 'complete AND its Result is `pass` or `waived`. Values: pass | fail | pending | waived.\n'
    printf '"Round" is which review produced that verdict; every round is listed under\n'
    printf '"QA rounds" below. Written by scripts/qa-record.sh — never hand-edited.\n\n'
    printf '## QA status\n\n| Phase | Result | Report | Round |\n|------:|--------|--------|------:|\n'
  } > "$f"
  # Mid-plan activation backfill — the same rule `new-handoff.sh` applies, and
  # for the same reason. Gating is triggered by this file EXISTING, and a phase
  # with no row reads `none`, which is not verified. Creating the file without
  # backfilling therefore retroactively un-verifies every already-complete phase
  # and flips its dependents ready -> waiting, with no verdict recorded anywhere
  # and nothing in any UI to explain it. (The console's own "turn QA on" reaches
  # this script, not new-handoff.sh, which is how that shipped unnoticed.)
  #
  # It appends at EOF, which is correct here and only here: the `## QA rounds`
  # section does not exist yet on a file this branch just created, so there is
  # nothing below the status table for these rows to land underneath.
  for _hf in "$dir"/phase-*.md; do
    [ -e "$_hf" ] || continue
    _hn="$(basename "$_hf" | sed -E 's/^phase-0*([0-9]+)-.*/\1/')"
    case "$_hn" in ''|*[!0-9]*) continue ;; esac
    [ "$_hn" = "$phase" ] && continue
    _hst="$(grep -m1 '^status:' "$_hf" | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
    [ "$_hst" = complete ] || continue
    # The already-present guard `new-handoff.sh` carries verbatim. This loop
    # appended once per handoff FILE, and a phase re-handed-off under a second
    # kebab title has two — which wrote two `| 3 | waived | - |` rows, and the
    # upsert below only ever replaces the first, so the stale duplicate outlived
    # every later verdict.
    grep -qE "^\|[[:space:]]*${_hn}[[:space:]]*\|" "$f" && continue
    # Roundless: a backfilled waiver is a phase nobody reviewed, not round 1.
    printf '| %s | waived | - | - |\n' "$_hn" >> "$f"
    echo "backfilled phase $_hn as waived (completed before QA activation)"
  done
fi

# ---- what round is this? ----------------------------------------------------
# `previous + 1` on a re-record, where "previous" is the highest round this phase
# has on file — the ledger's, or, for a table written before the ledger existed,
# the status row's own (a legacy three-column `fail` is round 1, so the pass that
# answers it is round 2). A `pending` status row is not a review and counts zero.
prev_round() {
  awk -F'|' -v ph="$phase" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); gsub(/[*`]/,"",s); sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    # A report cell may be a markdown LINK; take the target, as the engine and
    # the JS parser both do. Without it the round hides behind the label.
    function target(s,  m){ if (match(s, /\]\([^)]+\)/)) return substr(s, RSTART + 2, RLENGTH - 3); return s }
    BEGIN{ max=0 }
    tolower($0) ~ /^##[[:space:]]+qa[[:space:]]+status/ { sec="status"; seen=0; next }
    tolower($0) ~ /^##[[:space:]]+qa[[:space:]]+rounds/ { sec="rounds"; seen=0; next }
    /^[[:space:]]*#/ { sec=""; seen=0; next }
    sec != "" && seen && $0 !~ /^[[:space:]]*\|/ { sec=""; seen=0 }
    sec != "" && /^[[:space:]]*\|/ {
      seen=1
      if (trim($2) != ph) next
      if (sec == "status") {
        r=tolower(trim($3))
        if (r != "pass" && r != "fail" && r != "waived") next
        n=trim($5)
        rep0 = target(trim($4))
        # No Round cell: a row written before rounds existed. Its number is in
        # its FILENAME — the `-roundN.md` convention is the only record those
        # rows have, and calling round 3 round 1 is how the next verdict came to
        # be numbered 2 and pointed at a report that already exists (QA F1).
        # An explicit Round cell is authoritative and is read FIRST, as in
        # `qa_history` and the JS parser (QA round 4, F3).
        if (n !~ /^[0-9]+$/ || n + 0 < 1) {
          # A `| N | waived | - |` row with no round comes from the activation
          # backfill and is not a round — see `qa_history` in phase-graph.sh.
          # (No apostrophes in here: this awk lives in a single-quoted string.)
          if (r == "waived" && (trim($4) == "" || trim($4) == "-")) next
          n = 1
          if (match(rep0, /-round[0-9]+\.md$/)) {
            rn = substr(rep0, RSTART + 6, RLENGTH - 9)
            if (rn + 0 > 0) n = rn + 0
          }
        }
      } else {
        n=trim($3); if (n !~ /^[0-9]+$/) next
      }
      if (n+0 > max) max=n+0
    }
    END{ print max }
  ' "$f"
}
# The legacy status row this record is about to replace — `round<TAB>result<TAB>report`,
# empty unless the row holds a verdict AND has no Round cell AND the ledger has
# no entry for this phase yet. It is read HERE because the upsert below rewrites
# the row, and written into the ledger further down: without it, upgrading a
# legacy table leaves a history whose first entry is round 2 and whose round 1 —
# a review that demonstrably happened, with a report on disk — is listed nowhere
# (QA F2).
legacy_round() {
  awk -F'|' -v ph="$phase" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); gsub(/[*`]/,"",s); sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    # A report cell may be a markdown LINK; take the target, as the engine and
    # the JS parser both do. Without it the round hides behind the label.
    function target(s,  m){ if (match(s, /\]\([^)]+\)/)) return substr(s, RSTART + 2, RLENGTH - 3); return s }
    BEGIN{ ledger=0 }
    tolower($0) ~ /^##[[:space:]]+qa[[:space:]]+status/ { sec="status"; seen=0; next }
    tolower($0) ~ /^##[[:space:]]+qa[[:space:]]+rounds/ { sec="rounds"; seen=0; next }
    /^[[:space:]]*#/ { sec=""; seen=0; next }
    sec != "" && seen && $0 !~ /^[[:space:]]*\|/ { sec=""; seen=0 }
    sec != "" && /^[[:space:]]*\|/ {
      seen=1
      if (trim($2) != ph) next
      if (sec == "rounds") { if (trim($3) ~ /^[0-9]+$/) ledger=1; next }
      r=tolower(trim($3))
      if (r != "pass" && r != "fail" && r != "waived") next
      rep = target(trim($4))
      cell = trim($5)
      if (cell ~ /^[0-9]+$/ && cell + 0 >= 1) {
        # An explicit Round cell is authoritative (a positive integer; `0` is no round) — the same rule qa_history,
        # prev_round and the JS parser apply. A numbered row the ledger does not
        # hold can only be a hand edit; carrying it into the ledger as the round
        # it says keeps the history the upsert below is about to rewrite
        # (QA round 4, F3).
        n = cell + 0
      } else {
        # No report, no round. A row with nothing to point at is not evidence a
        # review happened — and the commonest such row is the ACTIVATION backfill
        # a few lines above, `| N | waived | - | - |`, which exists precisely to
        # say "this phase finished before QA was on and nobody reviewed it". A
        # ledger entry for it would contradict the comment that writes it
        # (QA round 3, F4).
        if (rep == "" || rep == "-") next
        n = 1
        if (match(rep, /-round[0-9]+\.md$/)) {
          rn = substr(rep, RSTART + 6, RLENGTH - 9)
          if (rn + 0 > 0) n = rn + 0
        }
      }
      res = r; report = rep; found = 1
    }
    END{ if (found && !ledger) printf "%s\t%s\t%s\n", n, res, (report == "" ? "-" : report) }
  ' "$f"
}
legacy="$(legacy_round)"

if [ -z "$round" ] && [ "$result" != pending ]; then
  pad0="$(printf '%02d' "$phase")"
  case "$report" in
    *-round[0-9]*.md)
      # The report's FILENAME is the round when it carries one — the same
      # convention every reader infers a legacy row's round from — so a record
      # without `--round` that names `-round3.md` IS round 3, never "previous
      # + 1" counted from a ledger that has not seen an unrecorded round 2, which
      # put round 3's report in round 2's slot (QA round 5, F3).
      # Bounded to six digits and normalised: `-round08.md` is round 8, never
      # an `08` cell that the bash chooser reads as octal and dies on, and an
      # absurd run of digits falls through to previous + 1 rather than
      # wrapping (QA round 6).
      round="$(printf '%s' "$report" | sed -E 's/.*-round([0-9]{1,6})\.md$/\1/')"
      case "$round" in
        ''|*[!0-9]*) round="" ;;
        *) round=$((10#$round)); [ "$round" -ge 1 ] || round="" ;;
      esac ;;
    "reports/phase-${pad0}-qa.md")
      # A plain name is round 1 by the same convention.
      round=1 ;;
  esac
  if [ -z "$round" ]; then
    round=$(( $(prev_round) + 1 ))
    if [ -z "$report" ]; then
      # A bare record — no `--report` at all — is numbered by the HIGHEST
      # conventional report on disk in the unbroken run from that number up:
      # the reviewer wrote it and is recording it, and a stale one below it
      # ("wrote a report, recorded nothing") is stepped past rather than
      # numbered into. Bounded at 20 probes, as the chooser is; the guess a few
      # lines down then links that same file.
      _n="$round"; _probe=0; _hit=""
      while [ "$_probe" -lt 20 ]; do
        if [ "$_n" -gt 1 ]; then _cand="reports/phase-${pad0}-qa-round${_n}.md"; else _cand="reports/phase-${pad0}-qa.md"; fi
        [ -e "$dir/$_cand" ] || break
        _hit="$_n"; _n=$((_n + 1)); _probe=$((_probe + 1))
      done
      [ -z "$_hit" ] || round="$_hit"
    fi
  fi
fi
round_cell="${round:--}"

# ---- what report? -----------------------------------------------------------
# The convention the sessions invented and the engine's brief now hands out:
# round 1 keeps the plain name, every later round carries its own. Used as a
# DEFAULT only when the file is really there — a recorded path to a report
# nobody wrote is a dead link in every reader, which is worse than `-`.
pad="$(printf '%02d' "$phase")"
if [ -z "$report" ]; then
  if [ -n "$round" ] && [ "$round" -gt 1 ]; then
    _guess="reports/phase-${pad}-qa-round${round}.md"
  else
    _guess="reports/phase-${pad}-qa.md"
  fi
  if [ -f "$dir/$_guess" ]; then report="$_guess"; else report="-"; fi
fi

# ---- the gating row ---------------------------------------------------------
# Upsert the row for this phase: replace in place if present, else append to the
# END OF THE QA STATUS TABLE — not the end of the file, which is where the
# rounds ledger now lives. EVERY matching row is replaced and only the first is
# kept — a file that already carries a duplicate (written by a copy of this
# script from before the backfill guard above) then self-heals on the next
# record instead of keeping a stale verdict alive forever.
#
# The header is upgraded to four columns on the way past, idempotently: a row
# with a Round cell under a three-column header renders its round into nothing.
tmp="$f.tmp.$$"
awk -v ph="$phase" -v res="$result" -v rep="$report" -v rnd="$round_cell" '
  function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
  function rowout(){ printf "| %s | %s | %s | %s |\n", ph, res, rep, rnd }
  BEGIN{ done=0; insec=0; seen=0 }
  {
    if ($0 ~ /^[[:space:]]*#/) {
      if (insec && !done) { rowout(); done=1 }
      insec = (tolower($0) ~ /^[[:space:]]*##[[:space:]]+qa[[:space:]]+status/) ? 1 : 0
      seen=0; print; next
    }
    if (insec) {
      if ($0 ~ /^[[:space:]]*\|/) {
        seen=1
        n=split($0, c, "|"); cell=trim(c[2]); gsub(/[*`]/,"",cell); cell=trim(cell)
        if (cell ~ /^[0-9]+$/ && cell + 0 == ph + 0) {
          if (!done) { rowout(); done=1 }
          next
        }
        # Three-column header/separator -> four. n==5 is exactly three cells.
        if (n == 5) {
          if (tolower(cell) == "phase") { print "| Phase | Result | Report | Round |"; next }
          if ($0 ~ /^[[:space:]]*\|[-: ]+\|[-: ]+\|[-: ]+\|[[:space:]]*$/) { print "|------:|--------|--------|------:|"; next }
        }
        print; next
      }
      if (seen) { if (!done) { rowout(); done=1 } insec=0 }
    }
    print
  }
  END{ if (!done) rowout() }
' "$f" > "$tmp" && mv "$tmp" "$f"

# ---- the round ledger -------------------------------------------------------
# Append-only, except that re-recording the SAME (phase, round) replaces its row:
# this script's whole contract is that running it twice is running it once, and a
# session that re-records round 2 after fixing its report must not leave two.
ledger_row() {  # ledger_row <round> <result> <report> <recorded>
  tmp="$f.tmp.$$"
  awk -v ph="$phase" -v rnd="$1" -v res="$2" -v rep="$3" -v day="$4" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); gsub(/[*`]/,"",s); sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    function rowout(){ printf "| %s | %s | %s | %s | %s |\n", ph, rnd, res, rep, day }
    BEGIN{ done=0; insec=0; seen=0; had=0 }
    {
      if ($0 ~ /^[[:space:]]*#/) {
        if (insec && !done) { rowout(); done=1 }
        insec = (tolower($0) ~ /^[[:space:]]*##[[:space:]]+qa[[:space:]]+rounds/) ? 1 : 0
        if (insec) had=1
        seen=0; print; next
      }
      if (insec) {
        if ($0 ~ /^[[:space:]]*\|/) {
          seen=1
          n=split($0, c, "|")
          if (trim(c[2]) == ph "" && trim(c[3]) == rnd "") {
            if (!done) { rowout(); done=1 }
            next
          }
          print; next
        }
        if (seen) { if (!done) { rowout(); done=1 } insec=0 }
      }
      print
    }
    END{
      if (!had) {
        print ""
        print "## QA rounds"
        print ""
        print "Every round recorded for this plan, appended. The table above holds the CURRENT"
        print "verdict — the one that gates — and this holds the history behind it."
        print ""
        print "| Phase | Round | Result | Report | Recorded |"
        print "|------:|------:|--------|--------|----------|"
        rowout()
      } else if (!done) rowout()
    }
  ' "$f" > "$tmp" && mv "$tmp" "$f"
}

# The legacy row FIRST, so the ledger reads oldest-first and the round this
# record replaces is not simply lost. Skipped when it would collide with the
# round being written — re-recording round 3 over a legacy round 3 is a
# correction, not two reviews. Its `Recorded` cell is `-`: nobody wrote a date
# down, and stamping today would date a review that happened weeks ago.
#
# OUTSIDE the `$round` guard, and that is the point: `pending` is recorded
# roundless, and while the backfill sat inside the guard, recording `pending`
# over a legacy row threw the round away with it — the status row lost its
# Report cell (there is nothing to infer from any more) and the next brief
# dropped back to round 1, naming a report that already exists. The review that
# legacy row represents happened whatever is being written over it now.
if [ -n "$legacy" ]; then
  _lr="${legacy%%	*}"; _rest="${legacy#*	}"
  _lres="${_rest%%	*}"; _lrep="${_rest#*	}"
  if [ "$_lr" != "$round" ]; then
    ledger_row "$_lr" "$_lres" "$_lrep" "-"
    echo "backfilled phase $phase round $_lr from the legacy row ($_lres)"
  fi
fi
if [ -n "$round" ]; then
  ledger_row "$round" "$result" "$report" "$(date +%Y-%m-%d)"
fi

# ---- the waiver reason ------------------------------------------------------
# A third append-only section, keyed (phase, round) like the ledger, created on
# the first waiver that carries a reason and never otherwise: a plan that has
# waived nothing has no waivers table, which is the honest shape and keeps every
# file this script has ever written readable by every reader of it.
#
# `-` for a roundless waiver (the mid-plan activation backfill never reaches
# here — it writes its rows directly and carries no reason).
waiver_row() {  # waiver_row <round> <reason> <recorded>
  tmp="$f.tmp.$$"
  awk -v ph="$phase" -v rnd="$1" -v why="$2" -v day="$3" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); gsub(/[*`]/,"",s); sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    function rowout(){ printf "| %s | %s | %s | %s |\n", ph, rnd, why, day }
    BEGIN{ done=0; insec=0; seen=0; had=0 }
    {
      if ($0 ~ /^[[:space:]]*#/) {
        if (insec && !done) { rowout(); done=1 }
        insec = (tolower($0) ~ /^[[:space:]]*##[[:space:]]+qa[[:space:]]+waivers/) ? 1 : 0
        if (insec) had=1
        seen=0; print; next
      }
      if (insec) {
        if ($0 ~ /^[[:space:]]*\|/) {
          seen=1
          n=split($0, c, "|")
          if (trim(c[2]) == ph "" && trim(c[3]) == rnd "") {
            if (!done) { rowout(); done=1 }
            next
          }
          print; next
        }
        if (seen) { if (!done) { rowout(); done=1 } insec=0 }
      }
      print
    }
    END{
      if (!had) {
        print ""
        print "## QA waivers"
        print ""
        print "Why each waived verdict was waived, in the words of whoever waived it. A waiver is a"
        print "DECISION rather than a review, so it is the one verdict with no report to explain it."
        print ""
        print "| Phase | Round | Reason | Recorded |"
        print "|------:|------:|--------|----------|"
        rowout()
      } else if (!done) rowout()
    }
  ' "$f" > "$tmp" && mv "$tmp" "$f"
}
if [ -n "$reason" ]; then
  waiver_row "${round:--}" "$reason" "$(date +%Y-%m-%d)"
fi

if [ -n "$round" ]; then
  echo "recorded: $slug phase $phase = $result (round $round)  ->  $f"
else
  echo "recorded: $slug phase $phase = $result  ->  $f"
fi
exit 0

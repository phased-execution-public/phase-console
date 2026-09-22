#!/usr/bin/env bash
# The decision manifest's TWIN WRITER — the only thing that edits
# docs/handoffs/<slug>/decisions.md (chapter 13 §1.1, ZTD-12).
#
# A plan's `## Decisions` table is versioned prose the author wrote once;
# answers arrive later, at run time — an operator answers a row the plan left
# outstanding, waives one, or promotes a session's ruling to a standing answer.
# Those land in the twin, which `phase-graph.sh --decisions [N]` merges OVER
# the plan's rows (a twin row replaces the plan's whole; a row scoped to phase
# N replaces both, for that phase). This script writes EXACTLY the shape the
# readers parse — the `qa-mode.sh` rule — and then reads its own row back
# through the engine, so a table a reader cannot parse is never left behind.
# Never by hand: a hand edit that drifts a column is a decision the engine
# silently stops seeing.
#
# Usage:
#   decisions.sh <slug> [--phase N] answer <key> --value TEXT [--by WHO] [--blocking yes|no] [--evidence TEXT]
#   decisions.sh <slug> [--phase N] waive  <key> --reason TEXT [--by WHO]
#   decisions.sh <slug> [--phase N] promote --from-ruling <id> --key <key> [--by WHO]
#   decisions.sh <slug> [--phase N] list
#
#   answer   — state `answered`, source `run`, the value as given. `--blocking`
#              defaults to what the merged row says today (the plan's `yes`
#              stays `yes` — an answer never silently un-blocks a row), else `no`.
#   waive    — state `waived`, source `run`, the reason as the value: "this
#              decision does not apply here", recorded by whom.
#   promote  — a ruling from the plan's ledger ($PE_RULINGS_FILE, else
#              runs/<instance>/<slug>/rulings.ndjson) becomes a standing answer:
#              its `what` is the value, source `ruling`, evidence `ruling <id>`.
#              The ruling's own `decisionKey` (phase-outcome.sh --needs) names
#              the row; `--key` overrides it, and is required for a ruling that
#              carries none. The id is the one phase-outcome.sh stamps on the
#              line (rulings.ts derives the same for lines written before it did).
#   list     — the engine's read-back: `phase-graph.sh <slug> --decisions [N]`.
#   --phase N  scopes the row to phase N (the twin's `phase` column); absent = plan-wide.
#   --by       defaults to $PE_OWNER, else user@host — the identity gate-approve.sh records.
#
# The key is validated against scripts/decisions.env (the bash twin of
# viewer/shared/decisions-model.js); the phase against the plan's own table.
# Atomic (tmp+mv), idempotent (an unchanged file is not rewritten, so the
# console's docs watcher does not wake for nothing), never touches git.
#
# Exit: 0 written and read back · 1 written but the engine reads it differently
#       (the file carries a row this script did not write — say so, never
#       silently) · 2 usage, unknown key, unknown phase, missing plan or ruling.
set -euo pipefail

usage="usage: decisions.sh <slug> [--phase N] answer <key> --value TEXT | waive <key> --reason TEXT | promote --from-ruling ID --key KEY | list   [--by WHO] [--blocking yes|no] [--evidence TEXT]"
slug="${1:?$usage}"
shift
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DECISION_KEYS="permission.policy permission.destructive issues credentials accounts mcp gates verification.person-check qa.exhausted waits human-acts ambiguity budgets resume.on-restart plan-health stop relay announce"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/decisions.env" ] && . "$SCRIPT_DIR/decisions.env"

phase=""; verb=""; key=""; value=""; by=""; blocking=""; evidence=""; ruling_id=""
while [ $# -gt 0 ]; do
  case "$1" in
    --phase)       phase="${2:?--phase needs a number}"; shift 2 ;;
    --value)       value="${2:?--value needs text}"; shift 2 ;;
    --reason)      value="${2:?--reason needs text}"; shift 2 ;;
    --by)          by="${2:?--by needs a name}"; shift 2 ;;
    --blocking)    blocking="$(printf '%s' "${2:?--blocking needs yes|no}" | tr '[:upper:]' '[:lower:]')"; shift 2 ;;
    --evidence)    evidence="${2:?--evidence needs text}"; shift 2 ;;
    --from-ruling) ruling_id="${2:?--from-ruling needs a ruling id}"; shift 2 ;;
    --key)         key="${2:?--key needs a decision key}"; shift 2 ;;
    -*) echo "unknown option: $1" >&2; echo "$usage" >&2; exit 2 ;;
    *)
      if [ -z "$verb" ]; then verb="$1"
      elif [ -z "$key" ] && { [ "$verb" = answer ] || [ "$verb" = waive ]; }; then key="$1"
      else echo "unexpected argument: $1" >&2; echo "$usage" >&2; exit 2; fi
      shift ;;
  esac
done
case "$verb" in
  answer|waive|promote|list) : ;;
  '') echo "$usage" >&2; exit 2 ;;
  *)  echo "invalid verb: $verb (want answer|waive|promote|list)" >&2; exit 2 ;;
esac
if [ -n "$phase" ]; then
  case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac
  phase=$((10#$phase))
fi
DOCS_ROOT="$(pe_docs_root)"; export DOCS_ROOT
plan="$DOCS_ROOT/docs/plans/$slug.md"
[ -f "$plan" ] || { echo "no such plan: $plan" >&2; exit 2; }

# The read-back, and `list`. The engine is the one reader; this script never
# parses the twin itself.
engine_rows() {  # engine_rows [phase]
  if [ -n "${1:-}" ]; then "$SCRIPT_DIR/phase-graph.sh" "$slug" --decisions "$1"
  else "$SCRIPT_DIR/phase-graph.sh" "$slug" --decisions; fi
}
if [ "$verb" = list ]; then
  engine_rows "$phase"
  exit 0
fi

# The phase must be one the plan has — a row scoped to a phase that does not
# exist would sit in the twin unread for ever.
if [ -n "$phase" ]; then
  engine_rows "$phase" >/dev/null 2>&1 || { echo "phase $phase is not in plan $slug" >&2; exit 2; }
fi

# promote: the ruling's `what` becomes the value, `--key` (or the ruling's own
# decisionKey) the row.
source_word=run
if [ "$verb" = promote ]; then
  [ -n "$ruling_id" ] || { echo "promote needs --from-ruling <id>" >&2; exit 2; }
  ledger="${PE_RULINGS_FILE:-$(pe_runs_dir "$(pe_instance_root)" "$slug")/rulings.ndjson}"
  [ -f "$ledger" ] || { echo "no rulings ledger at $ledger" >&2; exit 2; }
  # The RULING line, never its ack: an ack carries the same id and, being
  # appended later, would win `tail -1` — and an ack has no `what`, so the row
  # would have been written with an empty value.
  line="$(grep -F "\"id\":\"$ruling_id\"" "$ledger" | grep -F '"type":"ruling"' | tail -1 || true)"
  [ -n "$line" ] || line="$(grep -F "\"id\": \"$ruling_id\"" "$ledger" | grep -F '"type": "ruling"' | tail -1 || true)"
  [ -n "$line" ] || { echo "no ruling $ruling_id in $ledger" >&2; exit 2; }
  # One field off one JSON line, bash 3.2 + sed: the value of "what" up to its
  # closing unescaped quote. Rulings are written by phase-outcome.sh, whose
  # sanitiser keeps every field on one line and escapes quotes.
  value="$(printf '%s' "$line" | sed -E 's/.*"what":[[:space:]]*"((\\.|[^"\\])*)".*/\1/; s/\\"/"/g; s/\\\\/\\/g')"
  [ -n "$key" ] || key="$(printf '%s' "$line" | sed -nE 's/.*"decisionKey":[[:space:]]*"([^"]*)".*/\1/p')"
  [ -n "$key" ] || { echo "promote needs --key <key>: ruling $ruling_id carries no decisionKey" >&2; exit 2; }
  [ -n "$evidence" ] || evidence="ruling $ruling_id"
  source_word=ruling
fi

[ -n "$key" ] || { echo "$verb needs a decision key" >&2; exit 2; }
case " $DECISION_KEYS " in
  *" $key "*) : ;;
  *) echo "unknown decision key: $key (want one of: $DECISION_KEYS)" >&2; exit 2 ;;
esac
case "$verb" in
  answer)  [ -n "$value" ] || { echo "answer needs --value TEXT" >&2; exit 2; }; state=answered ;;
  waive)   [ -n "$value" ] || { echo "waive needs --reason TEXT (why this decision does not apply)" >&2; exit 2; }; state=waived ;;
  promote) state=answered ;;
esac
case "$blocking" in ''|yes|no) : ;; *) echo "--blocking must be yes or no, got: $blocking" >&2; exit 2 ;; esac
# An answer keeps the row's blocking unless told otherwise: the plan said this
# row blocks a run, and answering it is not the same as saying it never did.
if [ -z "$blocking" ]; then
  blocking="$(engine_rows "$phase" | awk -F'\t' -v k="$key" '$1 == k { print $4; exit }')"
  [ -n "$blocking" ] || blocking=no
fi

# Who. The autopilot's exported owner, else user@host — gate-approve.sh's identity.
[ -n "$by" ] || by="${PE_OWNER:-$(whoami 2>/dev/null || echo operator)@$(hostname -s 2>/dev/null || hostname)}"
# Table cells: one line, no pipes, bounded — the readers split on `|`.
cell() { printf '%s' "$1" | tr '\r\n\t|' '    ' | sed 's/  */ /g; s/^ //; s/ *$//'; }
by="$(cell "$by" | cut -c1-64)"
value="$(cell "$value" | cut -c1-500)"
evidence="$(cell "$evidence" | cut -c1-200)"
today="${PE_TODAY:-$(date +%F)}"
[ -n "$evidence" ] || evidence="decisions.sh $today"
phase_cell="${phase:-—}"

dir="$DOCS_ROOT/docs/handoffs/$slug"
mkdir -p "$dir"
f="$dir/decisions.md"
tmp="$f.tmp.$$"
if [ ! -f "$f" ]; then
  {
    printf '# Decisions — %s\n\n' "$slug"
    printf 'The decision manifest'\''s mutable twin, written by `scripts/decisions.sh` — never by\n'
    printf 'hand. `phase-graph.sh %s --decisions [N]` merges these rows OVER the plan'\''s own\n' "$slug"
    printf '`## Decisions` table: a row here replaces the plan'\''s whole row for its key, and a\n'
    printf 'row with a phase replaces both, for that phase. `—` in the phase column is plan-wide.\n\n'
    printf '## Decisions\n\n'
    printf '| key | value | owner | state | blocking | source | evidence | phase |\n'
    printf '|---|---|---|---|---|---|---|---|\n'
  } > "$f"
fi

# A twin this script did not write — two rows for one (key, phase) is a shape
# the upsert never produces — is refused before anything is touched: the
# engine reads the LAST row, so "fixing" the duplicates here would silently
# decide which of two hand-written answers was meant.
dupes="$(awk -v k="$key" -v ph="$phase_cell" '
  function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
  /^[[:space:]]*\|/ { n=split($0, c, "|"); cell=trim(c[2]); gsub(/[*`]/,"",cell); if (cell == k && trim(c[9]) == ph) d++ }
  END { print d + 0 }' "$f")"
if [ "$dupes" -gt 1 ]; then
  echo "decisions.sh: $f carries $dupes rows for $key${phase:+ (phase $phase)} — a row this script did not write; edit it by hand" >&2
  exit 1
fi

# Upsert the (key, phase) row: replace in place if present, else append to the
# contiguous end-of-file table.
awk -v k="$key" -v ph="$phase_cell" -v val="$value" -v who="$by" -v st="$state" -v bl="$blocking" -v src="$source_word" -v ev="$evidence" '
  function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
  function row(){ return "| `" k "` | " val " | " who " | " st " | " bl " | " src " | " ev " | " ph " |" }
  BEGIN{ done=0 }
  {
    if ($0 ~ /^[[:space:]]*\|/) {
      n=split($0, c, "|"); cell=trim(c[2]); gsub(/[*`]/,"",cell); pcell=trim(c[9])
      if (cell == k && pcell == ph) { print row(); done=1; next }
    }
    print
  }
  END{ if (!done) print row() }
' "$f" > "$tmp"
if cmp -s "$tmp" "$f"; then rm -f "$tmp"; else mv "$tmp" "$f"; fi

# ---- the read-back ------------------------------------------------------------
answer="$(engine_rows "$phase")" \
  || { echo "decisions.sh: the row is written, but phase-graph.sh could not read $f back (see above)" >&2; exit 1; }
got="$(printf '%s\n' "$answer" | awk -F'\t' -v k="$key" '$1 == k { print $2 "\t" $3 "\t" $4 "\t" $5; exit }')"
want="$(printf '%s\t%s\t%s\t%s' "$state" "$by" "$blocking" "$source_word")"
[ "$got" = "$want" ] || {
  echo "decisions.sh: wrote $key = $state ($source_word, by $by${phase:+, phase $phase}), but phase-graph.sh --decisions reads \"$got\" — $f carries a row this script did not write; edit it by hand" >&2
  exit 1
}
printf '%s\n' "$answer" | awk -F'\t' -v k="$key" '$1 == k'
exit 0

#!/usr/bin/env bash
# Record (or revoke) a phase-gate approval in docs/handoffs/<slug>/gate-status.md —
# the clearance record scripts/phase-graph.sh --gate-status reads. An approved row
# clears a gate of ANY kind (human, ai, auto): it is the operator's override from
# the console's Gate card, or an AI session's recorded evidence that it verified
# and did the gate work itself. Deterministic upsert so the console and sessions
# never hand-edit the table inconsistently (idempotent, atomic tmp+mv, no git —
# the caller commits).
#
# A separate file from test-status.md ON PURPOSE: that file's existence switches
# QA gating on, and approving a gate must never flip an unrelated regime.
#
# A MANUAL gate is a person's (control-tower phase 107, #174). An unattended
# session once cleared one as `ai-session-delegated` and then changed production
# data. The `--by` text is whatever the caller writes, so it is never the
# witness: this script names the DOOR it was invoked through from its own
# environment and records it in the row's `Door` cell —
#   session   any session marker: `PE_OWNER=autopilot/*|console/*`, an outcome
#             file, a session kind, a Claude Code shell (`CLAUDECODE=1`);
#   console   the console's own write path (`PE_GATE_DOOR=console`), which sets
#             it only for a person's press — the Gate card, a phone's Approve,
#             a chat act a person confirmed — and never from a session;
#   terminal  a person's shell: stdin is a terminal, and no session marker;
#   script    anything else.
# A gate whose kind is `human` (a `manual` Gate-check, or a type the engine does
# not know, which it reads as manual) is approved only through `console` or
# `terminal`, and never by an approver named like an automatic one (`ai-*`,
# `autopilot*`, `console/*`); --gate-status ignores a manual row any other door
# wrote. A revoke is taken from any door: closing a gate is nobody's privilege.
#
# Usage: gate-approve.sh <slug> <phase> [--by WHO] [--note TEXT] [--revoke]
set -euo pipefail
slug="${1:?usage: gate-approve.sh <slug> <phase> [--by WHO] [--note TEXT] [--revoke]}"
phase="${2:?phase number required}"
shift 2
by=""; note="-"; verdict="yes"
while [ $# -gt 0 ]; do
  case "$1" in
    --by)     by="${2:?--by needs a name}"; shift 2 ;;
    --note)   note="${2:?--note needs text}"; shift 2 ;;
    --revoke) verdict="revoked"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$phase" in ''|*[!0-9]*) echo "phase must be a number, got: $phase" >&2; exit 2 ;; esac

# Who cleared it. Defaults to the autopilot's exported owner, else user@host —
# the same identity phase-lock.sh records, so the two artifacts read alike.
[ -n "$by" ] || by="${PE_OWNER:-$(whoami 2>/dev/null || echo operator)@$(hostname -s 2>/dev/null || hostname)}"
# Table cells: one line, no pipes, bounded.
by="$(printf '%s' "$by" | tr -d '|' | tr '\r\n\t' '   ' | cut -c1-64)"
note="$(printf '%s' "$note" | tr '\r\n\t|' '    ' | sed 's/  */ /g; s/^ //; s/ *$//' | cut -c1-200)"
[ -n "$note" ] || note="-"
# PE_TODAY keeps test assertions off the wall clock (close-plan.sh precedent).
today="$(printf '%s' "${PE_TODAY:-$(date +%F)}" | tr -d '|' | tr '\r\n\t' '   ' | cut -c1-32)"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"

# The door (see the header). Session markers first, so a session can never
# borrow the console's door by exporting its word.
door="script"
case "${PE_OWNER:-}" in autopilot/*|console/*) door="session" ;; esac
if [ "$door" = script ]; then
  if [ -n "${PE_OUTCOME_FILE:-}" ] || [ -n "${PE_SESSION_KIND:-}" ] || [ "${CLAUDECODE:-}" = "1" ]; then
    door="session"
  elif [ "${PE_GATE_DOOR:-}" = "console" ]; then
    door="console"
  elif [ -t 0 ]; then
    door="terminal"
  fi
fi

# A manual gate is a person's. The kind is the engine's answer, and a read that
# fails is treated as manual — the safe side of a person's gate.
if [ "$verdict" = yes ]; then
  kind="$(DOCS_ROOT="$DOCS_ROOT" "$SCRIPT_DIR/phase-graph.sh" "$slug" --gate-kind "$phase" 2>/dev/null)" || kind="human"
  if [ "$kind" = human ]; then
    automatic=""
    case "$(printf '%s' "$by" | tr '[:upper:]' '[:lower:]')" in
      ai-*|ai_*|"ai "*|autopilot*|console/*) automatic="yes" ;;
    esac
    if [ -n "$automatic" ] || { [ "$door" != console ] && [ "$door" != terminal ]; }; then
      {
        if [ -n "$automatic" ]; then
          printf 'refused: phase %s of %s has a MANUAL gate — a person'\''s to clear — and "%s" names an automatic approver.\n' "$phase" "$slug" "$by"
        else
          printf 'refused: phase %s of %s has a MANUAL gate — a person'\''s to clear — and this approval comes through the %s door, not a person'\''s.\n' "$phase" "$slug" "$door"
        fi
        printf 'A person approves it on the console'\''s Gate card (plan → phase %s → Approve), or runs this in their own terminal:\n' "$phase"
        printf '    gate-approve.sh %s %s --by "<your name>" --note "<what was done>"\n' "$slug" "$phase"
        printf 'An unattended session never clears a manual gate: hand off and declare what the gate needs —\n'
        printf '    phase-outcome.sh %s %s needs-human --needs gates --reason "<what the gate needs>"\n' "$slug" "$phase"
      } >&2
      exit 1
    fi
  fi
fi

dir="$DOCS_ROOT/docs/handoffs/$slug"
mkdir -p "$dir"
f="$dir/gate-status.md"
if [ ! -f "$f" ]; then
  {
    printf '# Gate approvals — %s\n\n' "$slug"
    printf 'Per-phase gate clearances recorded by phased-execution'\''s gate step (the console'\''s\n'
    printf 'Gate card, an AI session that verified the conditions, or gate-approve.sh by hand).\n'
    printf 'The engine reads the "Approved" column: a `yes` row clears that phase'\''s gate —\n'
    printf 'every kind — so the phase can start; `revoked` restores the gate. A MANUAL gate is\n'
    printf 'cleared only by a row whose "Door" is a person'\''s (`console` or `terminal`). This is\n'
    printf 'NOT the QA table: it deliberately lives apart from test-status.md, whose very\n'
    printf 'existence switches QA gating on.\n\n'
    printf '## Gate approvals\n\n| Phase | Approved | By | Date | Note | Door |\n|------:|----------|----|------|------|------|\n'
  } > "$f"
fi

# Upsert the row for this phase: replace in place if present, else append to the
# (contiguous, end-of-file) table. A table written before the Door column gains
# it here — its header and separator widened once, its older rows kept as they
# are (no door named: they clear no manual gate).
tmp="$f.tmp.$$"
# The cells reach awk through ENVIRON, never `-v`: awk decodes escapes in a
# `-v` value, so a note carrying the two characters `\n` (or `\174`, a pipe)
# would print a real newline and a forged row — another phase, a person's door
# (control-tower phase 107). ENVIRON values arrive verbatim.
GA_PHASE="$phase" GA_VERDICT="$verdict" GA_WHO="$by" GA_DATE="$today" GA_NOTE="$note" GA_DOOR="$door" awk '
  function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
  BEGIN{
    ph=ENVIRON["GA_PHASE"]; v=ENVIRON["GA_VERDICT"]; who=ENVIRON["GA_WHO"]
    d=ENVIRON["GA_DATE"]; note=ENVIRON["GA_NOTE"]; door=ENVIRON["GA_DOOR"]
    done=0; widen=0
  }
  {
    if ($0 ~ /^[[:space:]]*\|/) {
      n=split($0, c, "|"); cell=trim(c[2]); gsub(/[*`]/,"",cell)
      if (tolower(cell) == "phase" && $0 !~ /\|[[:space:]]*Door[[:space:]]*\|/) {
        sub(/[[:space:]]*$/, ""); print $0 " Door |"; widen=1; next
      }
      if (widen && cell ~ /^:?-+:?$/) { sub(/[[:space:]]*$/, ""); print $0 "------|"; widen=0; next }
      widen=0
      if (cell == ph) { printf "| %s | %s | %s | %s | %s | %s |\n", ph, v, who, d, note, door; done=1; next }
    }
    print
  }
  END{ if (!done) printf "| %s | %s | %s | %s | %s | %s |\n", ph, v, who, d, note, door }
' "$f" > "$tmp" && mv "$tmp" "$f"

if [ "$verdict" = yes ]; then
  echo "approved: $slug phase $phase by $by on $today (the $door door)  ->  $f"
else
  echo "revoked: $slug phase $phase by $by on $today (the $door door)  ->  $f"
fi
exit 0

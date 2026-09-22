#!/usr/bin/env bash
# Phase-graph engine for phased-execution.
#
# Treats a plan as a DAG, not a linear chain. Reads the dependency structure from
# the plan's "## Phase graph" markdown table (Depends-on column) and the LIVE
# per-phase status from each handoff's frontmatter, then computes for every phase:
#   done | in-progress | stuck | ready | waiting
# (the five BOARD_BUCKETS, owned by viewer/shared/status-vocab.js: `stuck` is a
# handoff that says `blocked`, folded by phase_status() before the board sees it.)
# "ready" = not started AND every dependency is done. This is what lets phases run
# concurrently and out of order: readiness is computed from the done-SET, never from
# a linear cursor. A plan is finished only when EVERY phase is done — not when the
# highest-numbered phase is reached.
#
# Usage:
#   phase-graph.sh <slug>                 # human status board (default; shows SUGGESTED BATCHES)
#   phase-graph.sh <slug> --ready         # space-separated ready phase numbers
#   phase-graph.sh <slug> --ready-after N # ready set assuming phase N just completed
#   phase-graph.sh <slug> --dependents N  # phases that list N as a dependency (static)
#   phase-graph.sh <slug> --deps N        # N's own dependencies (space-separated)
#   phase-graph.sh <slug> --gated N       # "yes"/"no"
#   phase-graph.sh <slug> --gate-kind N   # gate category: human|ai|auto|none
#   phase-graph.sh <slug> --gate-status N # evaluate the gate (exit 0 clear, 1 blocked/manual/ai/unevaluated)
#   phase-graph.sh <slug> --size N        # rough working-set size of phase N (S|M|L; default M)
#   phase-graph.sh <slug> --repos N       # phase N's SCOPE as normalized csv (Repos column; "" → all)
#   phase-graph.sh <slug> --boot-prompt N # full copy-paste boot prompt for phase N
#   phase-graph.sh <slug> --mcp [N]       # MCP servers the plan (or phase N: plan ∪ bullet) needs, csv
#   phase-graph.sh <slug> --mcp-policy [N] # continue | require | "" (the plan's word, phase overriding)
#   phase-graph.sh <slug> --decisions [N] # the decision manifest: key<TAB>state<TAB>owner<TAB>blocking<TAB>source<TAB>value
#                                         # per row — the plan's `## Decisions` table with docs/handoffs/<slug>/
#                                         # decisions.md merged over it (and phase N's rows over both)
#   phase-graph.sh <slug> --credentials [N] # credential ids the plan (or phase N: plan ∪ bullet) needs, csv
#   phase-graph.sh <slug> --credential-policy [N] # require | continue | "" (like --mcp-policy)
#   phase-graph.sh <slug> --qa-exhausted         # waive | halt | <owner> | "" (the `**QA exhausted:**` line)
#   phase-graph.sh <slug> --person-check N       # allow | halt | <owner> | "" (the phase's `- **Person-check:**` bullet)
#   phase-graph.sh <slug> --accounts      # the `**Accounts:**` line as id<TAB>minHeadroom per line
#   phase-graph.sh <slug> --wait-budget [N] # minutes<TAB>phase|plan — how long a phase may stay parked on
#                                         # its declared waits (the phase's `Waits on:` max, else the plan's
#                                         # `Wait budget:`); nothing when the plan is silent (the console default)
#   phase-graph.sh <slug> --waits-on N    # the refs phase N's `- **Waits on:**` bullet names, one per line
#   phase-graph.sh <slug> --checkout N    # the phase's `- **Checkout:**` branch, verbatim
#   phase-graph.sh <slug> --land [N]      # hold|integrate|pr|trunk<TAB>phase|plan|default
#   phase-graph.sh <slug> --gitlink [N]   # bump|leave<TAB>phase|plan|default
#   phase-graph.sh <slug> --isolation [N] # shared|worktree<TAB>phase|plan — or nothing (the run decides)
#   phase-graph.sh <slug> --issues [N]    # off|draft|file<TAB>phase|plan|default
#   phase-graph.sh <slug> --conflict-policy # halt|park|rebase-session<TAB>plan|default  (plan-wide)
#   phase-graph.sh <slug> --messaging       # on|off<TAB>plan|default                    (plan-wide)
#   phase-graph.sh <slug> --base-branch     # <ref><TAB>plan|default                     (plan-wide)
#   phase-graph.sh <slug> --clash-zones     # the paths two phases must never both touch, csv
#   phase-graph.sh <slug> --landing N     # the landing LEDGER's row for phase N, as TSV (nothing = no record)
#   phase-graph.sh <slug> --notes N       # what phase N is handed: source<TAB>note per line
#   phase-graph.sh <slug> --session-plan [model|budget]
#                                         # propose which REMAINING phases to batch into one session,
#                                         # sized to a model's budget (haiku|sonnet|opus|fable) or a
#                                         # raw token number. Groups cut only at unmet deps, GATED
#                                         # phases, QA boundaries, and the budget. See references/sizing.md.
#
# Run from the repo root that owns docs/, or set DOCS_ROOT.
set -euo pipefail

slug="${1:?usage: phase-graph.sh <slug> [--lint|--qa-mode|--qa-result N|--qa-history N|--qa-prompt N|--gate-status N|--gate-kind N|--memory-block|--verified|--plan-status|--closed|--ready|--ready-after N|--dependents N|--deps N|--gated N|--size N|--repos N|--mcp [N]|--mcp-policy [N]|--decisions [N]|--credentials [N]|--credential-policy [N]|--accounts|--qa-exhausted|--person-check N|--wait-budget [N]|--waits-on N|--checkout N|--land [N]|--landing N|--base-branch|--gitlink [N]|--conflict-policy|--isolation [N]|--clash-zones|--issues [N]|--messaging|--notes N|--boot-prompt N|--session-plan [model|budget]]}"
mode="${2:-board}"
arg="${3:-}"

# Normalise a phase argument at the door. Handoff FILES are `phase-08-*.md`, so
# `--boot-prompt 08` and `--deps 08` are what a person (and a prompt that copied
# the filename) actually type — and `08` is not a number to bash: every array
# subscript and every `printf '%02d'` below evaluates it as octal and fails.
# One place, once, so nothing downstream has to remember. `--session-plan` is the
# only mode whose argument is not a phase — it takes a model or a raw budget.
# `--mcp`'s phase argument is OPTIONAL, which is not a reason to exclude it: an
# absent argument already falls through the `''` arm below untouched, while
# excluding the mode meant `--mcp 08` answered about no phase at all (empty
# server list) where `--mcp-policy 08` answered about phase 8. A phase that
# declares an MCP server would have boarded without it, for a padded number that
# is exactly what the handoff FILENAME says.
case "$mode" in
  --session-plan) ;;
  *) case "$arg" in
       ''|*[!0-9]*) ;;                       # empty, or not a bare number: leave it
       *)           arg=$((10#$arg)) ;;
     esac ;;
esac

# Script dir — portable across accounts/clones (F13): never hardcode ~/.claude.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# One bash reading of the Repos column, shared with phase-lock.sh.
# shellcheck source=/dev/null
. "$SCRIPT_DIR/scope.sh"

# F5: single source of truth for sizing + budgets. Canonical values live in
# scripts/sizing.env (also documented in references/sizing.md); these defaults are
# a fallback so the script still runs if the file is ever missing.
SIZE_S=15000; SIZE_M=40000; SIZE_L=90000
BUDGET_HAIKU=40000; BUDGET_BIG=200000; BUDGET_DEFAULT=40000; BUDGET_1M=200000
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/sizing.env" ] && . "$SCRIPT_DIR/sizing.env"

# F5, same shape: the MODEL vocabulary — which aliases exist, in what strength
# order, which of them are in the big budget class, and the window suffix the
# CLI understands. Canonical values live in scripts/models.env; the console
# parses the same file (viewer/server/runner/models.ts) and a drift test pins
# the two readers together.
MODEL_ALIASES="fable opus sonnet haiku"
MODEL_BIG="fable opus sonnet mythos"
MODEL_1M_SUFFIX="[1m]"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/models.env" ] && . "$SCRIPT_DIR/models.env"

# F5, same shape: what an attached MCP server costs a phase's working set.
# Canonical values live in scripts/mcp.env (documented in references/sizing.md).
MCP_SURCHARGE=1500; MCP_SURCHARGE_MAX=12000
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/mcp.env" ] && . "$SCRIPT_DIR/mcp.env"

# F5, same shape: the verification-command vocabulary (cwd-sensitive leads,
# names never worth a resolution warning, the external-clock waits). Canonical
# values live in scripts/verify.env; the console's runner parses the same file.
CWD_SENSITIVE="docker docker-compose pnpm npm yarn task make just pytest go cargo alembic vitest jest tsc node"
PREFLIGHT_SKIP="cd true false echo printf test pwd env which bash sh command export set time if then fi elif else for while until do done case esac"
EXTERNAL_WAIT='gh run watch|gh pr checks[^`]*--watch| --watch([^A-Za-z]|$)|task deploy|sleep [0-9]{3,}|sleep [6-9][0-9]([^0-9]|$)|sleep [0-9]+[mh]|until [^`]+; *do|until [^`]+ do |while (true|:) *; *do|while \[\[? [^`]+; *do|while test [^`]+; *do|while \(\( [^`]+; *do|while sleep [^`]+; *do|while ! [^`]+; *do|watch -n|aws [a-z0-9-]+ wait |kubectl rollout status|docker[ -]compose logs -f|docker[ -]compose up( |$)|tail -f'
EXTERNAL_WAIT_ALLOW='docker[ -]compose up (-d|--detach)|phase-outcome\.sh [^;&|]*'
# The sed delimiter for the carve-out above: a control character, because the
# value is a regex and every printable delimiter is a character it might carry.
_CARVE=$(printf '\001')
SETUP_LEADS='docker[ -]compose up|docker start |npm ci|npm install|pnpm install|yarn install|bundle install|pip install|uv sync|poetry install|terraform init|alembic upgrade|minikube start|kind create cluster|vagrant up|sleep [0-9]'
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/verify.env" ] && . "$SCRIPT_DIR/verify.env"

# shellcheck source=/dev/null
. "$SCRIPT_DIR/instance.sh"
DOCS_ROOT="$(pe_docs_root)"
plan_file="$DOCS_ROOT/docs/plans/${slug}.md"
handoff_dir="$DOCS_ROOT/docs/handoffs/${slug}"

# The prefix EVERY generated command carries. A printed line is pasted into a
# session whose cwd nobody here controls, and the skill scripts resolve their
# own docs root from that cwd (`pe_docs_root`: $DOCS_ROOT → the outermost
# superproject of the cwd → … → pwd). So a bare `bash …/gate-approve.sh` records
# the approval in whatever repository the reader happens to be sitting in —
# measured live on 2026-09-17, when a pe-hub plan's gate line read from a hub
# session would have written `gate-status.md` into hub. Naming the root the plan
# was actually read from is the whole fix: it is the one fact the generator
# knows and the reader cannot.
CMD="DOCS_ROOT=$DOCS_ROOT bash $SCRIPT_DIR"

if [ ! -f "$plan_file" ]; then
  printf 'ERROR: plan not found: %s\n' "$plan_file" >&2
  printf '  → run from the repo root, or set DOCS_ROOT: DOCS_ROOT=/path/to/repo %s ...\n' "$(basename "$0")" >&2
  if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
    printf '  ⚠️  not inside a git repo (root fell back to %s) — set DOCS_ROOT explicitly.\n' "$DOCS_ROOT" >&2
  fi
  exit 1
fi

memory_key="$(grep -m1 '^memory:' "$plan_file" 2>/dev/null \
  | sed 's/^memory:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
memory_key="${memory_key:-project_${slug}}"

# ---------------------------------------------------------------------------
# Closure. Progress is computed from the handoffs; "does anyone still care?" cannot
# be, so it is stored in the plan's own `status:`. A terminal status means CLOSED:
# the board still renders, but the plan stops reporting work, warnings and prompts.
# Values in the wild carry a trailing "# active | complete | …" legend — strip it.
# ---------------------------------------------------------------------------
_fm_field() {  # _fm_field <name> — first frontmatter-style value, legend stripped
  grep -m1 "^$1:" "$plan_file" 2>/dev/null \
    | sed "s/^$1:[[:space:]]*//; s/[[:space:]]*#.*\$//; s/[[:space:]]*\$//" || true
}
PLAN_STATUS="$(_fm_field status)"
PLAN_STATUS="$(printf '%s' "${PLAN_STATUS:-active}" | tr '[:upper:]' '[:lower:]')"
PLAN_STATUS="${PLAN_STATUS%% *}"
PLAN_CLOSED_ON="$(_fm_field closed)"
PLAN_CLOSED_REASON="$(_fm_field closed_reason)"
case "$PLAN_STATUS" in
  complete|abandoned|superseded) PLAN_CLOSED=1 ;;
  *)                             PLAN_CLOSED=0 ;;
esac

plan_is_closed() { [ "$PLAN_CLOSED" = 1 ]; }

# The one-line banner every closed-plan surface prints.
closed_banner() {
  local extra=""
  [ -n "$PLAN_CLOSED_REASON" ] && extra=" — $PLAN_CLOSED_REASON"
  [ -n "$PLAN_CLOSED_ON" ] && extra="$extra (closed $PLAN_CLOSED_ON)"
  printf '🔒 CLOSED [%s]%s\n' "$PLAN_STATUS" "$extra"
  printf '   This plan no longer reports work or warnings. Reopen it with:\n'
  printf '   %s/close-plan.sh %s --reopen\n' "$CMD" "$slug"
}

# ---------------------------------------------------------------------------
# Scan the Phase-graph table ONCE and emit everything derived from it.
#
# En/em dashes are normalised to ASCII '-' up front so range tokens (1-7) and the
# "none" marker (a lone dash, no digits) are both handled by one ASCII parser.
# Ranges like 1-7 expand to 1 2 3 4 5 6 7; "(+8-10)" → 8 9 10.
#
# Columns are found by NAME, not by position (F20). The old parser hardcoded
# $4 = Depends-on and $6 = Repos, which is only true of the canonical six-column
# table; dropping the decorative "Parallel-safe with" column shifted Exit
# criteria into the Repos slot and every phase got a fabricated scope, so two
# sessions were cleared onto one working tree by the very check that exists to
# stop that. The header row is read once and mapped; a header that names no
# Repos (or no Depends-on) column yields an EMPTY cell rather than whatever
# happens to sit at position 6 — a wrong answer dressed as a real one is worse
# than none, and F20 names it either way. Only a table with no header row at all
# falls back to 4/6, which is what such a table has always meant.
#
# Records, one per line, US (\037) separated — tab is IFS-whitespace, so an
# empty field between two tabs would coalesce and shift the next one out:
#   HDR  ncols  deps-col  repos-col  title-col  header|missing
#   ROW  phase  deps      title      repos      dropped-tokens
#   RAG  phase  cells                             (row shape ≠ header shape)
#   DUP  phase                                    (a repeated Phase cell)
#   PAD  raw-cell                                 (a zero-padded Phase cell)
# A column index of -1 means "the header has no such column".
# ---------------------------------------------------------------------------
_table_scan() {
  # Scope strictly to the "## Phase graph" table block (the consecutive | rows
  # after that heading) so OTHER pipe tables in the plan (repo legends, risk
  # tables, …) can never be misread as phase rows.
  sed 's/–/-/g; s/—/-/g' "$plan_file" | awk -F'|' '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    function clean(s){ s = trim(s); gsub(/[*`]/, "", s); return trim(s) }
    BEGIN { US = "\037"; di = 0; ri = 0; ti = 0; hdr = 0; ncols = 0 }
    tolower($0) ~ /^##[[:space:]]+phase graph/ { inpg=1; seen=0; next }
    inpg && seen && $0 !~ /^[[:space:]]*\|/ { inpg=0 }
    inpg && /^[[:space:]]*\|/ {
      seen=1
      # A trailing pipe leaves an empty field after the last cell; without one the
      # last field IS a cell. Count real cells either way.
      cells = ($0 ~ /\|[[:space:]]*$/) ? NF - 2 : NF - 1
      ph = clean($2)

      # The first pipe row that is not a phase row is the header.
      if (!hdr && ph !~ /^[0-9]+$/) {
        hdr = 1; ncols = cells
        # Bounded by the CELL count, not by NF-1, for the same reason the row
        # loop is: without a trailing pipe the last field IS a cell, so
        # `NF - 1` stopped one column short and a header whose LAST column was
        # `Repos` or `Depends on` was never found. `di`/`ri` then fell back to
        # -1 — a plan whose every phase read scope `all` (so nothing could ever
        # run beside anything) and whose every dependency vanished (so every
        # phase read `ready` at once). Cell i lives in field i+1, hence cells+1.
        for (i = 2; i <= cells + 1; i++) {
          c = tolower(clean($i))
          if (c ~ /depends/)     di = i
          else if (c ~ /^repos/) ri = i
          else if (c ~ /^title/) ti = i
        }
        if (di == 0) di = -1
        if (ri == 0) ri = -1
        if (ti == 0) ti = 3
        print "HDR" US ncols US di US ri US ti US "header"
        next
      }
      if (ph !~ /^[0-9]+$/) next             # separator / prose rows

      if (!hdr) {                            # no header at all: the historic shape
        hdr = 1; ncols = cells; di = 4; ri = 6; ti = 3
        print "HDR" US ncols US di US ri US ti US "missing"
      }
      if (cells != ncols) print "RAG" US ph US cells

      # `08` is a legal-looking phase cell that is not a legal octal number, and
      # every consumer downstream is a bash array subscript or a printf %02d.
      # Normalise once, here, so nothing below ever sees a padded number — and
      # name it, because a plan that writes one will keep writing them (F21).
      if (length(ph) > 1 && substr(ph, 1, 1) == "0") print "PAD" US ph
      ph = ph + 0
      if (ph in seen_ph) { print "DUP" US ph; next }   # first row wins
      seen_ph[ph] = 1

      title = (ti > 0) ? clean($(ti)) : ""
      repos = (ri > 0) ? clean($(ri)) : ""            # Repos column = the SCOPE
      raw   = (di > 0) ? clean($(di)) : ""            # Depends-on column
      gsub(/[^0-9-]+/, " ", raw)             # keep only digits + hyphens (range marks)
      out = ""; dropped = ""
      n = split(raw, toks, /[ ]+/)
      for (i = 1; i <= n; i++) {
        t = toks[i]
        if (t == "" || t == "-") continue    # "-" is the explicit "no deps" marker
        if (t ~ /^[0-9]+$/) { out = out " " (t + 0); continue }
        if (t ~ /^[0-9]+-[0-9]+$/) {         # range A-B → A..B
          split(t, r, "-")
          a = r[1] + 0; b = r[2] + 0
          if (a <= b) { for (j = a; j <= b; j++) out = out " " j; continue }
        }
        # Anything else — `2-`, `3-1`, `1--2` — used to vanish without a trace,
        # and a dependency that vanishes makes a phase READY before the work it
        # depends on has run. Keep it, name it (F21), and let the lint gate.
        dropped = dropped " " t
      }
      sub(/^ /, "", out); sub(/^ /, "", dropped)
      print "ROW" US ph US out US title US repos US dropped
    }'
}

# One scan, many readers: the rows load the graph, the HDR/RAG/DUP/PAD records
# feed F20/F21. Computed once because every consumer wants the SAME answer —
# a lint that re-parsed could describe a table the board never saw.
TABLE_SCAN=""

_table_record() {  # _table_record <kind>  → that kind's records, kind stripped
  printf '%s\n' "$TABLE_SCAN" | awk -F'\037' -v k="$1" '$1 == k { sub(/^[^\037]*\037/, ""); print }'
}

# The phase rows alone: "phase<US>deps<US>title<US>repos<US>dropped".
parse_table() { _table_record ROW; }

# Gated detection: reuse the heading convention (### Phase N … *(GATED)*).
# Case-SENSITIVE on purpose. The marker is uppercase; matching case-insensitively also fires on
# lowercase prose in the row ("born-gated" terraform, "assignment-gated" review, "user-gated"),
# which freezes a ready phase behind a gate the plan never declared.
is_gated() {  # is_gated <phase>  → echoes yes|no
  if grep -q "^### Phase ${1}\b.*GATED" "$plan_file" 2>/dev/null \
     || grep -qE "^\|[[:space:]]*${1}[[:space:]]*\|.*GATED" "$plan_file" 2>/dev/null; then
    echo yes
  else
    echo no
  fi
}

# A gated phase's full gate conditions: the "- **Gates (must clear first):** …"
# bullet INCLUDING its continuation lines (indented prose, or the numbered
# operator steps a human gate carries), up to the next bullet. Block-scoped via
# the same awk shape as phase_block — the old grep -A6 window went blind past
# six lines and its head -1 truncated multi-line gates mid-sentence, so the boot
# prompt showed a fragment of the instructions the console rendered in full.
gate_conditions() {  # gate_conditions <phase>  (may be multi-line)
  phase_block "$1" | awk '
    inb && (/^[[:space:]]*[-*][[:space:]]/ || /^###/) { exit }
    inb { sub(/^[[:space:]]+/, ""); print; next }
    /^[[:space:]]*[-*].*[Gg]ates \(must clear/ {
      line=$0
      sub(/.*[Gg]ates[^:]*:[[:space:]]*/, "", line)
      gsub(/\*/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (length(line)) print line
      inb=1
    }
  '
}

# One-line form for status verdicts and other single-line surfaces.
gate_conditions_line() {  # gate_conditions_line <phase>
  gate_conditions "$1" | tr '\n' ' ' | sed 's/[[:space:]][[:space:]]*/ /g; s/[[:space:]]*$//'
}

# Lines of the "### Phase N" block (until the next ### Phase / ## heading) — read
# per-phase directives without spilling into a neighbour's block (F12).
phase_block() {  # phase_block <phase>
  awk -v want="$1" '
    /^###[[:space:]]+[Pp]hase[[:space:]]+[0-9]+/ {
      h=$0; sub(/^###[[:space:]]+[Pp]hase[[:space:]]+/,"",h); sub(/[^0-9].*/,"",h)
      cur=(h==want)?1:0
    }
    /^##[[:space:]]/ && cur { cur=0 }   # a new ## section ends the block
    cur { print }
  ' "$plan_file"
}

# F12: the machine-checkable "- **Gate-check:** <type> <value>" directive, if any.
gate_check_directive() {  # gate_check_directive <phase>
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*].*gate-check' \
    | sed -E 's/.*[Gg]ate-check[^:]*:[[:space:]]*//; s/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
    | head -1 || true
}

# The per-phase MCP directive: backticked server names on a "- **MCP:** `a`, `b`"
# bullet inside the ### Phase N block. Block-scoped through phase_block for the
# same reason Gate-check is (F12) — a grep window would read a neighbour's line.
# Empty if none. The names are registry ids, not URLs: what a phase states is
# WHICH server it needs, never how to reach it, because the how is per-machine
# and belongs to the console's registry.
mcp_directive() {  # mcp_directive <phase>
  # `|| true` throughout: a no-match grep mid-pipe exits 1, which under
  # `set -euo pipefail` would abort every caller (--boot-prompt included).
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*][[:space:]]*\*{0,2}MCP\*{0,2}[[:space:]]*:' \
    | head -1 | grep -oE '`[^`]+`' | tr -d '`' | paste -sd ',' - | sed 's/,/, /g' || true
}

# The gate-check vocabulary + its human/ai/auto category split. Canonical
# values live in scripts/gates.env — ONE source shared with the console (F5
# pattern, like sizing.env: viewer/server/analysis/gates.ts reads the same
# file), so --gate-status, --lint and the UI cannot drift apart. A directive
# whose type is not on the list is treated as manual (fail-safe) AND fails
# --lint (F24) rather than passing silently: a typo used to demote an automated
# gate to a human one with no warning. A *(GATED)* heading with NO directive
# reads as GATE_DEFAULT (`ai` since 5.0.0 — the sep-review audit found 15 of
# 143 gated headings demanding a person by accident of the old `human`
# fallback) and ALSO fails --lint (F24): the default answers the board, the
# lint makes the author say it. These defaults keep the script alive if the
# file is ever missing.
GATE_TYPES="phase phases plan cmd date deadline by manual ai landed pr-merged"
GATE_TYPES_HUMAN="manual"
GATE_TYPES_AI="ai"
GATE_DEFAULT="ai"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/gates.env" ] && . "$SCRIPT_DIR/gates.env"

# Where a phase's work happens and where it lands (5.1.0) — the OWNERS are
# viewer/shared/landing-model.js and viewer/shared/worktree-model.js, and
# scripts/landing.env is their bash twin, held equal by
# viewer/test/gates-vocab.test.ts. Read by --land, --base-branch, --gitlink,
# --conflict-policy, --isolation, the landed/pr-merged gates and lints F27/F28
# here; by scripts/phase-landing.sh beside this script.
LAND_POLICIES="hold integrate pr trunk"
DEFAULT_LAND="hold"
GITLINK_POLICIES="bump leave"
DEFAULT_GITLINK="bump"
CONFLICT_POLICIES="halt park rebase-session"
DEFAULT_CONFLICT="halt"
# Five of these are a VOCABULARY this script does not itself read — they are
# the bash half of `viewer/shared/landing-model.js`, held to it by
# `gates-vocab.test.ts`, and read by `scripts/phase-landing.sh` and by a person.
# shellcheck disable=SC2034  # vocabulary: asserted by gates-vocab.test.ts, read by phase-landing.sh
BASE_BRANCH_WORDS="origin/HEAD head"
DEFAULT_BASE_BRANCH="origin/HEAD"
# shellcheck disable=SC2034  # vocabulary — see above
LANDING_STATES="held integrated pushed pr-open pr-merged landed conflict failed"
LANDED_BY_POLICY="hold:held integrate:integrated pr:pr-merged trunk:landed"
PR_MERGED_STATES="pr-merged"
ISOLATION_DIRECTIVES="shared worktree"
# shellcheck disable=SC2034  # vocabulary — see above
WORKTREE_RETENTION="prune keep-on-failure keep"
# shellcheck disable=SC2034  # vocabulary — see above
DEFAULT_RETENTION="keep-on-failure"
# shellcheck disable=SC2034  # vocabulary — see above
WORKTREE_LOCK_PREFIXES="phase-console"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/landing.env" ] && . "$SCRIPT_DIR/landing.env"

# What a message between two sessions is spelled with (5.1.0) — the OWNER is
# viewer/shared/message-model.js, twin scripts/messages.env. Only --messaging
# and --notes read it here; phase-msg.sh reads the rest.
MESSAGING_WORDS="on off"
DEFAULT_MESSAGING="on"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/messages.env" ] && . "$SCRIPT_DIR/messages.env"

# What a session may ask to have filed (5.1.0) — the OWNER is
# viewer/shared/issues-model.js, twin scripts/issues.env.
ISSUE_MODES="off draft file"
DEFAULT_ISSUES="off"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/issues.env" ] && . "$SCRIPT_DIR/issues.env"

# The decision manifest's vocabulary (chapter 13 §1.1) — the OWNER is
# viewer/shared/decisions-model.js and scripts/decisions.env is its bash twin,
# held equal by viewer/test/decisions-model.test.ts. Read by --decisions, the
# F25 lint and the boot prompt here; by decisions.sh (the twin writer) and
# phase-outcome.sh (--needs) beside this script.
DECISION_KEYS="permission.policy permission.destructive issues credentials accounts mcp gates verification.person-check qa.exhausted waits human-acts ambiguity budgets resume.on-restart plan-health stop relay announce"
DECISION_STATES="answered outstanding waived"
DECISION_SOURCES="plan run default ruling"
NEED_CLASSES="lock permission credential gate external"
# shellcheck source=/dev/null
[ -f "$SCRIPT_DIR/decisions.env" ] && . "$SCRIPT_DIR/decisions.env"

_gate_type_known() {  # _gate_type_known <type>
  case " $GATE_TYPES " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# Which category a phase's gate falls into — drives the boot prompt, the
# console's Gate card and the runner's park-vs-proceed decision.
#   human — a person must act (manual gates; unknown types — fail-safe, and a
#           lint failure)
#   ai    — an AI session may verify/do/clear it (a person may still approve);
#           also what a *(GATED)* heading with no Gate-check line reads as
#           (GATE_DEFAULT, gates.env — the audit's bias, and a lint failure)
#   auto  — the engine evaluates it by itself
#   none  — not gated
gate_kind() {  # gate_kind <phase> → human|ai|auto|none
  local gc gtype
  [ "$(is_gated "$1")" = yes ] || { echo none; return; }
  gc="$(gate_check_directive "$1")"
  [ -z "$gc" ] && gc="$GATE_DEFAULT"
  gtype="${gc%% *}"
  case " $GATE_TYPES_HUMAN " in *" $gtype "*) echo human; return ;; esac
  case " $GATE_TYPES_AI "    in *" $gtype "*) echo ai; return ;; esac
  if _gate_type_known "$gtype"; then echo auto; else echo human; fi
}

# ---- Gate approvals (the clearance record) ---------------------------------
# docs/handoffs/<slug>/gate-status.md — written by gate-approve.sh (the
# console's Gate card, or an AI session that verified the conditions), read
# here. An approved row clears --gate-status for EVERY gate kind: an approval
# is the operator's override, the same philosophy as a QA waiver. A separate
# file from test-status.md on purpose — that file's very existence switches QA
# gating on, and recording a gate approval must never flip an unrelated regime.
gate_approved() {  # gate_approved <phase> → "yes<TAB>by<TAB>date" | "no"
  local f="$DOCS_ROOT/docs/handoffs/${slug}/gate-status.md"
  [ -f "$f" ] || { echo no; return; }
  sed 's/–/-/g; s/—/-/g' "$f" | awk -F'|' -v want="$1" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    tolower($0) ~ /^##[[:space:]]+gate approvals/ { ing=1; seen=0; next }
    ing && seen && $0 !~ /^[[:space:]]*\|/ { ing=0 }
    ing && /^[[:space:]]*\|/ {
      seen=1; ph=trim($2); gsub(/[*`]/,"",ph); ph=trim(ph)
      if (ph != want) next
      if (tolower(trim($3)) == "yes") printf "yes\t%s\t%s\n", trim($4), trim($5)
      else print "no"
      found=1; exit
    }
    END { if (!found) print "no" }
  '
}

# A real YYYY-MM-DD, not merely something shaped like one. Shape alone let
# "2020-13-99" through, and since the comparison is numeric it then read as a
# date already past — a gate that opened itself. Range-checked rather than
# handed to `date`, whose flags differ between BSD and GNU.
_valid_date() {  # _valid_date <string>
  case "$1" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) return 1 ;; esac
  local m d
  # 10# forces base 10: "08" and "09" are invalid octal and would error out.
  m=$((10#${1:5:2})); d=$((10#${1:8:2}))
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] && [ "$d" -ge 1 ] && [ "$d" -le 31 ]
}

# Portable bounded execution — macOS ships neither GNU `timeout` nor `gtimeout`,
# but it does ship perl. A gate command that hangs must not wedge the engine.
_run_bounded() {  # _run_bounded <seconds> <command-string>
  if command -v timeout >/dev/null 2>&1; then
    timeout "$1" bash -c "$2"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$1" bash -c "$2"
  else
    perl -e 'alarm shift; exec @ARGV' "$1" bash -c "$2"
  fi
}

# Commands no gate has any business running. A gate answers "is the world in the
# required state" — it never changes the world. Defence in depth behind the
# opt-in below, not the primary control.
#
# Kept in step with MUTATION_DENY in viewer/server/runner/verify.ts — the two
# state the same policy for the two places a plan's shell text gets executed, and
# `test/verify-extract.test.ts` fails when they drift. They had already drifted:
# this copy was missing sudo, git commit/rebase/merge, docker system prune and
# the redirect clause.
GATE_CMD_DENY='(^|[;&|[:space:]])(rm|mv|dd|mkfs|shutdown|reboot|kill|pkill|chown|chmod|sudo)([[:space:]]|$)|terraform[[:space:]]+(apply|destroy)|git([[:space:]]+(-[Cc][[:space:]]+[^[:space:]]+|--?[[:alnum:]_-]+(=[^[:space:]]+)?))*[[:space:]]+(push|reset|clean|checkout|commit|rebase|merge)(-(file|index|one-file))?([^-[:alnum:]_]|$)|docker[[:space:]]+(rm|rmi|kill|stop|system[[:space:]]+prune)|task[[:space:]]+[a-z:]*(deploy|ship|update|apply|destroy)|(npm|pnpm|yarn|cargo|gem|twine|poetry|uv)[[:space:]]+(publish|version|deprecate|unpublish|dist-tag|owner|access)|[[:space:]](delete|put|create|set|modify|terminate|reboot)-|>[[:space:]]*/|>>[[:space:]]*/'

# Executing a command written in a markdown file is remote code execution by
# document: clone a repo, run the board, run their shell. So `cmd` gates are OFF
# unless the caller opts in with PHASE_EXEC_GATES=1 — which the console's runner
# does deliberately and a passer-by does not.
#
# The verdict when it is off is its OWN word, `unevaluated:`, and that is
# load-bearing. It used to say `manual:`, which made one gate answer two
# questions differently depending on who asked: the autopilot boards a phase with
# PHASE_EXEC_GATES=1 and reads `clear (cmd ok)` → proceed, while the session it
# boards runs the same command by hand without the flag, reads `manual:` → and
# SKILL.md tells it to STOP and fetch a person for a gate no person owns. Same
# plan, same phase, same second, opposite instructions.
#
# "I did not check" and "a person must decide" are different facts — the same
# line the MCP probe draws, and the line `situation.ts` had already had to
# re-draw downstream by sniffing the words "not executed" out of the detail
# string. `unevaluated` is a fourth answer beside clear/blocked/manual so the
# split cannot recur: it is not in the `manual|human|OVERDUE` family any consumer
# tests for, so nothing routes it to a person by accident.
_gate_exec_enabled() { [ "${PHASE_EXEC_GATES:-0}" = "1" ]; }

# The text GATE_CMD_DENY is asked about — read the way the runner's `mutates()`
# reads it (viewer/server/runner/verify.ts): a redirect into /dev/null writes
# nothing (`2>/dev/null` was refused as a write to `/`), and `>& file` is
# `> file` plus 2>&1, so the write is still seen.
_deny_view() {  # _deny_view <command-string>
  printf '%s' "$1" | sed -E 's#[0-9&]?>>?&?[[:space:]]*/dev/null([[:space:];&|)]|$)# \1#g; s#>&([[:space:]]*[^[:space:]0-9-])#>\1#g'
}

# Evaluate a `cmd` gate. Echoes the verdict; returns 0 = clear, 1 = not clear.
_gate_cmd() {  # _gate_cmd <command-string>
  local out rc
  if _deny_view "$1" | grep -qE "$GATE_CMD_DENY"; then
    printf 'manual: REFUSED — a gate must not mutate anything: %s\n' "$1"
    return 1
  fi
  if ! _gate_exec_enabled; then
    printf 'unevaluated: cmd gate not executed (set PHASE_EXEC_GATES=1 to evaluate): %s\n' "$1"
    return 1
  fi
  out="$(_run_bounded "${PHASE_GATE_TIMEOUT:-15}" "$1" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf 'clear (cmd ok): %s\n' "$1"
    return 0
  fi
  # 124 is what both timeout implementations use; perl's alarm kills with SIGALRM (142).
  case "$rc" in
    124|142) printf 'blocked: cmd timed out after %ss: %s\n' "${PHASE_GATE_TIMEOUT:-15}" "$1" ;;
    *)       printf 'blocked: cmd exit %s: %s%s\n' "$rc" "$1" \
               "$( [ -n "$out" ] && printf ' — %s' "$(printf '%s' "$out" | head -1)" )" ;;
  esac
  return 1
}

# Are these phases of ANOTHER plan done? Delegates to this same script rather
# than re-reading a second plan's handoffs here — one implementation of "done".
_gate_plan() {  # _gate_plan <slug:phases>
  local other list done_line missing q
  other="${1%%:*}"; list="${1#*:}"
  if [ "$other" = "$1" ] || [ -z "$list" ]; then
    printf 'manual: malformed plan gate (expected <slug>:<phases>): %s\n' "$1"
    return 1
  fi
  if [ ! -f "$DOCS_ROOT/docs/plans/${other}.md" ]; then
    printf 'blocked: plan gate references a plan that does not exist: %s\n' "$other"
    return 1
  fi
  # The other plan's VERIFIED set, not its done set (S8-a). Under QA-on those
  # differ by exactly the phases a dependent must not build on: a `fail` verdict
  # leaves the handoff `complete`, so the board says done and the gate used to
  # clear straight through it. Still delegated to this same script rather than
  # re-reading a second plan's handoffs here — one implementation of "verified".
  done_line="$(DOCS_ROOT="$DOCS_ROOT" "$0" "$other" --verified 2>/dev/null || true)"
  # Comma-delimited on both sides so "1" cannot match inside "11".
  local done_set
  done_set=",$(printf '%s' "$done_line" | tr -d ' '),"
  missing=""
  for q in $(printf '%s' "$list" | tr ',' ' '); do
    case "$q" in ''|*[!0-9]*) continue ;; esac
    case "$done_set" in
      *",$q,"*) ;;
      *) missing="$missing $q" ;;
    esac
  done
  if [ -z "$missing" ]; then
    _unlanded_advisory "$other"
    printf 'clear (%s phases %s verified)\n' "$other" "$list"
    return 0
  fi
  printf 'blocked: %s phase(s)%s not verified\n' "$other" "$missing"
  return 1
}

# S8-b — nothing tied "done" to "LANDED", and the gap is invisible by
# construction.
#
# A settles `keep`, so its work sits on `pe/A` and never reaches the trunk. B's
# `plan A:5` gate clears on A being verified, B's run forks from the trunk, and B
# builds on a tree that does not contain the very thing it gated on. Every step
# is correct; the conclusion is wrong.
#
# The GATE half is phase 7's — the `landed`/`pr-merged` kinds and the landing
# ledger, which can refuse. This is the Free half, and it is advisory ON PURPOSE:
# a plan that settles `keep` does not land until the operator's own merge, so
# refusing here would deadlock every dependent of every such plan — a permanent
# block nobody can clear, which is worse than the silence it replaced. So the
# gate still clears; it simply stops being silent about what it did not check.
#
# Two sources, cheapest first, and NOTHING when neither knows: silence is not a
# claim, and an advisory printed on no evidence would train a reader to ignore it.
_unlanded_advisory() {  # _unlanded_advisory <other-slug>
  # TWO `local`s: `branch` reads `$other`, and a name assigned earlier in the
  # SAME `local` has not taken effect yet (SC2318) — `pe/` plus an empty string.
  local other="$1"
  local trunk="" branch="pe/$other" ledger
  ledger="$DOCS_ROOT/docs/handoffs/$other/landing.md"
  # The ledger is the better witness where it exists: it records where each
  # phase's work actually went, per repository, which git in the docs root
  # cannot see for a submodule at all.
  # A data row begins `| <phase>` (`phase-landing.sh`'s shape). Any row at all is
  # enough to stay quiet: it means somebody is recording where this plan's work
  # goes, so the question is being tracked. WHICH state satisfies which policy is
  # the gate half's job (`landed N`, phase 7) and deliberately not this one's — an
  # advisory that tried to adjudicate `pushed` vs `merged` would be a gate
  # wearing a gate's authority without a gate's ability to be cleared.
  if [ -f "$ledger" ] && grep -qE '^\|[[:space:]]*[0-9]' "$ledger" 2>/dev/null; then return 0; fi
  git -C "$DOCS_ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0
  git -C "$DOCS_ROOT" show-ref --verify --quiet "refs/heads/$branch" || return 0
  for t in main master trunk; do
    if git -C "$DOCS_ROOT" show-ref --verify --quiet "refs/heads/$t"; then trunk="$t"; break; fi
  done
  [ -n "$trunk" ] || return 0
  if git -C "$DOCS_ROOT" merge-base --is-ancestor "$branch" "$trunk" 2>/dev/null; then return 0; fi
  printf 'advisory: %s is verified but %s is not on %s — a phase that forks from %s will not have its work (the landing gate is `landed N`; see the plan'"'"'s Land directive)\n' \
    "$other" "$branch" "$trunk" "$trunk"
  return 0
}

# Rough working-set size of a phase: S | M | L (default M). Read from a
# "- **Size:** X" bullet in the ### Phase N block — mirrors the Gates convention,
# so no change to the machine-parsed Phase-graph table is needed.
# Block-scoped through phase_block, like Gate-check / MCP / QA (F12) — this was
# the last directive still reading a fixed `grep -A8` window, which is neither
# scoped nor long enough: a phase with no Size bullet inherited its NEIGHBOUR's,
# and a phase whose bullet sat nine lines under a long Goal silently fell back to
# M. Both directions move the weight, so --session-plan and SUGGESTED BATCHES
# proposed sessions for a plan that isn't the one on disk.
#
# The bullet match is `**Size:**`, not `.*[Ss]ize`: the loose one also matched
# prose carrying "resize" or "sizes", which is what turned HAVE_SIZES on — and
# with it the whole batching banner — for plans that tagged nothing at all.
phase_size() {  # phase_size <phase>  → echoes S|M|L
  local s
  s="$(phase_block "$1" 2>/dev/null \
        | grep -iE '^[[:space:]]*[-*][[:space:]]*\*{0,2}Size\*{0,2}[[:space:]]*:' \
        | sed -E 's/.*[Ss]ize[^A-Za-z]*([A-Za-z]).*/\1/' \
        | head -1 | tr '[:lower:]' '[:upper:]' || true)"
  case "$s" in S|M|L) echo "$s" ;; *) echo M ;; esac
}

# THE handoff of a phase — the one file every reader must agree on.
#
# A phase should have exactly one, but a repair scaffolded under a different
# kebab title leaves two, and the old `ls | head -1` took whichever sorted first
# ALPHABETICALLY: `phase-03-auth.md` (complete, the abandoned first attempt) beat
# `phase-03-rework-auth.md` (in-progress), so the board reported done and the
# dependents unblocked. Newest by mtime is at least a defensible choice — the
# later file is the later intent — and F21 names the ambiguity so it gets fixed.
handoff_file() {  # handoff_file <phase>  → path, empty when there is none
  local pad
  pad="$(printf '%02d' "$((10#$1))")"
  ls -t "$handoff_dir"/phase-"${pad}"-*.md 2>/dev/null | head -1 || true
}

# Every handoff of a phase, for the lint that counts them.
handoff_files() {  # handoff_files <phase>
  local pad
  pad="$(printf '%02d' "$((10#$1))")"
  ls "$handoff_dir"/phase-"${pad}"-*.md 2>/dev/null || true
}

# Live status of a phase from its handoff frontmatter.
# done | in-progress | stuck | not-started
phase_status() {  # phase_status <phase>
  local f st
  f="$(handoff_file "$1")"
  [ -z "$f" ] && { echo not-started; return; }
  st="$(grep -m1 '^status:' "$f" | sed 's/^status:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
  case "$st" in
    complete)    echo "done" ;;
    in-progress) echo in-progress ;;
    blocked)     echo stuck ;;
    *)           echo not-started ;;
  esac
}

# ---------------------------------------------------------------------------
# Load the graph + live status into parallel arrays.
# ---------------------------------------------------------------------------
# Indexed arrays keyed by phase NUMBER (phases are small ints) — keeps this
# compatible with bash 3.2 (macOS /bin/bash), which lacks associative arrays.
TABLE_SCAN="$(_table_scan)"
declare -a PHASES=()
declare -a DEPS=() TITLE=() STATUS=() GATED=() SIZE=() REPOS=() DROPPED=()
while IFS=$'\037' read -r ph deps title repos dropped; do
  [ -z "$ph" ] && continue
  # Belt to the parser's braces: the scan already keeps the first row of a
  # duplicated phase, and this keeps the Board contract single-valued even if a
  # future parser change reintroduces one. Board.ready is scheduled from.
  case " ${PHASES[*]:-} " in *" $ph "*) continue ;; esac
  PHASES+=("$ph")
  DROPPED["$ph"]="$dropped"
  DEPS["$ph"]="$deps"
  TITLE["$ph"]="$title"
  STATUS["$ph"]="$(phase_status "$ph")"
  GATED["$ph"]="$(is_gated "$ph")"
  SIZE["$ph"]="$(phase_size "$ph")"
  # Scope, normalized once here so every consumer sees the same csv. A phase
  # that named no repos gets `all` — it might touch anything, so it runs alone.
  REPOS["$ph"]="$(scope_of_row "$repos")"
done < <(parse_table)

if [ "${#PHASES[@]}" -eq 0 ]; then
  printf 'ERROR: could not parse a "## Phase graph" table in %s\n' "$plan_file" >&2
  printf '  The engine needs the standard table (Phase | Title | Depends on | …).\n' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Structural validation helpers (F1/F2/F3) + plan model (F6).
# (Reference _in_list, defined below — fine, these run only after full load.)
# ---------------------------------------------------------------------------
ALL_PHASES=" ${PHASES[*]} "          # space-padded set for _in_list membership

# F1: phase cells that contain a digit but are not a bare integer ("2a",
# "6 (gated)") are silently dropped by parse_table — find them so we can name them.
find_malformed() {
  # Same Phase-graph-table scoping as parse_table — only flag bad cells INSIDE
  # the phase table, never rows of other pipe tables in the plan.
  sed 's/–/-/g; s/—/-/g' "$plan_file" | awk -F'|' '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    tolower($0) ~ /^##[[:space:]]+phase graph/ { inpg=1; seen=0; next }
    inpg && seen && $0 !~ /^[[:space:]]*\|/ { inpg=0 }
    inpg && /^[[:space:]]*\|/ {
      seen=1
      ph = trim($2); gsub(/[*`]/, "", ph); ph = trim(ph)
      if (ph ~ /[0-9]/ && ph !~ /^[0-9]+$/) print ph
    }'
}

# F2: deps that reference a phase number not present in the table.
undefined_deps() {
  local p d
  for p in "${PHASES[@]}"; do
    for d in ${DEPS[$p]:-}; do
      _in_list "$d" "$ALL_PHASES" || printf 'phase %s depends on undefined phase %s\n' "$p" "$d"
    done
  done
  return 0
}

# F3: cycle detection (DFS, white/gray/black colouring). Sets CYCLE_PATH on hit.
declare -a COLOR=()
CYCLE_PATH=""
_dfs() {  # _dfs <node> <path-so-far> ; returns 0 (true) when a cycle is found
  local n="$1" path="$2 $1" d
  COLOR[$n]=1
  for d in ${DEPS[$n]:-}; do
    _in_list "$d" "$ALL_PHASES" || continue          # ignore undefined deps here
    if [ "${COLOR[$d]:-0}" = 1 ]; then CYCLE_PATH="${path# } -> $d"; return 0; fi
    if [ "${COLOR[$d]:-0}" = 0 ]; then
      if _dfs "$d" "$path"; then return 0; fi
    fi
  done
  COLOR[$n]=2
  return 1
}
detect_cycle() {  # returns 0 (true) if the dependency graph has a cycle
  CYCLE_PATH=""; COLOR=()
  local p
  for p in "${PHASES[@]}"; do COLOR[$p]=0; done
  for p in "${PHASES[@]}"; do
    if [ "${COLOR[$p]}" = 0 ]; then
      if _dfs "$p" ""; then return 0; fi
    fi
  done
  return 1
}

# F20: the SHAPE of the Phase-graph table — is it the table the parser thinks it
# is? Every answer the engine gives about scope and readiness is read out of two
# of its columns, so a table whose columns cannot be located by name is the one
# failure that poisons everything downstream while looking perfectly healthy.
# Gating (F1 tier), not advisory: `LINT OK` on a plan whose scopes are fiction is
# how two sessions end up in one working tree.
table_shape_issues() {
  local hdr ncols di ri state ph cells
  hdr="$(_table_record HDR | head -1)"
  if [ -z "$hdr" ]; then
    printf 'Phase graph: no table rows found under the "## Phase graph" heading\n'
    return 0
  fi
  ncols="$(printf '%s' "$hdr" | cut -d$'\037' -f1)"
  di="$(printf '%s' "$hdr" | cut -d$'\037' -f2)"
  ri="$(printf '%s' "$hdr" | cut -d$'\037' -f3)"
  state="$(printf '%s' "$hdr" | cut -d$'\037' -f5)"
  if [ "$state" = missing ]; then
    printf 'Phase graph: the table has no header row — columns are being read by position (Depends-on = 3rd, Repos = 5th); add "| Phase | Title | Depends on | Parallel-safe with | Repos | Exit criteria |"\n'
  else
    [ "$di" = "-1" ] && printf 'Phase graph: the header names no "Depends on" column — every phase parses as having NO dependencies, so the whole plan reads as ready at once\n'
    [ "$ri" = "-1" ] && printf 'Phase graph: the header names no "Repos" column — every phase parses as scope "all" and the plan serializes completely, with no warning at claim time\n'
  fi
  _table_record RAG | while IFS=$'\037' read -r ph cells; do
    [ -n "$ph" ] && printf 'phase %s: its table row has %s columns but the header has %s — the cells after the short one are read from the wrong column\n' "$ph" "$cells" "$ncols"
  done
  return 0
}

# F21: cells the parser read but could not fully believe — a Depends-on token it
# had to discard, a repeated Phase row, a zero-padded number. Each of these was
# silent before, and each silence had the same shape: the board kept answering,
# it just answered about a different plan than the one on disk.
table_cell_issues() {
  local p t c
  for p in "${PHASES[@]}"; do
    for t in ${DROPPED[$p]:-}; do
      printf 'phase %s: Depends-on token "%s" was not understood and was ignored — the phase will report ready without it (write a plain number, or an ascending range like 2-4)\n' "$p" "$t"
    done
  done
  _table_record DUP | while IFS= read -r c; do
    [ -n "$c" ] && printf 'phase %s: appears more than once in the Phase graph table — only the first row is used, and the later row'"'"'s dependencies are ignored\n' "$c"
  done
  _table_record PAD | while IFS= read -r c; do
    [ -n "$c" ] && printf 'malformed Phase cell: %s (zero-padded — write %s; "%s" is not a valid number to bash or to JSON)\n' "$c" "$((10#$c))" "$c"
  done
  return 0
}

# F21, handoff side: a phase with more than one handoff file. The board reads
# ONE status per phase, so the second file is a status nobody sees — and which
# of the two won used to be decided by alphabetical order.
duplicate_handoff_issues() {
  local p n files
  for p in "${PHASES[@]}"; do
    files="$(handoff_files "$p")"
    [ -z "$files" ] && continue
    n="$(printf '%s\n' "$files" | grep -c .)"
    [ "$n" -le 1 ] && continue
    printf 'phase %s: %s handoff files (%s) — the board reads only the newest; delete or rename the stale one\n' \
      "$p" "$n" "$(printf '%s\n' "$files" | while IFS= read -r f; do printf '%s ' "$(basename "$f")"; done | sed 's/ $//')"
  done
  return 0
}

# All structural problems, one per line (empty output = clean). Every producer
# here is F1-tier: a line from any of them fails --lint. The four checks that
# moved up from advisory in 5.0.0 name themselves in the line —
# `gate-directive-missing`, `gate-type-unknown` (F24), `verification-empty-open`
# (F14), `decision-outstanding-unowned` (F25) — so a failure can be grepped for
# and a test can assert the check by name rather than by prose.
compute_issues() {
  table_shape_issues
  table_cell_issues
  duplicate_handoff_issues
  find_malformed | while IFS= read -r c; do
    [ -n "$c" ] && printf 'malformed Phase cell: %s (not an integer phase number)\n' "$c"
  done
  undefined_deps
  if detect_cycle; then printf 'dependency cycle: %s\n' "$CYCLE_PATH"; fi
  gate_issues
  verification_issues
  decision_issues
  directive_issues
  note_issues
  return 0
}

# F27 `land-word-unknown` — GATING. A closed directive whose word is not one of
# its words. One id for all six, with the directive named in the line, because
# the failure is one failure: `Land: sometimes` and `Issues: yes` are the same
# mistake and want the same repair. It GATES rather than warns because the
# readers fall THROUGH an unrecognised word to the next level — which is the
# right behaviour for a reader (a typo must not silently become a policy) and
# the wrong silence for an author: `Land: prr` would otherwise behave exactly
# like a plan that had never mentioned landing, and nothing would ever say so.
directive_issues() {
  local p raw word spec
  # Plan-wide lines. `Base branch` is absent on purpose: it is a git ref, and
  # this engine has no business deciding which refs exist.
  for spec in "Landing:$LAND_POLICIES" "Gitlink:$GITLINK_POLICIES" \
              "Conflicts:$CONFLICT_POLICIES" "Messaging:$MESSAGING_WORDS" \
              "Issues:$ISSUE_MODES" "Isolation:$ISOLATION_DIRECTIVES"; do
    raw="$(_plan_directive "${spec%%:*}")"
    [ -z "$raw" ] && continue
    word="$(printf '%s' "$raw" | _first_word)"
    case " ${spec#*:} " in
      *" $word "*) ;;
      *) printf 'land-word-unknown — **%s:** "%s" is not one of: %s (F27)\n' "${spec%%:*}" "$word" "${spec#*:}" ;;
    esac
  done
  # Per-phase bullets.
  for p in "${PHASES[@]}"; do
    for spec in "Land:$LAND_POLICIES" "Gitlink:$GITLINK_POLICIES" \
                "Isolation:$ISOLATION_DIRECTIVES" "Issues:$ISSUE_MODES"; do
      raw="$(_phase_directive "$p" "${spec%%:*}")"
      [ -z "$raw" ] && continue
      word="$(printf '%s' "$raw" | _first_word)"
      case " ${spec#*:} " in
        *" $word "*) ;;
        *) printf 'phase %s: land-word-unknown — "- **%s:** %s" is not one of: %s (F27)\n' "$p" "${spec%%:*}" "$word" "${spec#*:}" ;;
      esac
    done
  done
  return 0
}

# F26 `note-target-unknown` — GATING. A handoff's `## Notes for later phases`
# bullet addressed to a phase this plan does not have. The note is not merely
# undeliverable, it is INVISIBLE: `--notes N` is asked per phase, so a note for
# phase 30 of a 23-phase plan is never printed to anyone and never reported
# missing by anything. Whoever wrote it believes it was handed on.
note_issues() {
  local dir f n src
  dir="$DOCS_ROOT/docs/handoffs/$slug"
  [ -d "$dir" ] || return 0
  for f in "$dir"/phase-*.md; do
    [ -f "$f" ] || continue
    src="$(basename "$f")"
    for n in $(_note_rows_of "$f" | cut -f1); do
      # `next` and `all` are relations, not numbers, and always have a reader.
      case "$n" in ''|*[!0-9]*) continue ;; esac
      case " ${PHASES[*]} " in
        *" $n "*) ;;
        *) printf 'note-target-unknown — %s has a note for phase %s, which is not in this plan; nothing will ever deliver it (F26)\n' "$src" "$n" ;;
      esac
    done
  done
  return 0
}

# F30 `note-target-done` — ADVISORY (stderr, exit untouched). A note addressed
# to a phase that is already DONE. It is the near miss of F26 and a different
# fact: the phase exists and the note is well-formed, but its reader has been
# and gone, so nothing will ever board with it.
#
# Its own id rather than a second verdict under F26, and that is a rule and not
# a preference: an id that both gates and warns cannot answer "did the lint
# fail?", which is the only question a caller asks it. Advisory because it is
# routinely TRUE and harmless — a phase re-run out of order, a note written to
# a sibling that finished first — and because the repair is a person's call
# (re-address it, or let it stand as a record of what was said).
note_done_advisories() {
  local dir f n src
  dir="$DOCS_ROOT/docs/handoffs/$slug"
  [ -d "$dir" ] || return 0
  for f in "$dir"/phase-*.md; do
    [ -f "$f" ] || continue
    src="$(basename "$f")"
    for n in $(_note_rows_of "$f" | cut -f1); do
      case "$n" in ''|*[!0-9]*) continue ;; esac
      case " ${PHASES[*]} " in *" $n "*) ;; *) continue ;; esac
      [ "$(phase_status "$n")" = "done" ] || continue
      printf 'F30 %s: note-target-done — its note for phase %s will never be delivered; phase %s is already done\n' "$src" "$n" "$n"
    done
  done
  return 0
}

# F28 `land-needs-lane` — ADVISORY (stderr, exit untouched). A phase that
# LANDS from a checkout it shares with other phases lands whatever else is in
# that checkout: the merge, the push or the pull request carries every commit
# on the branch, not the phase's own. It is advisory rather than gating because
# it is a hazard and not an error — a plan whose phases are serial and whose
# every phase lands with the same policy is fine, and that plan exists.
land_needs_lane_advisories() {
  local p policy isolation plan_isolation worktrees
  plan_isolation="$(_plan_directive 'Isolation' | _first_word)"
  worktrees="$(printf '%s' "$(_plan_directive 'Worktrees')" | _first_word)"
  for p in "${PHASES[@]}"; do
    _is_done "$p" && continue
    policy="$(land_for_phase "$p" | cut -f1)"
    [ "$policy" = hold ] && continue
    isolation="$(isolation_for_phase "$p" | cut -f1)"
    [ "$isolation" = worktree ] && continue
    [ -z "$isolation" ] && [ "$plan_isolation" = worktree ] && continue
    [ -z "$isolation" ] && [ "$worktrees" = on ] && continue
    printf 'F28 phase %s: land-needs-lane — it lands with `%s` from a checkout it shares, so the merge carries every commit on the branch and not just this phase'"'"'s; give it `- **Isolation:** worktree`, or land it `hold` and let one phase land for all of them\n' "$p" "$policy"
  done
  return 0
}

# F24: Gate-check grammar — GATING. A *(GATED)* heading with no directive at
# all (`gate-directive-missing`) and a directive whose type is not on the list
# (`gate-type-unknown`) both fail the lint by name. The evaluator still answers
# for the board — GATE_DEFAULT for a missing directive, `manual` for an unknown
# type, fail-safe — but the answer is no longer silent: the sep-review audit
# found 15 of 143 gated headings demanding a person by accident, and
# `Gate-check: phase-21 …` (hyphen, not space) reading as manual with nobody
# knowing the automation was off. Every deviation is reported here.
#
# F29 `landed-gate-unknown-phase` rides the same function, because it is the
# same class of failure for the two landing kinds: a `landed 99` on a 23-phase
# plan can never clear, and reads exactly like a phase that has not landed yet.
gate_issues() {
  local p gc gtype gval q
  for p in "${PHASES[@]}"; do
    gc="$(gate_check_directive "$p")"
    if [ -z "$gc" ]; then
      [ "${GATED[$p]:-no}" = yes ] && \
        printf 'phase %s: gate-directive-missing — a *(GATED)* heading needs a "- **Gate-check:** <type> <value>" bullet (it reads as %s until it has one)\n' "$p" "$GATE_DEFAULT"
      continue
    fi

    if [ "${GATED[$p]:-no}" != yes ]; then
      printf 'phase %s: has a Gate-check but the heading is not marked *(GATED)* — the board will batch it as ungated\n' "$p"
    fi

    gtype="${gc%% *}"; gval="${gc#"$gtype"}"; gval="${gval# }"
    if ! _gate_type_known "$gtype"; then
      printf 'phase %s: gate-type-unknown — Gate-check type "%s" is not one of: %s (a typo here used to demote an automated gate to a person, silently)\n' \
        "$p" "$gtype" "$GATE_TYPES"
      continue
    fi
    [ "$gtype" != manual ] && [ -z "$gval" ] && \
      printf 'phase %s: Gate-check type "%s" has no value\n' "$p" "$gtype"

    case "$gtype" in
      phase|phases)
        for q in $(printf '%s' "$gval" | tr ',' ' '); do
          case "$q" in ''|*[!0-9]*) printf 'phase %s: Gate-check %s references "%s", which is not a phase number\n' "$p" "$gtype" "$q"; continue ;; esac
          case " ${PHASES[*]} " in *" $q "*) ;; *) printf 'phase %s: Gate-check %s references phase %s, which is not in this plan\n' "$p" "$gtype" "$q" ;; esac
          [ "$q" = "$p" ] && printf 'phase %s: Gate-check %s references itself\n' "$p" "$gtype"
        done ;;
      plan)
        case "$gval" in
          *:*) [ -f "$DOCS_ROOT/docs/plans/${gval%%:*}.md" ] || \
                 printf 'phase %s: Gate-check plan references "%s", which has no docs/plans entry\n' "$p" "${gval%%:*}" ;;
          *)   printf 'phase %s: Gate-check plan must be <slug>:<phases>, got "%s"\n' "$p" "$gval" ;;
        esac ;;
      date|deadline|by)
        _valid_date "$gval" || \
          printf 'phase %s: Gate-check %s needs a real YYYY-MM-DD date, got "%s"\n' "$p" "$gtype" "$gval" ;;
      cmd)
        _deny_view "$gval" | grep -qE "$GATE_CMD_DENY" && \
          printf 'phase %s: Gate-check cmd looks like it mutates state — a gate must only observe: %s\n' "$p" "$gval" ;;
      landed|pr-merged)
        # F29 `landed-gate-unknown-phase` — GATING. A landing gate naming a
        # phase this plan does not have can never clear, and reads as a
        # blocked gate rather than as the typo it is: the ledger simply has no
        # row for phase 99 and never will.
        case "$gval" in
          ''|*[!0-9]*) printf 'phase %s: landed-gate-unknown-phase — Gate-check %s needs one phase number, got "%s" (F29)\n' "$p" "$gtype" "$gval" ;;
          *)
            case " ${PHASES[*]} " in
              *" $gval "*) [ "$gval" = "$p" ] && printf 'phase %s: landed-gate-unknown-phase — Gate-check %s references itself, which can never clear (F29)\n' "$p" "$gtype" ;;
              *) printf 'phase %s: landed-gate-unknown-phase — Gate-check %s references phase %s, which is not in this plan (F29)\n' "$p" "$gtype" "$gval" ;;
            esac ;;
        esac ;;
    esac
  done
  return 0
}

# Shared extractors for the verification advisories (F14/F16/F17/F18).
# _verification_reach prints the command-shaped lines inside a phase's
# §Verification reach: fenced lines and backtick-carrying lines from the
# Verification bullet to the end of the phase block. One awk, four consumers.
_verification_reach() {  # _verification_reach <phase> [bullet-label]
  awk -v p="$1" -v b="${2:-Verification}" '
    /^###[[:space:]]+[Pp]hase[[:space:]]/ {
      if (inblock) exit
      if ($0 ~ ("^###[[:space:]]+[Pp]hase[[:space:]]+" p "([^0-9]|$)")) inblock = 1
      next
    }
    /^##[[:space:]]/ { if (inblock) exit }
    inblock && $0 ~ ("^[[:space:]]*[-*][[:space:]]+\\*\\*" b) { seen = 1; started = NR }
    # The reach ENDS at the next top-level labelled bullet. Without this the
    # scan ran to the end of the phase block and swallowed whatever came after
    # — `- **Handoff must record:**` carries backticks and read as commands —
    # and with two command bullets (Setup and Verification) the first would
    # simply absorb the second, so F22 would fire on every phase that did what
    # F22 asks for. `Verify in` is exempt because it belongs to Verification
    # and plans write it at either indent.
    seen && NR > started && /^[-*][[:space:]]+\*\*/ && !/^[-*][[:space:]]+\*\*Verify in/ { exit }
    seen && /^[[:space:]]*(~~~|```)/ { fence = !fence; next }
    seen && (fence || /`/) { print }
  ' "$plan_file"
}

# The same reach, folded into ONE line — newlines and tabs to spaces.
#
# The shared vocabulary is dialect-neutral and therefore spells its spaces
# literally, so a poll loop written across three fenced lines cannot match
# until it is one. The runtime side folds for the same reason (`summarise`,
# and `foldWhitespace` in runner/verify-env.ts); if only one side folded, the
# lint would describe a runtime that judges differently.
_reach_folded() {  # _reach_folded <phase> [bullet-label]
  _verification_reach "$1" "${2:-Verification}" | tr '\n\t' '  '
}

# The whole ### Phase N block, heading included (for bullet detection).
_phase_block() {  # _phase_block <phase>
  awk -v p="$1" '
    /^###[[:space:]]+[Pp]hase[[:space:]]/ {
      if (inblock) exit
      if ($0 ~ ("^###[[:space:]]+[Pp]hase[[:space:]]+" p "([^0-9]|$)")) { inblock = 1; print; next }
      next
    }
    /^##[[:space:]]/ { if (inblock) exit }
    inblock { print }
  ' "$plan_file"
}

# The program a command starts with, past a "$ " prompt and FOO=bar prefixes —
# mirrors the runner's leadToken. Prints nothing when the candidate has no
# command-shaped lead: paths (judged elsewhere), bare numbers and exit-code
# table cells, flags, punctuation. Keeping the shape strict is what stops
# `1` and `128 112 3 12 124` from reading as commands.
_verification_lead() {  # _verification_lead <candidate>
  local c="$1" w
  c="${c#"${c%%[![:space:]]*}"}"
  c="${c#\$ }"
  # `! grep …` negates `grep`; the lead is `grep` (the runner's resolveLead agrees).
  case "$c" in '! '*) c="${c#!}"; c="${c#"${c%%[![:space:]]*}"}" ;; esac
  while :; do
    w="${c%%[[:space:]]*}"
    case "$w" in
      [A-Za-z_]*=*) [ "$w" = "$c" ] && return 0
                    c="${c#*[[:space:]]}"; c="${c#"${c%%[![:space:]]*}"}" ;;
      *) break ;;
    esac
  done
  w="${c%%[[:space:]]*}"
  case "$w" in
    ''|*/*) return 0 ;;
    *[!A-Za-z0-9_.+-]*) return 0 ;;
  esac
  case "$w" in [A-Za-z_]*) printf '%s' "$w" ;; esac
  return 0
}

# F14: a phase without a runnable §Verification — GATING since 5.0.0 (it was
# advisory: the sep-review audit's ZTD-6 found a prose-only verification card
# asking a person for twelve hours after the phase was paid for, and a warning
# nobody reads at plan time is no gate at all). A done phase is still exempt —
# The autopilot boards a phase only to park it when its Verification bullet
# yields nothing executable ("nothing would prove the work"), hours after the
# author could have heard it. Warned per open phase at lint time — validate.sh
# and the console's lint panel inherit the lines — but exit codes never move:
# a done phase's proof is its handoff, and history should not nag. "Runnable"
# here is the cheap tell the extractor and this script can agree on: a
# backtick span CONTAINING A LETTER, or a fence, somewhere in the bullet's
# reach (same line or below, inside the phase block) — the letter requirement
# keeps backticked exit-code tables (`1`, `128 112 3`) from passing for
# commands, the shape that made a real phase board and park. Nested 2-space
# sub-bullets count — the console's parser keeps them since the same run that
# taught it parked on that shape.
verification_issues() {
  local p
  for p in "${PHASES[@]}"; do
    _is_done "$p" && continue
    awk -v p="$p" '
      /^###[[:space:]]+[Pp]hase[[:space:]]/ {
        if (inblock) exit
        if ($0 ~ ("^###[[:space:]]+[Pp]hase[[:space:]]+" p "([^0-9]|$)")) inblock = 1
        next
      }
      /^##[[:space:]]/ { if (inblock) exit }
      inblock && /^[[:space:]]*[-*][[:space:]]+\*\*Verification/ { seen = 1 }
      seen && /^[[:space:]]*(~~~|```)/ { ok = 1; exit }
      seen && /`/ {
        # Per-span, not one regex across the line: `1` and `128 112` must not
        # borrow letters from the prose between them.
        s = $0
        while (match(s, /`[^`]+`/)) {
          span = substr(s, RSTART + 1, RLENGTH - 2)
          if (span ~ /[A-Za-z]/) { ok = 1; exit }
          s = substr(s, RSTART + RLENGTH)
        }
      }
      END { exit (ok ? 0 : 1) }
    ' "$plan_file" || \
      printf 'phase %s: verification-empty-open — no runnable §Verification on an open phase; the autopilot would park it at boarding, so add the commands that prove the exit criteria (a backticked command or a fence)\n' "$p"
  done
  return 0
}

# F25: the decision manifest's rows — GATING. An `outstanding` row with no
# owner (`decision-outstanding-unowned`) is a decision nobody owes, which is
# how a run starts with a question that has no answerer; a key outside the
# closed vocabulary (`decision-key-unknown`) or a state outside
# `answered|outstanding|waived` (`decision-state-unknown`) is the gate-type
# defect over again — a typo that reads as a row and answers nothing. Every
# row of the plan's table AND of the twin is checked, whatever phase it is
# scoped to; a plan with no `## Decisions` at all has no rows and passes.
decision_issues() {
  { plan_decisions; twin_decisions; } | awk -F'\037' -v keys="$DECISION_KEYS" -v states="$DECISION_STATES" -v sources="$DECISION_SOURCES" '
    BEGIN {
      n = split(keys, K, " "); for (i = 1; i <= n; i++) known[K[i]] = 1
      m = split(states, S, " "); for (i = 1; i <= m; i++) okstate[S[i]] = 1
      q = split(sources, R, " "); for (i = 1; i <= q; i++) oksource[R[i]] = 1
    }
    {
      where = ($1 == "2") ? "decisions.md" : "the plan"
      if ($9 != "") where = where " (phase " $9 ")"
      if (!($2 in known)) printf "decision row `%s` in %s: decision-key-unknown — not one of: %s\n", $2, where, keys
      if (!($5 in okstate)) printf "decision row `%s` in %s: decision-state-unknown — state \"%s\" is not one of: %s\n", $2, where, $5, states
      if ($7 != "" && !($7 in oksource)) printf "decision row `%s` in %s: decision-source-unknown — source \"%s\" is not one of: %s\n", $2, where, $7, sources
      if ($5 == "outstanding" && $4 == "") printf "decision row `%s` in %s: decision-outstanding-unowned — an outstanding decision needs an owner (who answers it)\n", $2, where
    }'
  return 0
}

# F16: a §Verification that waits on an external process — ADVISORY, never a
# gate. Same arm as F14/F15. F14 asks "is anything runnable?"; F16 asks "does
# what runs ever finish on its own?" — `gh run watch`, a deploy that blocks on
# a CI-built image, a 3-digit sleep all pass F14 and then hold a session for
# the full external duration (the runner bounds each verification command at
# 30 minutes), hours after the author could have heard it. The scan is
# conservative: only command-shaped text inside the §Verification reach —
# backticked spans and fenced lines — is examined, and only for patterns that
# by construction wait on a clock outside the session.
#
# The vocabulary is `EXTERNAL_WAIT` in scripts/verify.env, shared with the
# console's RUNTIME detector (viewer/server/runner/liveness.ts) so the shapes
# this warns about at plan time are the shapes that get parked at run time.
# `tr` first: the shared alternation is dialect-neutral and spells the space
# before `--watch` literally, so a tab-indented fenced line must be normalised
# to match it — which is what `summarise` already does on the runtime side.
verification_unbounded_advisories() {
  local p hit
  for p in "${PHASES[@]}"; do
    _is_done "$p" && continue
    hit="$(_reach_folded "$p" \
      | sed -E "s${_CARVE}${EXTERNAL_WAIT_ALLOW}${_CARVE}${_CARVE}g" \
      | grep -oE "$EXTERNAL_WAIT" \
      | head -1 || true)"
    hit="$(printf '%s' "$hit" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -n "$hit" ] && \
      printf 'F16 phase %s: §Verification waits on an external process (`%s`) — the runner bounds each command at 30min; split the phase (build ∥ verify-later behind a Gate-check) or expect a runtime park\n' "$p" "$hit"
  done
  return 0
}

# F15: a named MCP server this machine does not have — ADVISORY, never a gate.
# Same tier and same reasoning as F14: the autopilot's preflight would park the
# run on this at boarding, so the author should hear it while the plan is still
# open in front of them. Exit codes never move, and done phases are not nagged.
#
# The registry is the CONSOLE's, so bash is told rather than asked: PE_MCP_SERVERS
# carries the configured ids as a plain space/comma list. Unset means "no console
# in this environment" and disables the check entirely — a bare skill install has
# no registry to disagree with, and inventing a failure there would be a lie.
# Set-but-empty is a real answer (a console with nothing registered) and does warn.
mcp_advisories() {
  [ -z "${PE_MCP_SERVERS+set}" ] && return 0
  local known p named t missing
  known=" $(printf '%s' "${PE_MCP_SERVERS:-}" | tr ',' ' ' | tr -s ' ') "
  _unknown() {  # _unknown <csv> → csv of ids not in the registry
    local acc="" one
    local IFS=,
    for one in $1; do
      one="$(printf '%s' "$one" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      [ -z "$one" ] && continue
      case "$known" in *" $one "*) continue ;; esac
      acc="${acc:+$acc, }$one"
    done
    printf '%s' "$acc"
  }
  # The consequence named here has to match what the console will ACTUALLY do,
  # and that now depends on the policy. Under the default the phase runs without
  # the server and reports it; only `require` still parks. Saying "will park" to
  # everyone would be the same lie in the other direction as saying nothing.
  local consequence
  if [ "$(effective_mcp_policy)" = require ]; then
    consequence='every phase will park at boarding'
  else
    consequence='phases will run without them and report it (set **MCP policy:** require to park instead)'
  fi
  missing="$(_unknown "$(plan_mcp)")"
  if [ -n "$missing" ]; then
    printf 'F15 plan: MCP server(s) not registered on this machine: %s — %s; register them in Phase Console → MCP, or drop them from §Session budget\n' "$missing" "$consequence"
    # Said once, at the level it was written. A phase that merely repeats the
    # plan-wide line would otherwise re-report it on every row.
    known="${known}$(printf '%s' "$missing" | tr ',' ' ' | tr -s ' ') "
  fi
  for p in "${PHASES[@]}"; do
    _is_done "$p" && continue
    named="$(mcp_directive "$p")"
    [ -z "$named" ] && continue
    t="$(_unknown "$named")"
    if [ -n "$t" ]; then
      if [ "$(effective_mcp_policy "$p")" = require ]; then
        printf 'F15 phase %s: MCP server(s) not registered on this machine: %s — the autopilot will park it at boarding; register them in Phase Console → MCP, or drop them from the phase\n' "$p" "$t"
      else
        printf 'F15 phase %s: MCP server(s) not registered on this machine: %s — it will run without them and report it; register them in Phase Console → MCP, drop them from the phase, or add "- **MCP policy:** require" to park instead\n' "$p" "$t"
      fi
    fi
  done
  return 0
}

# F15, the credential and account half (chapter 13 §1.1: "an unregistered
# account or credential stays advisory"). The console tells bash what it holds
# through PE_CREDENTIALS and PE_ACCOUNTS (plain space/comma lists of ids), the
# way PE_MCP_SERVERS carries the MCP registry; unset means no console here and
# disables the check, set-but-empty is a real answer. Phase 11's prelude is the
# gate that acts on it; this only says so while the plan is open.
credential_advisories() {
  local p named t missing known
  if [ -n "${PE_CREDENTIALS+set}" ]; then
    known=" $(printf '%s' "${PE_CREDENTIALS:-}" | tr ',' ' ' | tr -s ' ') "
    _unknown_cred() {
      local acc="" one
      local IFS=,
      for one in $1; do
        one="$(printf '%s' "$one" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
        [ -z "$one" ] && continue
        case "$known" in *" $one "*) continue ;; esac
        acc="${acc:+$acc, }$one"
      done
      printf '%s' "$acc"
    }
    missing="$(_unknown_cred "$(plan_credentials)")"
    if [ -n "$missing" ]; then
      printf 'F15 plan: credential(s) the console does not hold: %s — under **Credential policy:** require every phase is refused at boarding; register them in Phase Console → Settings, or drop them from §Session budget\n' "$missing"
      known="${known}$(printf '%s' "$missing" | tr ',' ' ' | tr -s ' ') "
    fi
    for p in "${PHASES[@]}"; do
      _is_done "$p" && continue
      named="$(credentials_directive "$p")"
      [ -z "$named" ] && continue
      t="$(_unknown_cred "$named")"
      [ -n "$t" ] && printf 'F15 phase %s: credential(s) the console does not hold: %s — refused at boarding under "require", run and reported under "continue"\n' "$p" "$t"
    done
  fi
  if [ -n "${PE_ACCOUNTS+set}" ]; then
    known=" $(printf '%s' "${PE_ACCOUNTS:-}" | tr ',' ' ' | tr -s ' ') "
    while IFS=$'\t' read -r acct _min; do
      [ -z "$acct" ] && continue
      case "$known" in *" $acct "*) continue ;; esac
      printf 'F15 plan: account `%s` is not registered on this console — the prelude will refuse a run that declares it; register it in Phase Console → Accounts, or drop it from **Accounts:**\n' "$acct"
    done < <(plan_accounts)
  fi
  return 0
}

# F17: a §Verification lead that is not installed on this machine — ADVISORY,
# never a gate. Same arm as F14/F15/F16, born from a measured incident class:
# 16 verify-failed halts, 15 of them spurious, because `rg` was a shell
# function inside the authoring session and nothing on the runner's PATH, and
# `python` meant python3. The runner's preflight predicted every one by name
# at boarding and the halt still cost the run — so the author hears it at
# PLAN time instead. The consequence named matches what the console actually
# does: such a command is SKIPPED at verification and recorded; a phase whose
# every check is skipped parks. `command -v` runs on THIS machine — the same
# machine whose console will run the plan — so "installed" means installed.
_f17_report() {  # _f17_report <candidate> — uses/updates p, f17_seen (dynamic scope)
  local lead hint
  case "$1" in
    *[[:space:]]*) : ;;
    *.*) return 0 ;;   # a lone token with a dot is a filename citation, not a command
  esac
  lead="$(_verification_lead "$1")"
  [ -z "$lead" ] && return 0
  case " $PREFLIGHT_SKIP " in *" $lead "*) return 0 ;; esac
  case "$f17_seen" in *" $lead "*) return 0 ;; esac
  f17_seen="$f17_seen$lead "
  command -v "$lead" >/dev/null 2>&1 && return 0
  hint=""
  case "$lead" in
    python) command -v python3 >/dev/null 2>&1 && hint=' (this machine has python3 — write python3)' ;;
    rg)     hint=' (rg is often a shell alias, not a binary — use grep -R, or install ripgrep)' ;;
  esac
  printf 'F17 phase %s: §Verification lead `%s` is not installed on this machine — the autopilot will SKIP that command at verification (a phase whose every check is skipped parks); install it or rewrite the check%s\n' "$p" "$lead" "$hint"
  return 0
}

verification_lead_advisories() {
  local p line span f17_seen
  for p in "${PHASES[@]}"; do
    _is_done "$p" && continue
    f17_seen=" "
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      case "$line" in
        *\`*)
          while IFS= read -r span; do
            [ -z "$span" ] && continue
            # A single-token span is a citation (`success`, `tree_sha`, a field
            # name in prose) — a command worth checking carries arguments. Fenced
            # lines below are commands by construction and skip this filter.
            case "$span" in *[[:space:]]*) _f17_report "$span" ;; esac
          done < <(printf '%s\n' "$line" | grep -oE '`[^`]+`' | sed 's/^`//; s/`$//')
          ;;
        *) _f17_report "$line" ;;
      esac
    done < <(_verification_reach "$p")
  done
  return 0
}

# F22: a bring-up command inside §Verification — ADVISORY, never a gate.
#
# `docker compose up -d`, `npm ci`, `sleep 8` are PREAMBLE: they make the phase
# provable, they prove nothing themselves, and a plan had nowhere else to put
# them until `- **Setup:**` existed. The cost of leaving them in §Verification
# is not cosmetic. Every one of them is a command the boarding preflight asks a
# person to vouch for, and every one is a line that can turn a phase red for a
# reason that has nothing to do with the phase's work — measured across 19 hub
# plans and 8 of the 11 done phases of one sample run (register R27).
#
# The vocabulary is `SETUP_LEADS` in scripts/verify.env. Overlap with F16 is
# deliberate and not double-reporting: a foreground `docker compose up` both
# waits on a clock and is bring-up, and the two lines say different things
# about what to do with it.
verification_setup_advisories() {
  local p hit
  for p in "${PHASES[@]}"; do
    _is_done "$p" && continue
    # Anchored to a command HEAD — the start of the reach, a shell separator, or
    # the opening backtick of a span. Unanchored it matched the `sleep 5` INSIDE
    # `until …; do sleep 5; done`, which is a poll loop's pacing and not bring-up
    # at all: the advisory told an author to move a fragment of a command.
    hit="$(_reach_folded "$p" | grep -oE "(^|[;&|\`] *)($SETUP_LEADS)" | head -1 || true)"
    hit="$(printf '%s' "$hit" | sed 's/^[^[:alnum:]]*//; s/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -n "$hit" ] && \
      printf 'F22 phase %s: `%s` is bring-up, not proof — move it to "- **Setup:**", which the runner runs BEFORE §Verification and whose failures can never mark the phase red\n' "$p" "$hit"
  done
  return 0
}

# F23: an expected failure stated in PROSE beside a command — ADVISORY, never a
# gate.
#
# "`task verify` — expected to fail until Phase 9" is a §Verification line that
# reads as passing to a person and as FAILING to the runner, which executes the
# command and takes its exit code. The prose is invisible to it. A phase whose
# proof is "this must not work yet" has to say so in the command — `! task
# verify`, or a grep for the specific error — so that the thing being asserted
# is the thing being run.
#
# Matched on the phrases people actually write, and only inside the reach, so a
# note in §Goal about an expected failure elsewhere is not a finding.
verification_expected_failure_advisories() {
  local p hit
  for p in "${PHASES[@]}"; do
    _is_done "$p" && continue
    hit="$(_reach_folded "$p" \
      | grep -oiE '(expected|expect|should|will|must) (to )?(fail|be red|error|exit non-?zero)|known[ -]red|red until|fails? until|EXPECTED RED' \
      | head -1 || true)"
    hit="$(printf '%s' "$hit" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -n "$hit" ] && \
      printf 'F23 phase %s: §Verification says "%s" in prose — the runner reads exit codes, not sentences, so it will call this phase red; encode the expectation in the command (`! <cmd>`, or grep for the specific error)\n' "$p" "$hit"
  done
  return 0
}

# F18: a cwd-sensitive §Verification lead with no **Verify in:** — ADVISORY,
# never a gate. `pnpm test` means a different thing in every directory; the
# runner executes §Verification at the repository root unless the phase pins
# **Verify in:**, and the measured failure is a green session followed by a
# spurious red halt (`git -C aws` exited 128, pnpm found no package.json)
# because the commands were authored against a different cwd. A `cd `-prefixed
# command settles the question itself (its lead is `cd`); a declared
# **Verify in:** anywhere in the phase block — top-level bullet or nested
# under Verification — settles it for the whole phase.
verification_cwd_advisories() {
  local p line span lead hit
  for p in "${PHASES[@]}"; do
    _is_done "$p" && continue
    _phase_block "$p" | grep -qiE '\*\*Verify in:?\*\*' && continue
    hit=""
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      case "$line" in
        *\`*)
          while IFS= read -r span; do
            [ -z "$span" ] && continue
            [ -n "$hit" ] && break
            # Same citation filter as F17: a lone token in backticks is prose.
            case "$span" in *[[:space:]]*) : ;; *) continue ;; esac
            lead="$(_verification_lead "$span")"
            [ -z "$lead" ] && continue
            case " $CWD_SENSITIVE " in *" $lead "*) hit="$lead" ;; esac
          done < <(printf '%s\n' "$line" | grep -oE '`[^`]+`' | sed 's/^`//; s/`$//')
          ;;
        *)
          lead="$(_verification_lead "$line")"
          if [ -n "$lead" ]; then
            case " $CWD_SENSITIVE " in *" $lead "*) hit="$lead" ;; esac
          fi
          ;;
      esac
      [ -n "$hit" ] && break
    done < <(_verification_reach "$p")
    [ -n "$hit" ] && \
      printf 'F18 phase %s: `%s` is cwd-sensitive and the phase declares no **Verify in:** — the autopilot runs §Verification at the repository root, where it may test the wrong tree; add "- **Verify in:** <dir>" to §Phase %s\n' "$p" "$hit" "$p"
  done
  return 0
}

# The body of ONE section of the plan — the heading excluded, up to the next
# heading of the same or a higher level. `_section 2 "session budget"` is the
# §Session budget block every directive reader below scans; `_section 3 "qa
# contract"` the optional H3. Case-insensitive prefix match on the heading
# text, and an H3 inside an H2 section stays inside it. One awk, every
# reader — six inlined copies of it used to disagree by a character.
_section() {  # _section <level> <heading-prefix>
  local hashes open_re close_re
  hashes="$(printf '%*s' "$1" '' | tr ' ' '#')"
  open_re="^${hashes}[[:space:]]+$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
  if [ "$1" -ge 3 ]; then close_re="^#{2,3}[[:space:]]"; else close_re="^##[[:space:]]"; fi
  awk -v open_re="$open_re" -v close_re="$close_re" '
    tolower($0) ~ open_re { f = 1; next }
    f && $0 ~ close_re { f = 0 }
    f
  ' "$plan_file"
}

# F6: model named in the plan's "## Session budget" section (empty if none).
plan_model() {
  # The alternation is built from models.env rather than spelled here, and the
  # match keeps whatever surrounds the family word — a full id and the [1m]
  # window suffix both survive, because resolve_budget needs to see the suffix.
  # Collapsing "claude-opus-5[1m]" to "opus" is exactly the silent loss this
  # file exists to stop.
  local alts
  alts="$(printf '%s %s' "$MODEL_ALIASES" "$MODEL_BIG" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' '|' | sed 's/|$//')"
  _section 2 "session budget" \
    | grep -ioE "(claude-)?($alts)(-[0-9a-z.]+)*(\\[1m\\])?" | head -1 | tr '[:upper:]' '[:lower:]'
}

# Skills directive: backtick-quoted skill names on the canonical
# "**Skills (every session):**" line in the plan's "## Session budget" section — the
# skills EVERY session in this plan must invoke. Re-injected into every boot prompt +
# the QA brief so a cold-start session re-activates them (e.g. `design-system`,
# `some-plugin:test-first`). Empty if none. ONLY that exact phrase
# matches — a loose 'skill' match would swallow backticked tokens from unrelated
# budget prose (e.g. "skill v3 sizing — `claude-opus-5`") into the skills list.
plan_skills() {
  # `|| true`: a no-match grep mid-pipe exits 1, which under `set -euo pipefail`
  # would otherwise abort every caller (e.g. --boot-prompt) on a plan with no Skills line.
  _section 2 "session budget" \
    | grep -i 'skills (every session)' | grep -oE '`[^`]+`' | tr -d '`' | paste -sd ',' - | sed 's/,/, /g' || true
}

# MCP directive: backtick-quoted server ids on the canonical
# "**MCP servers (every session):**" line in the plan's "## Session budget" section —
# the servers EVERY session in this plan needs. Re-injected into every boot prompt +
# the QA brief, and read by the console's preflight so a run parks before it spends
# tokens rather than after. Empty if none. ONLY that exact phrase matches, for the
# same reason plan_skills() is strict: a loose 'mcp' match would swallow backticked
# tokens out of unrelated budget prose.
plan_mcp() {
  _section 2 "session budget" \
    | grep -i 'mcp servers (every session)' | grep -oE '`[^`]+`' | tr -d '`' | paste -sd ',' - | sed 's/,/, /g' || true
}

# Credentials directive (chapter 10 ZTD-4): backtick-quoted credential ids on
# the canonical "**Credentials:**" line in §Session budget — the credentials
# EVERY phase needs, resolved by the console against its registry of named
# credential probes BEFORE a phase boards (phase 11's prelude) and read here by
# --credentials, F15 and the boot prompt. The `MCP servers` shape exactly:
# strict phrase, backticked ids, csv out, empty when none.
plan_credentials() {
  _section 2 "session budget" \
    | grep -iE '^[[:space:]>]*\*{0,2}credentials\*{0,2}[[:space:]]*:' | head -1 \
    | grep -oE '`[^`]+`' | tr -d '`' | paste -sd ',' - | sed 's/,/, /g' || true
}

# Accounts directive (chapter 13 §1.1, `accounts`): backticked `id:minHeadroom`
# pairs on the canonical "**Accounts:**" line in §Session budget — which Claude
# accounts a run may spend, in order, each with the minimum five-hour headroom
# (a percent, 0–100) it must show before a phase boards. Printed one per line
# as id<TAB>min, min empty when the pair carries none.
plan_accounts() {
  _section 2 "session budget" \
    | grep -iE '^[[:space:]>]*\*{0,2}accounts\*{0,2}[[:space:]]*:' | head -1 \
    | grep -oE '`[^`]+`' | tr -d '`' \
    | awk -F: '{ id = $1; min = (NF > 1) ? $2 : ""; gsub(/^[[:space:]]+|[[:space:]]+$/, "", id); gsub(/^[[:space:]]+|[[:space:]%]+$/, "", min); if (id != "") print id "\t" min }' || true
}

# The plan's own review rules, verbatim — the optional "### QA contract" section.
#
# Why the engine has to carry this. The QA brief below is generic by
# construction: it knows the phase, the round and the diff, and it offers the
# three verdicts `qa-record.sh` accepts. What it cannot know is that a
# particular plan has RULED ONE OUT — and a plan that says so only in prose is
# telling it to a reader the reviewer never has. That is not hypothetical: a
# plan whose predecessor recorded ten `waived` rows (one of them over an empty
# handoff) wrote "`waived` is not an accepted verdict on this plan" into its
# own text, and the brief went on offering `waived` as a third option in the
# very line the reviewer copies. Whoever writes the rule and whoever reads it
# must be handed the same words, so the section is injected verbatim rather
# than summarised, and it is printed BEFORE the numbered steps because a
# constraint that arrives after the verb has already lost.
#
# Deliberately verbatim and unparsed: the engine takes no position on WHAT a
# plan may demand of its reviewers, only that the demand reaches them. Empty
# when the plan has no such section, which is the normal case.
plan_qa_contract() {
  _section 3 "qa contract" \
    | sed -e '/^[[:space:]]*$/d' || true
}

# Every server this phase runs with: the plan-wide line unioned with the phase's
# own bullet, deduped, first-seen order. The union is the point — a plan-wide
# server is not something a phase opts into, and a phase bullet adds rather than
# replaces. (Dropping the run's servers for one phase is a RUN-level decision the
# console owns via `mcpOff`, not something a versioned plan should have to say.)
# The plan-wide `**Setup (every phase):**` line's TEXT (not a parsed list —
# the same extractor that runs §Verification reads commands out of prose).
plan_setup() {
  _section 2 "session budget" \
    | grep -i 'setup (every phase)' | head -1 \
    | sed -E 's/^[[:space:]]*[-*][[:space:]]*//; s/^\*{0,2}[Ss]etup \(every phase\):?\*{0,2}[[:space:]]*//' || true
}

# The commands a phase actually brings up with: the plan-wide line first, then
# the phase's own `- **Setup:**` bullet. One command per line, in order — the
# order matters, because the shared stack has to be up before a phase's extra
# step against it can work.
setup_for_phase() {  # setup_for_phase <phase>
  local wide
  wide="$(plan_setup)"
  {
    [ -n "$wide" ] && printf '%s\n' "$wide" | grep -oE '`[^`]+`' | tr -d '`'
    _setup_commands "$1"
  } || true
}

# The phase's own Setup bullet, as commands.
#
# Backtick spans where there are backticks, and the LINE ITSELF where there are
# none — because `_verification_reach` yields two kinds of line and only one of
# them carries them. A fenced block is commands by construction (it is what the
# runner's own `extractCommands` treats it as), and greping it for backticks
# printed nothing: `--setup` answered empty and the boot prompt omitted "Bring
# the stack up first" entirely, while the runner went ahead and ran the block.
# Two readers of one bullet disagreeing about whether it exists.
_setup_commands() {  # _setup_commands <phase>
  local line
  while IFS= read -r line; do
    case "$line" in
      *\`*) printf '%s\n' "$line" | grep -oE '`[^`]+`' | tr -d '`' ;;
      *)
        # A fenced line. Trim, and skip the blanks and comment lines a block
        # carries — neither is a command, and printing one would put it in a
        # boot prompt as if it were.
        line="$(printf '%s' "$line" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
        case "$line" in ''|'#'*) ;; *) printf '%s\n' "$line" ;; esac
        ;;
    esac
  done < <(_verification_reach "$1" "Setup")
  return 0
}

mcp_for_phase() {  # mcp_for_phase <phase>
  local combined seen out t
  combined="$(plan_mcp)"
  t="$(mcp_directive "$1")"
  [ -n "$t" ] && combined="${combined:+$combined, }$t"
  [ -z "$combined" ] && return 0
  seen=" "; out=""
  # bash 3.2: no associative arrays, so membership is a substring test on a
  # space-delimited string — the same trick _gate_type_known uses.
  local IFS=,
  for t in $combined; do
    t="$(printf '%s' "$t" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$t" ] && continue
    case "$seen" in *" $t "*) continue ;; esac
    seen="${seen}${t} "
    out="${out:+$out, }$t"
  done
  printf '%s' "$out"
}

# What a phase does when one of its MCP servers will not connect: "continue"
# (run without it and say so) or "require" (park at boarding before spending).
#
# Two shapes, the phase's own OVERRIDING the plan-wide one — note that this is
# the opposite of how `--mcp` composes, where a phase's servers union with the
# plan's. Servers are additive because a phase needing one more is not a
# disagreement; a policy is a single answer, and the more specific statement has
# to win or a plan could never say "these servers matter, except in the one
# phase that touches none of it".
#
# Both words are recognised, and everything else is silence. Three states, not
# two, and the third is load-bearing: an explicit `continue` on a phase is what
# lets it carve itself out of a plan-wide `require`, while "the plan said
# nothing" has to stay distinguishable so the console's own setting can answer.
# Collapsing silence into `continue` would make a run-level choice unreachable
# on every plan ever written; collapsing it into `require` would stop plans over
# a typo. So a word that is neither prints nothing and falls through, which is
# the same fail-safe direction gitMode takes in the console's preferences.
plan_mcp_policy() {
  _section 2 "session budget" \
    | grep -i 'mcp policy' | head -1 \
    | sed -E 's/.*[Mm][Cc][Pp][[:space:]]*[Pp]olicy[^:]*:[[:space:]]*//; s/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
    | tr '[:upper:]' '[:lower:]' | awk '$1=="require"{print "require"} $1=="continue"{print "continue"}' || true
}

mcp_policy_directive() {  # mcp_policy_directive <phase>
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*][[:space:]]*\*{0,2}MCP[[:space:]]+policy\*{0,2}[[:space:]]*:' \
    | head -1 \
    | sed -E 's/.*[Mm][Cc][Pp][[:space:]]*[Pp]olicy\*{0,2}[[:space:]]*:[[:space:]]*//; s/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
    | tr '[:upper:]' '[:lower:]' | awk '$1=="require"{print "require"} $1=="continue"{print "continue"}' || true
}

mcp_policy_for_phase() {  # mcp_policy_for_phase <phase>
  local own
  own="$(mcp_policy_directive "$1")"
  [ -n "$own" ] && { printf '%s' "$own"; return 0; }
  printf '%s' "$(plan_mcp_policy)"
}

# ---- Credentials: the MCP shapes, verbatim (ZTD-4) ---------------------------
# A phase's own `- **Credentials:** \`x\`` bullet UNIONS with the plan line, as
# servers do; `**Credential policy:** require|continue` OVERRIDES like MCP
# policy, with the same three states (silence is the console's to answer).
credentials_directive() {  # credentials_directive <phase>
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*][[:space:]]*\*{0,2}credentials\*{0,2}[[:space:]]*:' \
    | head -1 | grep -oE '`[^`]+`' | tr -d '`' | paste -sd ',' - | sed 's/,/, /g' || true
}

credentials_for_phase() {  # credentials_for_phase <phase>
  local combined seen out t
  combined="$(plan_credentials)"
  t="$(credentials_directive "$1")"
  [ -n "$t" ] && combined="${combined:+$combined, }$t"
  [ -z "$combined" ] && return 0
  seen=" "; out=""
  local IFS=,
  for t in $combined; do
    t="$(printf '%s' "$t" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -z "$t" ] && continue
    case "$seen" in *" $t "*) continue ;; esac
    seen="${seen}${t} "
    out="${out:+$out, }$t"
  done
  printf '%s' "$out"
}

plan_credential_policy() {
  _section 2 "session budget" \
    | grep -i 'credential policy' | head -1 \
    | sed -E 's/.*[Cc]redential[[:space:]]*[Pp]olicy[^:]*:[[:space:]]*//; s/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
    | tr '[:upper:]' '[:lower:]' | awk '$1=="require"{print "require"} $1=="continue"{print "continue"}' || true
}

credential_policy_directive() {  # credential_policy_directive <phase>
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*][[:space:]]*\*{0,2}credential[[:space:]]+policy\*{0,2}[[:space:]]*:' \
    | head -1 \
    | sed -E 's/.*[Cc]redential[[:space:]]*[Pp]olicy\*{0,2}[[:space:]]*:[[:space:]]*//; s/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
    | tr '[:upper:]' '[:lower:]' | awk '$1=="require"{print "require"} $1=="continue"{print "continue"}' || true
}

credential_policy_for_phase() {  # credential_policy_for_phase <phase>
  local own
  own="$(credential_policy_directive "$1")"
  [ -n "$own" ] && { printf '%s' "$own"; return 0; }
  printf '%s' "$(plan_credential_policy)"
}

# ---- Two policy words the console reads at run time (phase 11) --------------
# `**QA exhausted:** waive|halt|<owner>` in §Session budget answers "and if the
# QA round budget runs out?" (ZTD-9, the `qa.exhausted` row); a phase's own
# `- **Person-check:** allow|halt|<owner>` answers what to do with a
# §Verification fragment written as prose (ZTD-6, `verification.person-check`).
# One word each, lower-cased, bold and backticks stripped; an owner is any
# single token that is not one of the closed words. Silence prints nothing —
# the console's policy table answers then. The JS twins are `qaExhausted` on
# `SessionBudget` and `personCheckFor` in parse/plan.ts (engine-parity holds them).
_policy_word() {  # _policy_word — stdin: the line's remainder; prints one word or nothing
  sed -E 's/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
    | awk 'NF>0 { w=tolower($1); sub(/[[:punct:]]+$/, "", w); if (w != "") print w; exit }'
}

plan_qa_exhausted() {
  _section 2 "session budget" \
    | grep -iE '^[[:space:]>]*\*{0,2}QA[[:space:]]+exhausted\*{0,2}[[:space:]]*:' | head -1 \
    | sed -E 's/.*[Qq][Aa][[:space:]]+[Ee]xhausted\*{0,2}[[:space:]]*:[[:space:]]*//' \
    | _policy_word || true
}

person_check_for_phase() {  # person_check_for_phase <phase>
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*][[:space:]]*\*{0,2}person-check\*{0,2}[[:space:]]*:' | head -1 \
    | sed -E 's/.*[Pp]erson-check\*{0,2}[[:space:]]*:[[:space:]]*//' \
    | _policy_word || true
}

# ---- The wait budget: how long a phase may stay parked (WAI-1, `waits`) -----
# `**Wait budget:** 48h` in §Session budget is the total wall-clock ONE phase may
# spend parked across its declared waits; a phase's own
# `- **Waits on:** <ref>[, <ref>…] · <max>` names what it waits on and overrides
# that total for itself — and a `date:` ref named there is the plan
# countersigning a wait up to that instant (the console reads both through
# --wait-budget / --waits-on). Minutes, so bash 3.2 never multiplies
# milliseconds; the console's own default is the console's, so silence prints
# nothing. The JS twin is `waitBudgetFor`/`waitsOnFor` in parse/plan.ts.
duration_minutes() {  # duration_minutes <text> → the FIRST duration as minutes, or nothing
  printf '%s\n' "$1" | tr -d '`*' | awk '{
    if (!match($0, /[0-9]+[[:space:]]*(minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)([^A-Za-z0-9_]|$)/)) exit
    s = substr($0, RSTART, RLENGTH)
    n = s; sub(/[^0-9].*$/, "", n); n = n + 0
    u = s; sub(/^[0-9]+[[:space:]]*/, "", u); sub(/[^A-Za-z].*$/, "", u); u = tolower(u)
    if (n <= 0) exit
    if (u ~ /^d/) print n * 1440; else if (u ~ /^h/) print n * 60; else print n
    exit
  }' || true
}

plan_wait_budget() {  # plan_wait_budget → minutes, or nothing
  local body
  body="$(_section 2 "session budget" \
    | grep -iE '^[[:space:]>]*\*{0,2}wait[[:space:]]+budget\*{0,2}[[:space:]]*:' | head -1 \
    | sed -E 's/^[^:]*:[[:space:]]*//')" || true
  [ -n "$body" ] && duration_minutes "$body"
  return 0
}

waits_on_directive() {  # waits_on_directive <phase> → the bullet's body after its label, verbatim
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*][[:space:]]*\*{0,2}waits[[:space:]]+on\*{0,2}[[:space:]]*:' | head -1 \
    | sed -E 's/^[^:]*:[[:space:]]*//; s/^\*{1,2}[[:space:]]*//' || true
}

waits_on_refs() {  # waits_on_refs <phase> → one ref per line: backticked spans, else the comma list
  local body left
  body="$(waits_on_directive "$1")"
  [ -z "$body" ] && return 0
  left="${body%%·*}"
  case "$left" in
    *'`'*) printf '%s\n' "$left" | grep -oE '`[^`]+`' | tr -d '`' || true ;;
    *) printf '%s\n' "$left" | tr ',' '\n' | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | grep -v '^$' || true ;;
  esac
  return 0
}

wait_budget_for_phase() {  # wait_budget_for_phase <phase> → minutes<TAB>phase|plan, or nothing
  local body m
  body="$(waits_on_directive "$1")"
  case "$body" in
    *·*) m="$(duration_minutes "${body#*·}")" ;;
    *) m="" ;;
  esac
  if [ -n "$m" ]; then printf '%s\tphase\n' "$m"; return 0; fi
  m="$(plan_wait_budget)"
  [ -n "$m" ] && printf '%s\tplan\n' "$m"
  return 0
}

# ---- The decision manifest (chapter 13 §1.1) --------------------------------
# `## Decisions` in the plan, and docs/handoffs/<slug>/decisions.md — the
# mutable twin only scripts/decisions.sh writes — read with ONE awk: the first
# pipe table under the first `## Decisions` heading, columns located BY NAME
# (`key value owner state blocking source evidence`, optional `phase`), the
# `|---|` row skipped, a table inside a fence ignored. Records are US-separated
# `layer<US>key<US>value<US>owner<US>state<US>blocking<US>source<US>evidence<US>phase`;
# key/owner/state/blocking/source lose their bold and backticks, value and
# evidence keep theirs (tabs and newlines can never reach a cell, so the TSV
# below stays six columns). The JS reader (viewer/shared/decisions-model.js)
# does exactly this and engine-parity holds the two together.
_decisions_table() {  # _decisions_table <file> <layer>
  [ -f "$1" ] || return 0
  awk -v layer="$2" '
    function plain(c) { gsub(/[*`]/, "", c); gsub(/^[[:space:]]+|[[:space:]]+$/, "", c); return c }
    function trim(c)  { gsub(/[\t]/, " ", c); gsub(/^[[:space:]]+|[[:space:]]+$/, "", c); return c }
    /^[[:space:]]*(```|~~~)/ { fence = !fence; next }
    fence { next }
    !armed { if (tolower($0) ~ /^##[[:space:]]+decisions/) armed = 1; next }
    /^[[:space:]]*\|/ {
      line = $0; sub(/^[[:space:]]*\|/, "", line); sub(/\|[[:space:]]*$/, "", line)
      n = split(line, c, "|")
      if (!header) {
        header = 1
        for (i = 1; i <= n; i++) { h = tolower(plain(c[i])); col[h] = i }
        next
      }
      sep = 1; for (i = 1; i <= n; i++) if (trim(c[i]) !~ /^:?-{2,}:?$/) sep = 0
      if (sep) next
      if (!("key" in col)) next
      key = plain(c[col["key"]]); if (key == "") next
      value = ("value" in col) ? trim(c[col["value"]]) : ""
      owner = ("owner" in col) ? plain(c[col["owner"]]) : ""
      state = ("state" in col) ? tolower(plain(c[col["state"]])) : ""
      blocking = ("blocking" in col) ? tolower(plain(c[col["blocking"]])) : ""
      blocking = (blocking == "yes" || blocking == "true" || blocking == "y") ? "yes" : "no"
      source = ("source" in col) ? tolower(plain(c[col["source"]])) : ""
      evidence = ("evidence" in col) ? trim(c[col["evidence"]]) : ""
      phase = ("phase" in col) ? plain(c[col["phase"]]) : ""
      if (phase !~ /^[0-9]+$/) phase = ""; else phase = phase + 0
      printf "%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\n", layer, key, value, owner, state, blocking, source, evidence, phase
      rows++
      next
    }
    header { exit }
    /^##[[:space:]]/ { exit }
  ' "$1"
}

decisions_twin_file="$DOCS_ROOT/docs/handoffs/${slug}/decisions.md"
plan_decisions() { _decisions_table "$plan_file" 1; }
twin_decisions() { _decisions_table "$decisions_twin_file" 2; }

# The rows that hold — for the plan (no argument) or for phase N — as
# key<TAB>state<TAB>owner<TAB>blocking<TAB>source<TAB>value, in DECISION_KEYS
# order, unknown keys after in first-seen order. Merge order, lowest to
# highest: plan plan-wide → twin plan-wide → plan phase-N → twin phase-N; a
# later row replaces the earlier one WHOLE. Rows scoped to another phase, and
# every scoped row when no phase is asked, are left out.
decisions_rows() {  # decisions_rows [phase]
  { plan_decisions; twin_decisions; } | awk -F'\037' -v ph="${1:-}" -v keys="$DECISION_KEYS" '
    BEGIN { n = split(keys, K, " "); for (i = 1; i <= n; i++) known[K[i]] = 1 }
    {
      layer = $1 + 0; key = $2; rowphase = $9
      if (rowphase == "") rank = layer
      else if (ph != "" && rowphase == ph) rank = layer + 2
      else next
      if (!(key in best) || rank >= best[key]) {
        best[key] = rank
        row[key] = $2 "\t" $5 "\t" $4 "\t" $6 "\t" $7 "\t" $3
        if (!(key in seen)) { seen[key] = ++m; unk[m] = key }
      }
    }
    END {
      for (i = 1; i <= n; i++) if (K[i] in row) print row[K[i]]
      for (j = 1; j <= m; j++) { k = unk[j]; if (!(k in known)) print row[k] }
    }'
}

# The policy that will ACTUALLY apply — the plan's word if it has one, else the
# console's run-level default, told to us through PE_MCP_POLICY the way the
# registry is told through PE_MCP_SERVERS.
#
# Deliberately a SEPARATE function from mcp_policy_for_phase, which stays "what
# the plan says" because that is what --mcp-policy reports and what the JS
# parser is held to by engine-parity. Only F15's consequence wording needs the
# resolved answer, and only because it is describing what the console will do.
#
# Unset PE_MCP_POLICY (a bare skill install, validate.sh run by hand) leaves
# this empty — the same third state as plan silence, and never `require`.
effective_mcp_policy() {  # effective_mcp_policy [phase]
  local own
  if [ -n "${1:-}" ]; then own="$(mcp_policy_for_phase "$1")"; else own="$(plan_mcp_policy)"; fi
  [ -n "$own" ] && { printf '%s' "$own"; return 0; }
  case "${PE_MCP_POLICY:-}" in
    require) printf 'require' ;;
    continue) printf 'continue' ;;
    *) printf '' ;;
  esac
}

# done-set override hook: --ready-after N treats N as already done.
assume_done="${arg:-}"
_is_done() {  # _is_done <phase>  (respects the assume-done override)
  [ "$1" = "$assume_done" ] && { return 0; }
  [ "${STATUS[$1]:-not-started}" = "done" ]
}

# ---- QA verification gate (Task 6) ----------------------------------------
# When docs/handoffs/<slug>/test-status.md exists, dependents are gated on their
# deps being QA-VERIFIED (handoff complete AND QA result pass|waived), not merely
# done. No test-status.md → gating off → behaviour identical to before.
qa_status_file="$DOCS_ROOT/docs/handoffs/${slug}/test-status.md"
# Set below, once `qa_mode` is defined: whether QA GATES is a question about the
# plan's directive, not merely about a file existing. See the assignment after
# `qa_mode()`.
QA_GATING=0
qa_result() {  # qa_result <phase> → pass|fail|pending|waived|none  (from the "## QA status" table)
  [ -f "$qa_status_file" ] || { echo none; return; }
  sed 's/–/-/g; s/—/-/g' "$qa_status_file" | awk -F'|' -v want="$1" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    tolower($0) ~ /^##[[:space:]]+qa status/ { inq=1; seen=0; next }
    inq && seen && $0 !~ /^[[:space:]]*\|/ { inq=0 }
    inq && /^[[:space:]]*\|/ {
      seen=1; ph=trim($2); gsub(/[*`]/,"",ph); ph=trim(ph)
      if (ph != want) next
      # The VERDICT cell gets the same markdown strip the phase cell has always
      # had. It did not, so a row written `| 3 | `pass` |` gated its dependents
      # while reading as an unknown word — and once `qa_history` and the JS
      # parser both stripped it, bash disagreed with itself about one row.
      v=trim($3); gsub(/[*`]/,"",v); v=trim(v)
      print tolower(v); found=1; exit
    }
    END { if (!found) print "none" }
  '
}
# Every round a phase has on file, oldest first, one per line:
#   round <TAB> result <TAB> report <TAB> recorded
#
# `qa_result` above answers the CURRENT verdict — the one and only thing that
# gates. This answers the history behind it, which until rounds existed was
# knowable only by listing `reports/` and reading filenames: `test-status.md`
# kept one row per phase pointing at the last report and the earlier ones were
# invisible to the engine, the API and every screen (issue #7).
#
# The source is the `## QA rounds` ledger `qa-record.sh` appends to. A file
# written before that ledger existed has none, and the fallback is the status
# row itself — a legacy `fail` IS one round that happened, and answering "no QA
# ran" about a phase QA demonstrably failed would be worse than approximating
# its number. A `pending` row is not a round: it is the absence of a review.
qa_history() {  # qa_history <phase> → round\tresult\treport\trecorded (oldest first)
  [ -f "$qa_status_file" ] || return 0
  sed 's/–/-/g; s/—/-/g' "$qa_status_file" | awk -F'|' -v want="$1" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); gsub(/[*`]/,"",s); sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    # A report cell may be a markdown LINK. The JS reader takes the target, so
    # this must too, or the two disagree about the round a legacy row is
    # (QA round 3, F5) — bash read the label and found no `-roundN.md`.
    function target(s,  m){ if (match(s, /\]\([^)]+\)/)) return substr(s, RSTART + 2, RLENGTH - 3); return s }
    tolower($0) ~ /^##[[:space:]]+qa[[:space:]]+status/ { sec="status"; seen=0; next }
    tolower($0) ~ /^##[[:space:]]+qa[[:space:]]+rounds/ { sec="rounds"; seen=0; next }
    /^[[:space:]]*#/ { sec=""; seen=0; next }
    sec != "" && seen && $0 !~ /^[[:space:]]*\|/ { sec=""; seen=0 }
    sec != "" && /^[[:space:]]*\|/ {
      seen=1
      if (trim($2) != want) next
      if (sec == "rounds") {
        r = trim($3); if (r !~ /^[0-9]+$/) next
        n++; rnd[n]=r; res[n]=tolower(trim($4)); rep[n]=target(trim($5)); day[n]=trim($6)
      } else {
        v = tolower(trim($3))
        if (v == "pass" || v == "fail" || v == "waived") {
          cres=v; crep=target(trim($4)); crnd=trim($5)
          # No Round cell — a row written before rounds existed. Its number is
          # in its FILENAME: the `-roundN.md` convention the sessions invented
          # is the only record those rows have, and reading the report of round
          # 3 as round 1 is how the engine came to hand a reviewer the name of a
          # file that already exists (QA F1). Absent that suffix it really is 1.
          # An explicit Round cell is authoritative and is read FIRST: the
          # exclusion below used to run before this test, so a numbered waiver
          # was discarded whole here and counted by the JS parser (QA round 4, F3).
          if (crnd !~ /^[0-9]+$/ || crnd + 0 < 1) {
            # `| N | waived | - |` with no report AND no round is the mid-plan
            # ACTIVATION backfill, whose own comment says it means "finished
            # before QA was on and nobody reviewed it". That is not a round, and
            # counting it as one sends the next reviewer to `-round2.md` for a
            # phase never reviewed (QA round 3, F4). A `pass` or `fail` without
            # a report IS a review — somebody recorded a verdict — so only the
            # waiver is excluded.
            if (v == "waived" && (crep == "" || crep == "-")) { cres=""; next }
            crnd = 1
            # `rn`, never `n` — `n` is the ledger row counter in the branch
            # above, and reusing it here made the END block print that many
            # blank rows for a legacy phase.
            if (match(crep, /-round[0-9]+\.md$/)) {
              rn = substr(crep, RSTART + 6, RLENGTH - 9)
              if (rn + 0 > 0) crnd = rn + 0
            }
          }
        }
      }
    }
    END {
      # Oldest first, whatever order the FILE holds them in. A backfilled legacy
      # round is appended after the row it precedes, and a round recorded out of
      # sequence by hand lands wherever the upsert put it — so the reader sorts
      # rather than trusting the layout. Insertion sort: a phase has a handful of
      # rounds, and bash 3.2 awk has nothing better.
      if (n > 0) {
        for (i = 2; i <= n; i++) {
          kr = rnd[i]; ks = res[i]; kp = rep[i]; kd = day[i]; j = i - 1
          while (j >= 1 && rnd[j] + 0 > kr + 0) {
            rnd[j+1]=rnd[j]; res[j+1]=res[j]; rep[j+1]=rep[j]; day[j+1]=day[j]; j--
          }
          rnd[j+1]=kr; res[j+1]=ks; rep[j+1]=kp; day[j+1]=kd
        }
        for (i=1; i<=n; i++) printf "%s\t%s\t%s\t%s\n", rnd[i], res[i], (rep[i]==""?"-":rep[i]), (day[i]==""?"-":day[i])
      }
      else if (cres != "") printf "%s\t%s\t%s\t-\n", crnd, cres, (crep==""?"-":crep)
    }
  '
}
# The next QA round for a phase and the report it must write, as
# `round<TAB>report`. The BASH half of the one chooser — `viewer/server/qa-round.ts`
# is the other, and `viewer/test/qa-round.test.ts` holds them equal over every
# table shape that exists in the wild.
#
# Six places had to answer this and were fixed one at a time, which is why QA
# failed this phase four times running: each round found the sites it had named
# corrected and one more still saying "round 1". A wrong answer here is not
# cosmetic — a reviewer handed a filename that already exists overwrites a
# committed report, which is the defect rounds were introduced to end.
#
# Highest on file + 1, then past anything already on disk. Every clause is a
# fixed bug: a COUNT said 2 about a recorded round 2 on an upgraded table; the
# status row alone forgets its history the moment it reads `pending`; and
# "wrote a report, recorded nothing" is a real outcome that leaves a file no row
# mentions.
qa_next_round() {  # qa_next_round <phase> → round	report
  local _p _pad _r _rest _round _cand _probe
  _p="$((10#$1))"; _pad="$(printf '%02d' "$_p")"
  _round=1
  while IFS="$(printf '\t')" read -r _r _rest; do
    case "$_r" in ''|*[!0-9]*) continue ;; esac
    _r=$((10#$_r))   # `08` in a cell is eight, never octal (QA round 6)
    [ "$_r" -ge "$_round" ] && _round=$((_r + 1))
  done <<EOF
$(qa_history "$_p")
EOF
  _probe=0
  while [ "$_probe" -lt 20 ]; do
    if [ "$_round" -gt 1 ]; then _cand="reports/phase-${_pad}-qa-round${_round}.md"
    else _cand="reports/phase-${_pad}-qa.md"; fi
    [ -e "$handoff_dir/$_cand" ] || break
    _round=$((_round + 1)); _probe=$((_probe + 1))
  done
  printf '%s\t%s\n' "$_round" "$_cand"
}

# A phase's OWN QA directive: `- **QA:** on|off` in its §Phase section.
#
# `**QA gate:**` in §Session budget is the whole-plan switch; this is the
# per-phase one, and it resolves the way every other per-phase directive does
# (see `mcp_policy`): the phase's own word wins, silence inherits the plan.
# It exists because "QA this plan" is rarely the truth — a docs phase, a
# scaffold, a ship phase whose real check is the deploy do not want a reviewer;
# the two phases that touch money do. Anything that is not exactly `on` or
# `off` is silence: a typo must inherit, never guess.
qa_phase_directive() {  # qa_phase_directive <phase> -> on|off|""
  local line
  line="$(phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*][[:space:]]*\*\*QA:?\*\*' \
    | head -1 || true)"
  [ -n "$line" ] || { echo ""; return; }
  line="$(printf '%s' "$line" | sed 's/.*\*\*[Qq][Aa]:\{0,1\}\*\*[[:space:]]*//; s/[[:space:]]*$//' | tr 'A-Z' 'a-z')"
  case "$line" in
    on)  echo "on" ;;
    off) echo "off" ;;
    *)   echo "" ;;
  esac
}

# `- **Checkout:** <branch>` — which branch this phase's session works ON.
#
# One value has a meaning the console acts on: the plan's DEFAULT BRANCH, said
# as `main`, `master`, or the word `default`. It means *do not put this phase on
# the run branch* — board it in a checkout DETACHED at the default branch's
# head. That is what a phase after the run's pull request has merged needs: the
# branch it would have stood on no longer exists, and re-creating it would
# re-open work the merge closed.
#
# Anything else is reported verbatim and acted on by nobody: a plan is allowed
# to document which branch it means without the console inferring a mechanism
# from it. Bold optional, like the MCP bullets, because the bash readers of this
# family have always accepted both.
checkout_directive() {  # checkout_directive <phase> -> the branch, or ""
  phase_block "$1" \
    | grep -iE '^[[:space:]]*[-*][[:space:]]*\*{0,2}Checkout\*{0,2}[[:space:]]*:' \
    | head -1 \
    | sed -E 's/.*[Cc]heckout\*{0,2}[[:space:]]*:[[:space:]]*//; s/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//' \
    || true
}

# ---------------------------------------------------------------------------
# Where the work happens and where it lands (5.1.0)
# ---------------------------------------------------------------------------
#
# Nine directives, one shape. Each is read at two levels — a `**Label:**` line
# in §Session budget and a `- **Label:**` bullet on a phase — and each answers
# with `value<TAB>phase|plan|default`, which is the ONE thing this family does
# differently from every reader above it.
#
# Why the source token. `--mcp-policy` answers a bare word and lets silence
# mean "the run decides"; that works because there are two words and both are
# explicit. Here the words have engine-owned DEFAULTS (a plan that says nothing
# about landing lands nothing), so a bare `hold` would be two different facts
# wearing one spelling: "this plan chose hold" and "this plan has not thought
# about it". The console needs to tell those apart — the first is a decision to
# report, the second a question to ask in the wizard — so the source rides
# along. `viewer/server/parse/plan.ts` returns the same pair and
# engine-parity.test.ts holds them together.
#
# The one exception is `--isolation`, which has no engine-owned default: a
# phase that says nothing inherits the RUN, and the run is not in the plan. Its
# third state is therefore silence, like `--mcp-policy`'s.
#
# The label is matched case-insensitively by `grep -iE`, and the value is
# everything after the FIRST colon — which is why these readers need no
# per-label `sed` spelling out `[Ll]and`: a label never contains a colon and a
# value often does (`ttl:48`, `origin/HEAD`, `gh:repo#pr/4`).

# stdin: one whole directive line. stdout: its value, unemphasised.
_after_colon() {
  sed -E 's/^[^:]*:[[:space:]]*//; s/[*`]//g; s/^[[:space:]]*//; s/[[:space:]]*$//'
}

_plan_directive() {  # _plan_directive <label-regex> -> the raw value, or ""
  _section 2 "session budget" \
    | grep -iE "^[[:space:]>]*\*{0,2}$1\*{0,2}[[:space:]]*:" | head -1 | _after_colon || true
}

_phase_directive() {  # _phase_directive <phase> <label-regex> -> the raw value, or ""
  phase_block "$1" \
    | grep -iE "^[[:space:]]*[-*][[:space:]]*\*{0,2}$2\*{0,2}[[:space:]]*:" | head -1 | _after_colon || true
}

# The first token, lower-cased — the shape every closed directive below reads.
_first_word() { awk 'NF>0 { w=tolower($1); sub(/[[:punct:]]+$/, "", w); if (w != "") print w; exit }'; }

# Resolve one closed-vocabulary directive to `word<TAB>source`.
#   _resolve_directive <phase|""> <plan-label> <phase-label|""> <word-list> <default|"">
# An unknown word is NOT silently replaced: it falls through to the next level,
# so a typo reads as "this level said nothing" and lint F27 names it. Replacing
# it would make `Land: pr` and `Land: prr` behave identically and differ only
# in a warning nobody reads.
_resolve_directive() {
  local phase="$1" plan_label="$2" phase_label="$3" words="$4" fallback="$5" raw word
  if [ -n "$phase" ] && [ -n "$phase_label" ]; then
    word="$(_phase_directive "$phase" "$phase_label" | _first_word)"
    case " $words " in *" $word "*) printf '%s\tphase\n' "$word"; return 0 ;; esac
  fi
  raw="$(_plan_directive "$plan_label")"
  word="$(printf '%s' "$raw" | _first_word)"
  case " $words " in *" $word "*) printf '%s\tplan\n' "$word"; return 0 ;; esac
  [ -n "$fallback" ] && printf '%s\tdefault\n' "$fallback"
  return 0
}

land_for_phase() {  # land_for_phase [phase] -> hold|integrate|pr|trunk<TAB>source
  _resolve_directive "${1:-}" 'Landing' 'Land' "$LAND_POLICIES" "$DEFAULT_LAND"
}

gitlink_for_phase() {  # gitlink_for_phase [phase] -> bump|leave<TAB>source
  _resolve_directive "${1:-}" 'Gitlink' 'Gitlink' "$GITLINK_POLICIES" "$DEFAULT_GITLINK"
}

isolation_for_phase() {  # isolation_for_phase [phase] -> shared|worktree<TAB>source, or nothing
  _resolve_directive "${1:-}" 'Isolation' 'Isolation' "$ISOLATION_DIRECTIVES" ''
}

issues_for_phase() {  # issues_for_phase [phase] -> off|draft|file<TAB>source
  _resolve_directive "${1:-}" 'Issues' 'Issues' "$ISSUE_MODES" "$DEFAULT_ISSUES"
}

plan_conflict_policy() {  # -> halt|park|rebase-session<TAB>source
  _resolve_directive '' 'Conflicts' '' "$CONFLICT_POLICIES" "$DEFAULT_CONFLICT"
}

plan_messaging() {  # -> on|off<TAB>source
  _resolve_directive '' 'Messaging' '' "$MESSAGING_WORDS" "$DEFAULT_MESSAGING"
}

# The base branch is the one value that is NOT a closed vocabulary: two words
# are special (`origin/HEAD`, `head`) and everything else is a git ref, passed
# through whole. So it takes the raw value rather than the first token — a ref
# may carry a slash, a dot and a dash, and `release/5.1` is one word to git and
# two to `awk` only if somebody writes a space into it, which is not a ref.
plan_base_branch() {  # -> <ref><TAB>plan|default
  local raw
  raw="$(_plan_directive 'Base branch')"
  if [ -n "$raw" ]; then printf '%s\tplan\n' "$raw"; return 0; fi
  printf '%s\tdefault\n' "$DEFAULT_BASE_BRANCH"
}

# The paths two concurrent phases must never both touch. A list, so no source
# token: an empty list and "the plan said nothing" are the same instruction.
plan_clash_zones() {
  _section 2 "session budget" \
    | grep -iE '^[[:space:]>]*\*{0,2}Clash zones\*{0,2}[[:space:]]*:' | head -1 \
    | grep -oE '`[^`]+`' | tr -d '`' | paste -sd ',' - | sed 's/,/, /g' || true
}

# ---------------------------------------------------------------------------
# The landing ledger — docs/handoffs/<slug>/landing.md
# ---------------------------------------------------------------------------
#
# Written by scripts/phase-landing.sh, read here by --landing and by the two
# landing gates. The columns are located BY HEADER NAME, never by position, for
# the reason table_shape_issues exists: a ledger read positionally is a board
# that answers confidently and wrongly the first time somebody adds a column.
LANDING_FILE="$DOCS_ROOT/docs/handoffs/$slug/landing.md"

landing_rows() {  # landing_rows [phase] -> phase<TAB>repo<TAB>state<TAB>policy<TAB>ref<TAB>sha<TAB>pr<TAB>by<TAB>recorded<TAB>note
  [ -f "$LANDING_FILE" ] || return 0
  awk -v want="${1:-}" '
    function plain(s) { gsub(/[*`]/, "", s); gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^\|/ {
      n = split($0, cell, "|")
      if (!have_header) {
        for (i = 2; i < n; i++) { col[tolower(plain(cell[i]))] = i }
        if ("phase" in col && "state" in col) { have_header = 1 }
        next
      }
      if ($0 ~ /^\|[ \t]*[-:|[:space:]]+\|?[ \t]*$/) next
      phase = plain(cell[col["phase"]])
      if (phase !~ /^[0-9]+$/) next
      if (want != "" && phase != want) next
      printf "%s", phase
      split("repo state policy ref sha pr by recorded note", want_cols, " ")
      for (c = 1; c <= 9; c++) {
        key = want_cols[c]
        printf "\t%s", (key in col ? plain(cell[col[key]]) : "")
      }
      printf "\n"
    }
  ' "$LANDING_FILE"
}

landing_state() {  # landing_state <phase> -> the recorded state, or ""
  landing_rows "$1" | head -1 | cut -f3
}

# Which landing state satisfies a `landed` gate under a given policy —
# LANDED_BY_POLICY, which bash 3.2 carries as `policy:state` pairs.
_landed_state_for() {  # _landed_state_for <policy>
  local pair
  for pair in $LANDED_BY_POLICY; do
    case "$pair" in "$1":*) printf '%s' "${pair#*:}"; return 0 ;; esac
  done
  return 0
}

# `landed N` / `pr-merged N`. Both answer from the ledger and from nothing
# else: the point of the pair is that "phase 8's work is on the branch I build
# on" stops being prose an operator has to confirm.
_gate_landed() {  # _gate_landed <kind: landed|pr-merged> <phase>
  local kind="$1" p="$2" policy state wanted
  case "$p" in ''|*[!0-9]*) printf 'manual: malformed %s gate (expected a phase number): %s\n' "$kind" "$p"; return 1 ;; esac
  case " ${PHASES[*]} " in
    *" $p "*) ;;
    *) printf 'blocked: %s gate names phase %s, which is not in this plan\n' "$kind" "$p"; return 1 ;;
  esac
  policy="$(land_for_phase "$p" | cut -f1)"
  state="$(landing_state "$p")"
  if [ -z "$state" ]; then
    printf 'blocked: phase %s has no landing record yet (policy %s)\n' "$p" "$policy"
    return 1
  fi
  if [ "$kind" = pr-merged ]; then
    case " $PR_MERGED_STATES " in
      *" $state "*) printf 'clear (phase %s landed: %s)\n' "$p" "$state"; return 0 ;;
    esac
    printf 'blocked: phase %s is %s, not merged\n' "$p" "$state"
    return 1
  fi
  wanted="$(_landed_state_for "$policy")"
  if [ "$state" = "$wanted" ]; then
    printf 'clear (phase %s landed: %s)\n' "$p" "$state"
    return 0
  fi
  printf 'blocked: phase %s is %s (policy %s wants %s)\n' "$p" "$state" "$policy" "$wanted"
  return 1
}

# ---------------------------------------------------------------------------
# Notes a phase is handed by the phases before it (--notes)
# ---------------------------------------------------------------------------
#
# Three sources, one question. A phase that has not started cannot be told
# anything — it has no session, no transcript and no inbox — so everything a
# finished phase learned about it has to be left somewhere the ENGINE will read
# when it finally boards:
#
#   1. a handoff's `## Notes for later phases` bullets — what a person wrote
#      for a person, and what a person will read in the file;
#   2. the rulings ledger's `deferral` lines — what a session decided to leave,
#      recorded on its way past rather than remembered until phase-finish;
#   3. the messages ledger's `deliver: boot` mail — what a peer addressed to a
#      phase rather than to a session.
#
# They are ONE command because the question is one — "what was left for me?" —
# and a session that has to ask three asks none. Sources 2 and 3 are Pro data
# read by a FREE script, deliberately: the ledgers are NDJSON a `field()`
# scanner reads, and a free `phase-graph.sh` that silently dropped two thirds of
# a phase's mail would be worse than one that never had it.
#
# One grammar, in `_note_rows_of` below and nowhere else. It used to be a bare
# regex read by two hand-rolled awk scans — the lint's and the reader's — which
# is how a note the lint could see and the reader could not becomes possible.
# The awk there is written without interval expressions (`[*]*`, never
# `\*{0,2}`): the macOS awk these scripts target has none, so `{0,2}` matches
# those four characters literally and the bullet silently never matches. Every
# other directive regex in this file is read by `grep -E`, where the interval
# works, which is exactly why the difference is easy to miss.

# How many notes a boot prompt may carry, and how long one may be.
#
# The bound is not tidiness: the block is prepended to every boarding prompt of
# a phase, so an unbounded list is a token bill charged once per attempt and
# per retry, for text the session mostly already knows. Twelve is what fits on
# a screen; the trailer says how many older ones were dropped, so nothing is
# silently swallowed. 500 characters is a note, not an essay — what does not
# fit belongs in the handoff the note can point at.
NOTES_MAX="${NOTES_MAX:-12}"
NOTE_TEXT_MAX=500

# The `## Notes for later phases` section of ONE handoff, as `target<TAB>text`
# rows — target being a phase number, `next` or `all`, lower-cased.
#
# The parser is shared with the F26 lint rather than spelled twice: a note the
# lint can see and the reader cannot (or the reverse) is the exact failure the
# lint exists to prevent.
_note_rows_of() {  # _note_rows_of <handoff-file>
  awk '
    function flush(   t) {
      if (target != "") {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", text)
        if (text != "") printf "%s\t%s\n", target, text
      }
      target = ""; text = ""
    }
    tolower($0) ~ /^##[[:space:]]+notes for later phases/ { inside = 1; next }
    inside && /^##[[:space:]]/ { flush(); inside = 0 }
    !inside { next }
    # An HTML COMMENT is not content, and skipping it is load-bearing rather
    # than tidy: the scaffolded section IS a comment, and it teaches the grammar
    # by showing `- **Phase 7:** …`. Read as notes, every freshly scaffolded
    # handoff hands phase 7 an example it never wrote and fails its own plan
    # F26. Tracked across lines because the block spans them.
    /<!--/ { comment = 1 }
    comment { if ($0 ~ /-->/) comment = 0; next }
    # A new bullet. The label runs to the first colon, and the colon sits INSIDE
    # the emphasis (`- **Phase 7:** …`), so the closing `**` has to be stripped
    # off both halves — off the label to read it, off the note so it does not
    # open with two asterisks everywhere it is shown.
    /^[[:space:]]*[-*][[:space:]]/ {
      flush()
      line = $0
      sub(/^[[:space:]]*[-*][[:space:]]*/, "", line)
      sub(/^[*]+/, "", line)
      ci = index(line, ":")
      if (ci == 0) next
      label = substr(line, 1, ci - 1)
      rest  = substr(line, ci + 1)
      sub(/[*]+$/, "", label)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", label)
      lab = tolower(label)
      sub(/^for[[:space:]]+/, "", lab)
      if (lab ~ /^phase[[:space:]]+[0-9]+$/) { t = lab; sub(/^phase[[:space:]]+/, "", t); target = t }
      else if (lab == "next") target = "next"
      else if (lab == "all")  target = "all"
      else next
      sub(/^[*]+[[:space:]]*/, "", rest)
      text = rest
      next
    }
    # A wrapped sentence is part of the note above it, not a second
    # instruction — markdown wraps and a handoff is written by hand.
    inside && target != "" && /^[[:space:]]+[^[:space:]]/ {
      line = $0; sub(/^[[:space:]]+/, "", line); text = text " " line; next
    }
    inside && /^[[:space:]]*$/ { flush(); next }
    END { flush() }
  ' "$1"
}

# Does a note written by <writer> and addressed <target> reach <want>?
# `next` is a DEPENDENCY relation, never a phase number: on a DAG "the phase
# after this one" is every phase that lists the writer, and reading it as
# `writer + 1` would hand a root's note to a phase it never unblocked.
_note_reaches() {  # _note_reaches <target> <writer> <want>
  case "$1" in
    all)  [ "$2" != "$3" ] ;;
    next) [ "$2" != "$3" ] && _in_list "$2" "${DEPS[$3]:-}" ;;
    *)    [ "$1" = "$3" ] && [ "$2" != "$3" ] ;;
  esac
}

# Where the two ledgers live: the injected path (a lane, a test, the runner)
# else the console's own state directory, derived exactly as phase-outcome.sh
# and phase-msg.sh derive it. Prints nothing when there is no root to derive
# from — an absent ledger is silence, never an error.
_notes_ledger() {  # _notes_ledger <rulings|messages>
  local root
  case "$1" in
    rulings)  [ -n "${PE_RULINGS_FILE:-}" ]  && { printf '%s' "$PE_RULINGS_FILE"; return 0; } ;;
    messages) [ -n "${PE_MESSAGES_FILE:-}" ] && { printf '%s' "$PE_MESSAGES_FILE"; return 0; } ;;
  esac
  root="$(pe_instance_root 2>/dev/null || true)"
  [ -n "$root" ] || return 0
  printf '%s/%s.ndjson' "$(pe_runs_dir "$root" "$slug")" "$1"
}

# Every note addressed to <phase>, as
#   urgency<TAB>at<TAB>seq<TAB>source<TAB>kind<TAB>id<TAB>text
# unsorted and unbounded. `notes_for` does the ordering; this does the reading.
_notes_candidates() {  # _notes_candidates <phase>
  local want="$1" p f at src target text seq=0 ledger now id urgency
  # ---- source 1: the handoffs ----------------------------------------------
  # DONE phases only. A phase still working may yet change its mind and a
  # blocked one has not finished the thought; neither has handed anything over,
  # and a note read off an unfinished handoff is advice its author withdrew.
  for p in "${PHASES[@]}"; do
    [ "$p" = "$want" ] && continue
    [ "$(phase_status "$p")" = "done" ] || continue
    f="$(handoff_file "$p")"
    [ -n "$f" ] || continue
    at="$(grep -m1 '^completed:' "$f" | sed 's/^completed:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
    [ -n "$at" ] || at='-'
    src="$(basename "$f" .md)"
    while IFS="$(printf '\t')" read -r target text; do
      [ -n "$target" ] || continue
      _note_reaches "$target" "$p" "$want" || continue
      seq=$((seq + 1))
      printf '1\t%s\t%s\t%s\thandoff\t-\t%s\n' "$at" "$seq" "$src" "$(printf '%s' "$text" | cut -c1-$NOTE_TEXT_MAX)"
    done <<EOF
$(_note_rows_of "$f")
EOF
  done

  # ---- source 2: the rulings ledger ----------------------------------------
  # `deferral` alone. An `ambiguity` or a `deviation` is a session explaining
  # ITSELF; only a deferral is addressed to somebody — which is the whole
  # reason `--for` exists on that kind and is refused on the other two.
  ledger="$(_notes_ledger rulings)"
  if [ -n "$ledger" ] && [ -f "$ledger" ]; then
    while IFS="$(printf '\t')" read -r p target at id text; do
      [ -n "$target" ] || continue
      _note_reaches "$target" "$p" "$want" || continue
      seq=$((seq + 1))
      printf '1\t%s\t%s\tphase-%s\tdeferral\t%s\t%s\n' "$at" "$seq" "$p" "${id:--}" "$(printf '%s' "$text" | cut -c1-$NOTE_TEXT_MAX)"
    done <<EOF
$(awk '
  function field(line, name,    v) {
    if (match(line, "\"" name "\":\"")) {
      v = substr(line, RSTART + length(name) + 4); sub(/".*/, "", v); return v
    }
    if (match(line, "\"" name "\":[0-9]+")) {
      v = substr(line, RSTART + length(name) + 3); sub(/[^0-9].*/, "", v); return v
    }
    return ""
  }
  field($0, "type") != "ruling" { next }
  field($0, "kind") != "deferral" { next }
  {
    # `next` is the default the writer did not have to type: a deferral with no
    # addressee is for whoever comes next, which is what a session means when
    # it says "left for later" and does not say for whom.
    to = field($0, "for"); if (to == "") to = "next"
    printf "%s\t%s\t%s\t%s\t%s\n", field($0, "phase"), tolower(to), field($0, "at"), field($0, "id"), field($0, "what")
  }
' "$ledger")
EOF
  fi

  # ---- source 3: the messages ledger ---------------------------------------
  # Suppressed wholesale by `**Messaging:** off`: that line says this plan's
  # sessions do not write to each other, and a reader that went on delivering
  # their mail would be answering a question the plan closed. It says nothing
  # about the plan's own rulings or its handoffs, so those two stay.
  if [ "$(plan_messaging | cut -f1)" != off ]; then
    ledger="$(_notes_ledger messages)"
    if [ -n "$ledger" ] && [ -f "$ledger" ]; then
      now="${PE_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
      while IFS="$(printf '\t')" read -r p target at id urgency text; do
        [ -n "$target" ] || continue
        _note_reaches "$target" "$p" "$want" || continue
        seq=$((seq + 1))
        printf '%s\t%s\t%s\tphase-%s\tmessage\t%s\t%s\n' "${urgency:-1}" "$at" "$seq" "$p" "${id:--}" "$(printf '%s' "$text" | cut -c1-$NOTE_TEXT_MAX)"
      done <<EOF
$(awk -v slug="$slug" -v now="$now" '
  function field(line, name,    v) {
    if (match(line, "\"" name "\":\"")) {
      v = substr(line, RSTART + length(name) + 4); sub(/".*/, "", v); return v
    }
    if (match(line, "\"" name "\":[0-9]+")) {
      v = substr(line, RSTART + length(name) + 3); sub(/[^0-9].*/, "", v); return v
    }
    return ""
  }
  {
    t = field($0, "type"); id = field($0, "id")
    # A message whose state has MOVED off queued/held has been dealt with —
    # delivered, refused, expired. The fold is last-state-wins over appended
    # delivery lines, exactly as the console folds it, so a boot prompt cannot
    # hand over the same note twice.
    if (t == "delivery") { state[id] = field($0, "state"); next }
    if (t == "ack")      { state[id] = "acked"; next }
    if (t != "message")  next
    n++; ids[n] = id
    froms[n] = field($0, "from"); tos[n] = field($0, "to")
    delivers[n] = field($0, "deliver"); prios[n] = field($0, "priority")
    texts[n] = field($0, "text"); ats[n] = field($0, "written_at"); exps[n] = field($0, "expires")
  }
  END {
    for (i = 1; i <= n; i++) {
      # `boot` alone waits for a phase. `now` and `next-turn` are addressed to a
      # SESSION, and a session that never started cannot have been meant.
      if (delivers[i] != "boot") continue
      st = (ids[i] in state) ? state[ids[i]] : "queued"
      if (st != "queued" && st != "held") continue
      if (exps[i] != "" && exps[i] <= now) continue
      to = tos[i]
      if (to == "all:") target = "all"
      else if (to == "next:") target = "next"
      else if (to == "phase:" slug "/" substr(to, index(to, "/") + 1)) target = substr(to, index(to, "/") + 1)
      else continue
      from = froms[i]
      writer = (index(from, "/") > 0) ? substr(from, index(from, "/") + 1) : ""
      if (writer !~ /^[0-9]+$/) writer = "-"
      urgency = (prios[i] == "high") ? 0 : 1
      printf "%s\t%s\t%s\t%s\t%s\t%s\n", writer, target, ats[i], ids[i], urgency, texts[i]
    }
  }
' "$ledger")
EOF
    fi
  fi
  return 0
}

# What phase N was handed, in the order it should read it:
#   source<TAB>kind<TAB>id<TAB>at<TAB>text
#
# Urgent mail first — a `high` message is the one thing here that can change
# what the session does in its first minute — then oldest to newest, because a
# note is a story and the ending is what you needed. The bound keeps the NEWEST
# `NOTES_MAX`: an old note that still mattered has been read by now, and the
# trailer names how many were left out rather than pretending there were none.
notes_for() {  # notes_for <phase>
  local rows total kept dropped tab
  tab="$(printf '\t')"
  rows="$(_notes_candidates "$1")"
  [ -n "$rows" ] || return 0
  total="$(printf '%s\n' "$rows" | grep -c . || true)"
  if [ "$total" -gt "$NOTES_MAX" ]; then
    dropped=$((total - NOTES_MAX))
    kept="$(printf '%s\n' "$rows" | LC_ALL=C sort -t"$tab" -k1,1 -k2,2r -k3,3nr | head -n "$NOTES_MAX")"
  else
    dropped=0
    kept="$rows"
  fi
  printf '%s\n' "$kept" | LC_ALL=C sort -t"$tab" -k1,1 -k2,2 -k3,3n \
    | awk -F'\t' '{ printf "%s\t%s\t%s\t%s\t%s\n", $4, $5, $6, $2, $7 }'
  [ "$dropped" -gt 0 ] && printf -- '-\ttrailer\t-\t-\t… and %s older notes, not shown\n' "$dropped"
  return 0
}

# THIS phase's QA regime — on | off | waived — the plan's word with the phase's
# own overriding it. File-independent: it is a statement of INTENT, which is what
# a boot prompt needs ("do you owe a verdict when you finish?") and is true
# before `test-status.md` exists at all.
qa_mode_for_phase() {  # qa_mode_for_phase <phase> -> on|off|waived
  case "$(qa_phase_directive "$1")" in
    on)  echo on;  return ;;
    off) echo off; return ;;
  esac
  case "$(qa_mode)" in
    on*)     echo on ;;
    waived*) echo waived ;;
    *)       echo off ;;
  esac
}

# Does a recorded verdict GATE this phase's dependents? That needs both the
# intent (above) and a table to read — the two are different questions, and
# conflating them is how a boot prompt stops naming the QA duty on the very
# phase that is about to create the table.
qa_gates_phase() {  # qa_gates_phase <phase>
  [ -f "$qa_status_file" ] || return 1
  [ "$(qa_mode_for_phase "$1")" = on ] || return 1
  return 0
}

_is_verified() {  # done + QA-passed (when gating on); honours the assume-done hook
  # The hook means "treat N as DONE", which is all its name claims and all
  # `--ready-after N` is asked. It used to short-circuit VERIFIED as well, so
  # under QA-on the answer was "what unblocks once N is done and QA has passed"
  # while every caller was asking "what unblocks once N is done" — and the gap
  # is a boot prompt written for a phase the board will refuse to start.
  # `_is_done` honours the hook on its own, so dropping it here is enough.
  _is_done "$1" || return 1
  qa_gates_phase "$1" || return 0
  case "$(qa_result "$1")" in pass|waived) return 0 ;; *) return 1 ;; esac
}

# ---- QA mode (v3: QA subagents are OPT-IN, off by default) -----------------
# Resolution order (first hit wins):
#   1. canonical "**QA gate:** off" in plan §Session budget → "waived …" (record
#      rows as waived, NEVER dispatch a QA subagent, and DO NOT GATE — see the
#      QA_GATING assignment below; a recorded fail stays recorded and visible,
#      it simply stops holding dependents)
#   2. canonical "**QA gate:** on"                          → "on …" (dispatch at finish)
#   3. legacy waiver prose (a "QA gate" line containing "waiv") → "waived …"
#   4. test-status.md already exists (legacy/back-compat)   → "on …"
#   5. none of the above                                    → "off" (no QA artifact)
# The canonical grep is line-anchored and bold-EXACT ("**QA gate:** on") so prose
# like "**QA gate: WAIVED for ALL phases** (user decision…" can never match "on".
session_budget_block() {
  _section 2 "session budget"
}
qa_mode() {
  local sb; sb="$(session_budget_block)"
  # A leading list marker is allowed, and so is a trailing note: the greps were
  # anchored to end-of-line, so `- **QA gate:** off` missed BOTH rules and fell
  # through to "test-status.md exists -> on" — handing the operator the OPPOSITE
  # of what they wrote, silently. A bullet is the natural thing to type now that
  # per-phase QA is one (`- **QA:** off`), so this is the shape to accept.
  #
  # Still anchored at the START of the line and still requiring the bold literal,
  # which is what keeps prose ("we considered turning the QA gate on") from ever
  # reading as a directive — the reason the anchoring existed in the first place.
  if printf '%s\n' "$sb" | grep -qiE '^[[:space:]>]*([-*][[:space:]]+)?\*\*QA gate:\*\*[[:space:]]*off([[:space:]]|$)'; then
    echo "waived (plan directive: QA gate: off)"; return
  fi
  if printf '%s\n' "$sb" | grep -qiE '^[[:space:]>]*([-*][[:space:]]+)?\*\*QA gate:\*\*[[:space:]]*on([[:space:]]|$)'; then
    echo "on (plan directive: QA gate: on)"; return
  fi
  if printf '%s\n' "$sb" | grep -i 'qa gate' | grep -qi 'waiv'; then
    echo "waived (plan waiver directive)"; return
  fi
  if [ -f "$qa_status_file" ]; then
    echo "on (test-status.md exists)"; return
  fi
  echo "off"
}

# Does QA GATE dependents on this plan? Gating needs BOTH a table to read and a
# directive that says to honour it.
#
# This used to be `[ -f "$qa_status_file" ] && QA_GATING=1`, with `qa_mode`
# never consulted — so "**QA gate:** off" turned off dispatch but not gating,
# and a plan whose phase 1 had a recorded `fail` could not be released by ANY
# plan-, run- or console-level setting. The only exit was hand-editing the
# table. Measured on a real plan: two finished phases (one `fail`, one
# `pending`) held six phases for ever, and turning QA off changed nothing.
#
# `waived` now means what it says. The verdicts stay in the table and every
# surface still reports them; they stop being a wall. `fail` under `on` gates
# exactly as before — the release is opt-in, per plan, in writing.
case "$(qa_mode)" in
  waived*) QA_GATING=0 ;;
  *)       [ -f "$qa_status_file" ] && QA_GATING=1 ;;
esac

# Dependencies of <phase> not yet satisfied: not done, or — with QA gating on —
# done but not yet QA-verified. Space-separated, may be empty.
missing_deps() {  # missing_deps <phase>
  local d out=""
  for d in ${DEPS[$1]:-}; do
    _is_verified "$d" || out="$out $d"
  done
  echo "${out# }"
}

# WHY a dependency is unmet — the fact the runner never had. An empty `ready`
# set is four different situations (finished · all in flight · closed · nothing
# can ever move), and the console could not tell them apart because
# `--memory-block` emitted buckets and no reasons. A phase that is DONE but
# whose QA verdict is not pass|waived is the dangerous one: it looks settled on
# the board and holds its whole downstream cone for ever.
dep_block_reason() {  # dep_block_reason <dep> -> not-done | qa:<verdict>
  _is_done "$1" || { echo "not-done"; return; }
  # Only a phase QA actually gates can be blocked BY qa; a QA-off phase that is
  # done is simply done, whatever verdict happens to sit in the table.
  qa_gates_phase "$1" && { echo "qa:$(qa_result "$1")"; return; }
  echo "not-done"
}

# `missing_deps`, with the QA-held ones marked so `needs: 1` cannot sit two
# lines under `done  1` reading like a contradiction.
missing_deps_annotated() {  # missing_deps_annotated <phase>
  local d out=""
  for d in ${DEPS[$1]:-}; do
    _is_verified "$d" && continue
    case "$(dep_block_reason "$d")" in
      qa:*) out="$out $d(QA)" ;;
      *)    out="$out $d" ;;
    esac
  done
  echo "${out# }"
}

# The `blocked:` line: every waiting phase, its unmet deps, and why each is
# unmet. Emitted only when something is actually waiting, so the common case
# costs nothing and old parsers see no new line.
blocked_pairs() {
  local p d out="" deps
  for p in "${PHASES[@]}"; do
    [ "$(phase_state "$p")" = waiting ] || continue
    deps=""
    for d in ${DEPS[$p]:-}; do
      _is_verified "$d" && continue
      deps="$deps,$d($(dep_block_reason "$d"))"
    done
    [ -n "$deps" ] && out="$out $p<-${deps#,}"
  done
  echo "${out# }"
}

# F19: an open plan that cannot progress — nothing ready, nothing in flight, and
# every remaining phase held by a dependency. ADVISORY, same arm as F14-F18
# (stderr, exit untouched). Born from a measured wedge: two phases finished, one
# QA verdict `fail` and one still `pending`, six phases held for ever, and every
# console surface said only "waiting on a gate or an earlier phase".
deadlock_advisories() {
  local p held="" any_open=0 reason
  for p in "${PHASES[@]}"; do
    case "$(phase_state "$p")" in
      done)              : ;;
      ready|in-progress) return 0 ;;
      *)                 any_open=1 ;;
    esac
  done
  [ "$any_open" = 1 ] || return 0
  # Only QA-held and stuck deps make a plan UNABLE to move; a plan whose roots
  # are merely unstarted is not deadlocked, it is unstarted.
  for p in "${PHASES[@]}"; do
    [ "$(phase_state "$p")" = waiting ] || continue
    for d in ${DEPS[$p]:-}; do
      _is_verified "$d" && continue
      reason="$(dep_block_reason "$d")"
      case "$reason" in qa:*) held="$held $d(${reason})" ;; esac
    done
  done
  [ -n "$held" ] || return 0
  printf 'F19 plan: this plan cannot progress — nothing is ready and nothing is in flight; %s hold every remaining phase. Re-run QA or record pass/waived (scripts/qa-record.sh), or set "**QA gate:** off" in §Session budget\n' \
    "$(echo "${held# }" | tr ' ' '\n' | sort -u | tr '\n' ' ' | sed 's/ $//')"
}

# Compute a phase's runtime state (pure — no globals, safe across $(…) subshells).
# done|in-progress|stuck|ready|waiting
phase_state() {  # phase_state <phase>
  local p="$1" st="${STATUS[$1]:-not-started}"
  if _is_done "$p"; then echo "done"; return; fi
  [ "$st" = in-progress ] && { echo in-progress; return; }
  [ "$st" = stuck ] && { echo stuck; return; }
  [ -z "$(missing_deps "$p")" ] && echo ready || echo waiting
}

# ---------------------------------------------------------------------------
# Batch grouping: which SEQUENTIAL phases can share one session.
# Concurrency is orthogonal — independent ready phases fan out to separate
# sessions; only phases on the same dependency chain are ever batched.
# ---------------------------------------------------------------------------
HAVE_SIZES=0
# Same tightened bullet match as phase_size — the two must agree, or the banner
# announces batches computed from sizes nothing actually read.
grep -qiE '^[[:space:]]*[-*][[:space:]]*\*{0,2}Size\*{0,2}[[:space:]]*:' "$plan_file" 2>/dev/null && HAVE_SIZES=1

_in_list() {  # _in_list <needle> <space-list>
  case " ${2} " in *" ${1} "*) return 0 ;; *) return 1 ;; esac
}
_deps_subset_of() {  # every dep of <phase> is in <set>
  local d
  for d in ${DEPS[$1]:-}; do _in_list "$d" "$2" || return 1; done
  return 0
}
_deps_intersect() {  # at least one dep of <phase> is in <set>
  local d
  for d in ${DEPS[$1]:-}; do _in_list "$d" "$2" && return 0; done
  return 1
}
_size_weight() {  # token estimate for S|M|L — values from sizing.env (F5)
  case "$1" in S) echo "$SIZE_S" ;; L) echo "$SIZE_L" ;; *) echo "$SIZE_M" ;; esac
}
# What this phase's MCP servers cost its working set — values from mcp.env (F5).
# Capped, because tool search defers the schemas and the tenth server costs far
# less than the first. A phase with no servers pays nothing.
_mcp_surcharge() {  # _mcp_surcharge <phase>
  local n
  n="$(mcp_for_phase "$1" | tr ',' '\n' | sed '/^[[:space:]]*$/d' | grep -c . || true)"
  [ "${n:-0}" -eq 0 ] && { echo 0; return; }
  n=$((n * MCP_SURCHARGE))
  [ "$n" -gt "$MCP_SURCHARGE_MAX" ] && n="$MCP_SURCHARGE_MAX"
  echo "$n"
}
# The number batching actually spends: the phase's size plus what its servers add.
_phase_weight() {  # _phase_weight <phase>
  echo $(( $(_size_weight "${SIZE[$1]:-M}") + $(_mcp_surcharge "$1") ))
}
resolve_budget() {  # model alias OR raw token number → per-session budget (F5)
  local a; a="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [ -z "$a" ] && { echo "$BUDGET_DEFAULT"; return; }
  case "$a" in
    *[!0-9]*) : ;;                 # has a non-digit → treat as a model alias below
    *)        echo "$a"; return ;; # all digits → use verbatim
  esac
  # The window suffix wins over the family: it selects a context window, and
  # the budget is a function of the window alone. Quoted so bash 3.2 reads the
  # brackets literally instead of as a character class.
  case "$a" in
    *"$MODEL_1M_SUFFIX"*) echo "$BUDGET_1M"; return ;;
  esac
  local m
  for m in $MODEL_BIG; do
    case "$a" in *"$m"*) echo "$BUDGET_BIG"; return ;; esac
  done
  case "$a" in
    *haiku*) echo "$BUDGET_HAIKU" ;;
    *)       echo "$BUDGET_DEFAULT" ;;
  esac
}
# Greedy grouping over the REMAINING (not done / not in-flight) phases in table
# order — v3: the old tip-dependency and fan-out≤1 rules are gone. Parallel-safe
# siblings and L phases batch like anything else (execution inside a session is
# serial); only these cut a session:
#   • an unmet dependency (deps must all be in done_before or in the group),
#   • a GATED phase (external gates never get batched past — always its own
#     session, and nothing joins after it),
#   • QA gating (when on, a phase never shares a session with a dependency —
#     the dep's verdict must be recorded before the dependent starts),
#   • the summed weight exceeding the budget.
# done_before is seeded from the LIVE done-set so mid-plan suggestions are real;
# in-progress/stuck phases are excluded (they're already being handled).
# A phase may START a group only when its deps are all in done_before; otherwise
# it opens a SEALED solo group (nothing may join it — prevents ordering
# inversions when the table lists a phase before its own dependency) and is then
# treated as done so downstream grouping can continue.
# Echoes "p p|p|p p" (groups by |) — pure phase numbers; flags are computed by
# the printers.
compute_groups() {  # compute_groups <budget>
  local budget="$1" done_before=" " cur="" cur_w=0 cur_sealed=0 out="" p w st
  for p in "${PHASES[@]}"; do
    st="${STATUS[$p]:-not-started}"
    if [ "$st" = "done" ]; then done_before="${done_before}${p} "; continue; fi
    if [ "$st" = in-progress ] || [ "$st" = stuck ]; then continue; fi
    w="$(_phase_weight "$p")"
    if [ -n "$cur" ] \
       && [ "$cur_sealed" = 0 ] \
       && [ "${GATED[$p]:-no}" != yes ] \
       && _deps_subset_of "$p" "${done_before}${cur} " \
       && { [ "$QA_GATING" = 0 ] || ! _deps_intersect "$p" " ${cur} "; } \
       && [ $((cur_w + w)) -le "$budget" ]; then
      cur="$cur $p"; cur_w=$((cur_w + w))
    else
      if [ -n "$cur" ]; then out="${out}${out:+|}${cur}"; done_before="${done_before}${cur} "; fi
      cur="$p"; cur_w="$w"; cur_sealed=0
      [ "${GATED[$p]:-no}" = yes ] && cur_sealed=1
      _deps_subset_of "$p" "$done_before" || cur_sealed=1
    fi
  done
  [ -n "$cur" ] && out="${out}${out:+|}${cur}"
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Machine sub-commands.
# ---------------------------------------------------------------------------
case "$mode" in
  --plan-status)
    # The stored operator decision, normalised. Always one bare word.
    printf '%s\n' "$PLAN_STATUS"
    exit 0
    ;;
  --closed)
    # The predicate every other script shells out to, so closure is read in exactly
    # one place. 0 = closed, 1 = open.
    if plan_is_closed; then printf 'closed %s\n' "$PLAN_STATUS"; exit 0; fi
    printf 'open %s\n' "$PLAN_STATUS"; exit 1
    ;;
  --lint)
    # F1/F2/F3: structural validation. Exit non-zero on any problem.
    issues="$(compute_issues)"
    declared="$(grep -m1 '^phases:' "$plan_file" | sed 's/^phases:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
    if [ -n "$declared" ] && [ "$declared" != TODO ] && [ "$declared" != "${#PHASES[@]}" ]; then
      issues="${issues}"$'\n'"phase count mismatch: frontmatter says ${declared} but the table parses ${#PHASES[@]} rows"
    fi
    issues="$(printf '%s' "$issues" | sed '/^[[:space:]]*$/d')"
    # F15–F19 and F22/F23 advisories ride stderr beside the issues but never
    # gate the exit — a closed plan is not even scanned (nothing to board there).
    if ! plan_is_closed; then
      advisories="$(verification_unbounded_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(mcp_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(credential_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(verification_lead_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(verification_cwd_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(verification_setup_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(verification_expected_failure_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(deadlock_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(land_needs_lane_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
      advisories="$(note_done_advisories)"
      [ -n "$advisories" ] && printf '%s\n' "$advisories" >&2
    fi
    if [ -n "$issues" ]; then
      # A closed plan still gets its problems named — they just stop being a gate.
      # Nobody should have to repair a plan they have already walked away from.
      if plan_is_closed; then
        printf '%s\n' "$issues" >&2
        printf 'LINT OK (closed): %s — %s issue[s] noted, not gating\n' "$slug" "$(printf '%s\n' "$issues" | grep -c .)"
        exit 0
      fi
      printf '%s\n' "$issues" >&2
      printf 'LINT FAIL: %s (%s issue[s])\n' "$slug" "$(printf '%s\n' "$issues" | grep -c .)" >&2
      exit 1
    fi
    if plan_is_closed; then
      printf 'LINT OK (closed): %s — %s phases, well-formed and acyclic\n' "$slug" "${#PHASES[@]}"
      exit 0
    fi
    printf 'LINT OK: %s — %s phases, well-formed and acyclic\n' "$slug" "${#PHASES[@]}"
    exit 0
    ;;
  --setup)
    # The phase's bring-up commands, one per line, in the order they run:
    # the plan-wide `**Setup (every phase):**` line, then the phase's own
    # `- **Setup:**` bullet. Empty when the plan declares none. These run
    # BEFORE §Verification with `check:false` — they can never colour a phase
    # red, which is the whole reason the bullet exists.
    [ -z "$arg" ] && { printf 'usage: --setup <phase>\n' >&2; exit 2; }
    setup_for_phase "$arg"
    exit 0
    ;;
  --mcp)
    # Which MCP servers a phase runs with, as the console's preflight reads it.
    # With no argument: the plan-wide line alone. With one: that phase's full set
    # (plan line ∪ its own bullet). Always a csv, empty when the plan names none.
    if [ -n "$arg" ]; then mcp_for_phase "$arg"; else printf '%s' "$(plan_mcp)"; fi
    printf '\n'
    exit 0
    ;;
  --checkout)
    # The phase's `- **Checkout:** <branch>` bullet, verbatim and empty when it
    # has none. The console reads `main`/`master`/`default` as "detach at the
    # default branch"; every other value is documentation.
    [ -n "$arg" ] && checkout_directive "$arg"
    printf '\n'
    exit 0
    ;;
  --mcp-policy)
    # What the PLAN says to do when one of those servers will not connect.
    # With no argument: the §Session budget line alone. With one: that phase's
    # answer (its own bullet, else the plan's). Empty means the plan has no
    # opinion, which the console reads as "the run's setting decides" — NOT as
    # `continue`, because those two are different facts.
    if [ -n "$arg" ]; then mcp_policy_for_phase "$arg"; else printf '%s' "$(plan_mcp_policy)"; fi
    printf '\n'
    exit 0
    ;;
  --credentials)
    # Which credential ids a phase needs, as phase 11's prelude probes them.
    # With no argument: the plan-wide line alone. With one: plan line ∪ the
    # phase's own bullet. Always a csv, empty when the plan names none.
    if [ -n "$arg" ]; then credentials_for_phase "$arg"; else printf '%s' "$(plan_credentials)"; fi
    printf '\n'
    exit 0
    ;;
  --credential-policy)
    # What the PLAN says when a named credential is not held: `require` (refuse
    # at boarding) or `continue` (run, report the gap); empty is silence.
    if [ -n "$arg" ]; then credential_policy_for_phase "$arg"; else printf '%s' "$(plan_credential_policy)"; fi
    printf '\n'
    exit 0
    ;;
  --accounts)
    # The `**Accounts:**` line: id<TAB>minHeadroom per line, min empty when the
    # pair carries none. Nothing when the plan names no accounts.
    plan_accounts
    exit 0
    ;;
  --qa-exhausted)
    # The plan's answer once the QA round budget is spent: waive | halt | <owner>;
    # empty is silence (the console's policy table answers).
    plan_qa_exhausted
    printf '\n'
    exit 0
    ;;
  --person-check)
    # A phase's answer for a §Verification fragment written as prose: allow |
    # halt | <owner>; empty is silence. Phase-only — there is no plan-wide line.
    [ -n "$arg" ] || { echo "usage: phase-graph.sh <slug> --person-check N" >&2; exit 2; }
    person_check_for_phase "$arg"
    printf '\n'
    exit 0
    ;;
  --wait-budget)
    # How long a phase may stay parked on its declared waits, and which line said
    # so: the phase's `Waits on:` max, else the plan's `Wait budget:`. Nothing is
    # silence — the console's default then applies, and it is the console's to say.
    if [ -n "$arg" ]; then
      case " ${PHASES[*]} " in *" $arg "*) ;; *) printf 'phase %s is not in this plan\n' "$arg" >&2; exit 2 ;; esac
      wait_budget_for_phase "$arg"
    else
      wb="$(plan_wait_budget)"
      [ -n "$wb" ] && printf '%s\tplan\n' "$wb"
    fi
    exit 0
    ;;
  --waits-on)
    # What phase N's own bullet says it waits on — the refs, one per line. The
    # console reads a `date:` among them as the plan countersigning that wait.
    [ -n "$arg" ] || { printf 'usage: phase-graph.sh <slug> --waits-on N\n' >&2; exit 2; }
    case " ${PHASES[*]} " in *" $arg "*) ;; *) printf 'phase %s is not in this plan\n' "$arg" >&2; exit 2 ;; esac
    waits_on_refs "$arg"
    exit 0
    ;;
  --land|--gitlink|--isolation|--issues|--conflict-policy|--messaging|--base-branch)
    # Where a phase's work happens and where it lands (5.1.0). Every arm here
    # answers `value<TAB>phase|plan|default` — the source token is the point,
    # since these words have engine-owned defaults and "this plan chose hold"
    # must not read the same as "this plan never considered landing".
    #
    # `--land`, `--gitlink`, `--isolation` and `--issues` take a phase; the
    # other three are plan-wide and refuse one, because a per-phase base branch
    # or conflict policy is a fact about the RUN that a phase cannot hold.
    # `--isolation` alone can answer NOTHING: a phase that says nothing
    # inherits the run, and the run is not in the plan.
    case "$mode" in
      --land|--gitlink|--isolation|--issues)
        if [ -n "$arg" ]; then
          case " ${PHASES[*]} " in *" $arg "*) ;; *) printf 'phase %s is not in this plan\n' "$arg" >&2; exit 2 ;; esac
        fi ;;
      *)
        [ -z "$arg" ] || { printf 'usage: phase-graph.sh <slug> %s   (plan-wide; it takes no phase)\n' "$mode" >&2; exit 2; } ;;
    esac
    case "$mode" in
      --land)            land_for_phase "$arg" ;;
      --gitlink)         gitlink_for_phase "$arg" ;;
      --isolation)       isolation_for_phase "$arg" ;;
      --issues)          issues_for_phase "$arg" ;;
      --conflict-policy) plan_conflict_policy ;;
      --messaging)       plan_messaging ;;
      --base-branch)     plan_base_branch ;;
    esac
    exit 0
    ;;
  --clash-zones)
    # The paths two concurrent phases must never both touch, as a csv. No
    # source token: an empty list and a plan that never named one are the same
    # instruction to everything that reads it.
    plan_clash_zones
    printf '\n'
    exit 0
    ;;
  --landing)
    # The landing LEDGER, not the policy — what actually happened, as
    # phase-landing.sh recorded it. One TSV row per record, columns in
    # LANDING_COLUMNS order; nothing at all when the phase has no record,
    # which is the fact the `landed` gate blocks on.
    [ -n "$arg" ] || { printf 'usage: phase-graph.sh <slug> --landing N\n' >&2; exit 2; }
    case " ${PHASES[*]} " in *" $arg "*) ;; *) printf 'phase %s is not in this plan\n' "$arg" >&2; exit 2 ;; esac
    landing_rows "$arg"
    exit 0
    ;;
  --notes)
    # What phase N is handed by the phases before it, from all three sources:
    # `source<TAB>kind<TAB>id<TAB>at<TAB>text` per line, urgent first and then
    # oldest to newest, bounded by NOTES_MAX with a `trailer` row naming what
    # was dropped. Nothing at all when nobody left anything — which is not an
    # error and not a blank line.
    [ -n "$arg" ] || { printf 'usage: phase-graph.sh <slug> --notes N\n' >&2; exit 2; }
    case " ${PHASES[*]} " in *" $arg "*) ;; *) printf 'phase %s is not in this plan\n' "$arg" >&2; exit 2 ;; esac
    notes_for "$arg"
    exit 0
    ;;
  --decisions)
    # The decision manifest as it holds — for the plan, or for phase N (its
    # own rows over the plan-wide ones). One row per line, TSV, rows that
    # EXIST only: a plan with no `## Decisions` prints nothing.
    if [ -n "$arg" ]; then
      case " ${PHASES[*]} " in *" $arg "*) ;; *) printf 'phase %s is not in this plan\n' "$arg" >&2; exit 2 ;; esac
    fi
    decisions_rows "${arg:-}"
    exit 0
    ;;
  --ready|--ready-after)
    # A closed plan offers no work: nothing is ready, so nothing gets started or
    # batched and no boot prompt is ever generated for it.
    plan_is_closed && { echo ""; exit 0; }
    # --ready-after N already set assume_done=arg above (arg is the 3rd positional).
    out=""
    for p in "${PHASES[@]}"; do
      [ "$p" = "$assume_done" ] && continue
      [ "$(phase_state "$p")" = ready ] && out="$out $p"
    done
    echo "${out# }"
    exit 0
    ;;
  --dependents)
    [ -z "$arg" ] && { echo "usage: --dependents <phase>" >&2; exit 2; }
    out=""
    for p in "${PHASES[@]}"; do
      for d in ${DEPS[$p]}; do
        [ "$d" = "$arg" ] && out="$out $p"
      done
    done
    echo "${out# }"
    exit 0
    ;;
  --deps)
    [ -z "$arg" ] && { echo "usage: --deps <phase>" >&2; exit 2; }
    echo "${DEPS[$arg]:-}"
    exit 0
    ;;
  --gated)
    [ -z "$arg" ] && { echo "usage: --gated <phase>" >&2; exit 2; }
    echo "${GATED[$arg]:-no}"
    exit 0
    ;;
  --gate-kind)
    # The gate's category: human (a person must act) | ai (an AI session may
    # verify/do/clear it — a person may still approve) | auto (the engine
    # evaluates it by itself) | none (not gated).
    [ -z "$arg" ] && { echo "usage: --gate-kind <phase>" >&2; exit 2; }
    gate_kind "$arg"
    exit 0
    ;;
  --repos)
    # The phase's SCOPE: what it touches, from the plan's Repos column, as the
    # csv `phase-lock.sh --scope` and `conflicts` speak. Never empty — an
    # undeclared phase reads as `all`, which collides with everything.
    [ -z "$arg" ] && { echo "usage: --repos <phase>" >&2; exit 2; }
    echo "${REPOS[$arg]:-all}"
    exit 0
    ;;
  --qa-result)
    [ -z "$arg" ] && { echo "usage: --qa-result <phase>" >&2; exit 2; }
    qa_result "$arg"
    exit 0
    ;;
  --qa-history)
    # Every round on file for a phase, oldest first, tab-separated:
    #   round <TAB> result <TAB> report <TAB> recorded
    # Empty output means no review has ever been recorded — which is a different
    # fact from `--qa-result` answering `none`, since that also answers `none`
    # for a plan with no `test-status.md` at all.
    [ -z "$arg" ] && { echo "usage: --qa-history <phase>" >&2; exit 2; }
    case "$arg" in ''|*[!0-9]*) echo "usage: --qa-history <phase>" >&2; exit 2 ;; esac
    qa_history "$((10#$arg))"
    exit 0
    ;;
  --qa-mode)
    # "waived <reason>" | "on <reason>" | "off" — whether phase-finish dispatches
    # a QA subagent (on), records waived rows without dispatching (waived), or
    # skips the QA artifact entirely (off, the default).
    #
    # With a phase number, the answer is that PHASE's regime: its own
    # `- **QA:** on|off` bullet where it has one, the plan's word otherwise. The
    # reason says which, because "why is this phase not being reviewed" is the
    # question an operator actually asks.
    if [ -n "$arg" ]; then
      case "$arg" in ''|*[!0-9]*) echo "usage: --qa-mode [<phase>]" >&2; exit 2 ;; esac
      case "$(qa_phase_directive "$arg")" in
        on)  echo "on (phase directive: QA: on)" ;;
        off) echo "off (phase directive: QA: off)" ;;
        *)   qa_mode ;;
      esac
      exit 0
    fi
    qa_mode
    exit 0
    ;;
  --qa-prompt)
    # Fresh-context QA-subagent brief for a just-finished phase (QA-on plans only —
    # QA is opt-in since v3; check --qa-mode first). The phase-finish step dispatches
    # THIS as an Agent subagent (clean context = independent review) — it is NOT a
    # separate user-invoked skill. Paths resolve via $SCRIPT_DIR / the skill root so the
    # brief is correct from any account/clone (F13).
    [ -z "$arg" ] && { echo "usage: --qa-prompt <phase>" >&2; exit 2; }
    p="$arg"; pad="$(printf '%02d' "$((10#$p))")"
    skill_root="$(cd "$SCRIPT_DIR/.." && pwd)"
    hf="$(handoff_file "$pad")"
    [ -n "$hf" ] && hf_rel="docs/handoffs/${slug}/$(basename "$hf")" || hf_rel="docs/handoffs/${slug}/phase-${pad}-*.md"
    printf 'You are an INDEPENDENT QA reviewer with a FRESH context. Verify Phase %s of "%s" before\n' "$p" "$slug"
    printf 'its dependents start. Do NOT trust the handoff'\''s claims — establish ground truth yourself\n'
    printf 'from the plan + the real diff.\n\n'
    # Which round is this? The brief must name a report file that does not
    # already exist: the round convention was invented by the sessions and
    # enforced by nothing, so a second reviewer told to write `phase-NN-qa.md`
    # silently destroyed the first one's report (issue #7). Now the engine hands
    # out the name, and `qa-record.sh --round` records which round produced the
    # verdict. Announced BEFORE the steps, because "you are the third reviewer
    # of this phase and here is what the first two said" changes how the review
    # is read, not merely where its file lands.
    _next="$(qa_next_round "$p")"
    qa_round="${_next%%	*}"; qa_report="${_next#*	}"
    if [ "$qa_round" -gt 1 ]; then
      printf 'This is QA ROUND %s for this phase. Earlier rounds — read them before you start, then\n' "$qa_round"
      printf 'judge the CURRENT diff yourself; an earlier verdict is evidence, never a conclusion:\n'
      qa_history "$((10#$p))" | while IFS="$(printf '\t')" read -r _r _v _rep _d; do
        printf -- '  round %s: %s — docs/handoffs/%s/%s\n' "$_r" "$_v" "$slug" "$_rep"
      done
      printf '\n'
    fi
    sk="$(plan_skills)"
    [ -n "$sk" ] && printf 'First invoke these skills (the plan uses them for every session): %s\n\n' "$sk"
    mc="$(mcp_for_phase "$p")"
    [ -n "$mc" ] && printf 'The phase ran with these MCP servers: %s — you may use them to establish ground\ntruth, but never take a server'\''s word for whether the work is correct.\n\n' "$mc"
    # The plan's own review rules, before the steps and before the verdict verb:
    # a constraint the reviewer meets after copying the record line has already
    # lost. Verbatim, because the engine has no standing to summarise what a
    # plan demands of its reviewers. See plan_qa_contract().
    qc="$(plan_qa_contract)"
    if [ -n "$qc" ]; then
      printf 'THE PLAN STATES ITS OWN QA CONTRACT, and it OVERRIDES the generic steps below wherever\n'
      printf 'the two differ — including which verdicts you may record. Read it first, follow it, and\n'
      printf 'if it forbids a verdict, do not record that verdict even though step 4 lists it:\n\n'
      printf '%s\n\n' "$qc"
    fi
    printf -- '1. `git pull`. Read docs/plans/%s.md §Phase %s — goal, exit criteria, Verification.\n' "$slug" "$p"
    printf -- '2. Read the handoff %s (its claims + key_files), then read ALL code the phase changed\n' "$hf_rel"
    printf '   COLD: `git diff` of its commits + every key_files path, in full.\n'
    printf -- '3. Investigate for gaps/bugs/regressions/security per %s/references/qa-method.md —\n' "$skill_root"
    printf '   a real review, not just tests. Run and extend tests to cover every exit criterion.\n'
    printf -- '4. Write the report from %s/assets/report-template.md to\n' "$skill_root"
    printf -- '   docs/handoffs/%s/%s, then record the verdict:\n' "$slug" "$qa_report"
    printf '     %s/qa-record.sh %s %s <pass|fail|waived> --report %s --round %s\n' "$CMD" "$slug" "$p" "$qa_report" "$qa_round"
    printf -- '5. Commit + push the report + test-status.md, then return the verdict + findings\n'
    printf '   (dependents unblock only once pass|waived; a fail must be pushed to gate them).\n'
    exit 0
    ;;
  --gate-status)
    # F12: evaluate a phase's gate. Exit 0 = clear, 1 = every other verdict —
    # `blocked:` (an auto check not met yet), `manual:` (a person must act),
    # `ai:` (a session must verify and record), `OVERDUE:` (a deadline passed)
    # and `unevaluated:` (a `cmd` gate this caller did not run; see _gate_cmd).
    # A non-zero exit is "not clear", never "somebody is needed" — the WORD says
    # which, and `unevaluated` is the one that means nobody has to do anything.
    [ -z "$arg" ] && { echo "usage: --gate-status <phase>" >&2; exit 2; }
    gc="$(gate_check_directive "$arg")"
    # A recorded approval clears ANY gate kind — the operator's override from
    # the console's Gate card, or an AI session's recorded clearance. Checked
    # only for phases that actually carry a gate, so an ungated phase still
    # answers "clear (no gate)".
    if [ -n "$gc" ] || [ "$(is_gated "$arg")" = yes ]; then
      ga="$(gate_approved "$arg")"
      case "$ga" in
        yes*)
          ga_by="$(printf '%s\n' "$ga" | cut -f2)"
          ga_on="$(printf '%s\n' "$ga" | cut -f3)"
          printf 'clear (approved by %s on %s)\n' "${ga_by:-someone}" "${ga_on:-an unrecorded date}"
          exit 0 ;;
      esac
    fi
    if [ -z "$gc" ]; then
      # A gated heading with no directive reads as GATE_DEFAULT (`ai`), the
      # same answer --gate-kind gives; --lint has already named it (F24).
      if [ "$(is_gated "$arg")" = yes ]; then gc="$GATE_DEFAULT"; else echo "clear (no gate)"; exit 0; fi
    fi
    gtype="${gc%% *}"; gval="${gc#"$gtype"}"; gval="${gval# }"
    case "$gtype" in
      phase)
        if _is_verified "$gval"; then echo "clear (phase $gval verified)"; exit 0
        else echo "blocked: waiting on phase $gval"; exit 1; fi ;;
      phases)
        # Several phases of THIS plan, comma- or space-separated. One `phase`
        # gate could not express "6,7,8,9,11,13,16,17,18", so plans wrote that
        # as prose and lost the automation.
        missing=""
        for q in $(printf '%s' "$gval" | tr ',' ' '); do
          case "$q" in ''|*[!0-9]*) continue ;; esac
          _is_verified "$q" || missing="$missing $q"
        done
        if [ -z "$missing" ]; then echo "clear (phases $gval verified)"; exit 0
        else echo "blocked: waiting on phase(s)$missing"; exit 1; fi ;;
      plan)
        # Cross-plan: "<slug>:<phases>". Plans really do gate on each other and
        # the graph had no way to say so.
        if _gate_plan "$gval"; then exit 0; else exit 1; fi ;;
      cmd)
        # A fact about the world, asserted by a command. See _gate_cmd — off
        # unless PHASE_EXEC_GATES=1.
        if _gate_cmd "$gval"; then exit 0; else exit 1; fi ;;
      landed|pr-merged)
        # Has phase N's work actually moved? Read from the landing ledger and
        # from nothing else — no network, no `gh`, so it answers identically
        # for a page view, a session and the autopilot.
        if _gate_landed "$gtype" "$gval"; then exit 0; else exit 1; fi ;;
      date)
        _valid_date "$gval" || { echo "manual: not a valid date: $gval"; exit 1; }
        today="$(date +%F)"; ti="${today//-/}"; gi="${gval//-/}"
        if [ "$ti" -ge "$gi" ]; then echo "clear (date $gval reached)"; exit 0
        else echo "blocked: opens on $gval (today $today)"; exit 1; fi ;;
      deadline|by)
        _valid_date "$gval" || { echo "manual: not a valid date: $gval"; exit 1; }
        today="$(date +%F)"; ti="${today//-/}"; gi="${gval//-/}"
        if [ "$ti" -gt "$gi" ]; then echo "OVERDUE: deadline $gval passed (today $today)"; exit 1
        else echo "clear (before deadline $gval)"; exit 0; fi ;;
      ai)
        # AI-clearable: unapproved means "a session must verify these
        # conditions, do the work to make them true, and record the clearance
        # via gate-approve.sh". The boot prompt carries the full duty.
        echo "ai: ${gval:-$(gate_conditions_line "$arg")}"; exit 1 ;;
      manual) echo "manual: $gval"; exit 1 ;;
      *)      echo "manual: $gc"; exit 1 ;;
    esac
    ;;
  --verified)
    # The phases that are DONE **and** QA-verified, space-separated — the set a
    # dependent may safely build on.
    #
    # `done` and `verified` are the same question only while QA is off, and a
    # cross-plan gate was asking the easy one: a phase whose verdict is `fail`
    # has a `complete` handoff, so it is `done` on the board, and it is exactly
    # the phase another plan must not gate through (S8-a). `_is_verified` already
    # knew the difference; nothing had ever asked it across a plan boundary,
    # because there was no arm to ask through.
    #
    # Same shape as `--memory-block`'s `done:` value, so `_gate_plan` reads
    # either with the same two lines.
    vf=""
    for p in "${PHASES[@]}"; do
      _is_verified "$p" && vf="$vf $p"
    done
    printf '%s\n' "${vf# }"
    exit 0 ;;
  --memory-block)
    # F9: canonical phase-status block for the project_<slug> memory (no drift).
    md_d=""; md_ip=""; md_st=""; md_rd=""; md_wt=""
    for p in "${PHASES[@]}"; do
      st="$(phase_state "$p")"
      # NOT gated on closure, deliberately — engine-12 asked for that and it is
      # wrong. `--ready` answers "what may I start now", and a closed plan starts
      # nothing. This arm answers a different question: what IS the state of each
      # phase, for the plan's own board and for the memory block. A plan someone
      # walked away from must still be able to say what it never got to, and the
      # `closed:` line above is how a reader tells the two apart. Emptying the
      # bucket instead would turn every client-side closure gate — the departures
      # board, the ready chips, the nav badge, the boot-prompt cards — into
      # unjustifiable dead code, and it is pinned by
      # `viewer/test/plan-closure.test.ts` with that reasoning written out.
      case "$st" in
        done)        md_d="$md_d $p" ;;
        in-progress) md_ip="$md_ip $p" ;;
        stuck)       md_st="$md_st $p" ;;
        ready)       md_rd="$md_rd $p" ;;
        waiting)     md_wt="$md_wt $p" ;;
      esac
    done
    _csv() { echo "${1# }" | sed 's/ /, /g'; }
    if plan_is_closed; then
      printf 'closed: %s' "$PLAN_STATUS"
      [ -n "$PLAN_CLOSED_ON" ] && printf ' %s' "$PLAN_CLOSED_ON"
      [ -n "$PLAN_CLOSED_REASON" ] && printf ' — %s' "$PLAN_CLOSED_REASON"
      printf '\n'
    fi
    printf 'done: %s\n' "$(_csv "$md_d")"
    [ -n "$md_ip" ] && printf 'in-progress: %s\n' "$(_csv "$md_ip")"
    [ -n "$md_st" ] && printf 'stuck: %s\n' "$(_csv "$md_st")"
    printf 'ready: %s\n' "$(_csv "$md_rd")"
    printf 'waiting: %s\n' "$(_csv "$md_wt")"
    # WHY the waiting phases wait. Emitted only when something waits, so the
    # line is additive: `readMemoryBlock` ignores lines it does not know, and a
    # plan with nothing waiting looks exactly as it did.
    md_bl="$(blocked_pairs)"
    [ -n "$md_bl" ] && printf 'blocked: %s\n' "$md_bl"
    exit 0
    ;;
  --size)
    [ -z "$arg" ] && { echo "usage: --size <phase>" >&2; exit 2; }
    echo "${SIZE[$arg]:-M}"
    exit 0
    ;;
  --session-plan)
    if plan_is_closed; then
      printf '\nSession plan — %s\n\n' "$slug"
      closed_banner
      printf '\nNo sessions to plan.\n'
      exit 0
    fi
    budget="$(resolve_budget "$arg")"
    printf '\nSession plan — %s   (budget ~%sK/session · S=%sK M=%sK L=%sK)\n' "$slug" "$((budget / 1000))" "$((SIZE_S / 1000))" "$((SIZE_M / 1000))" "$((SIZE_L / 1000))"
    printf 'Suggestion only: remaining phases share a session while deps are met and weight fits;\n'
    printf 'GATED phases, QA boundaries, and the budget cut. Confirm against your live context meter.\n'
    [ "$HAVE_SIZES" = 1 ] || printf '(no "Size:" tags found — every phase treated as M; add them for sharper batches)\n'
    printf '\n'
    live_done=""
    for q in "${PHASES[@]}"; do [ "${STATUS[$q]:-}" = "done" ] && live_done="$live_done $q"; done
    [ -n "$live_done" ] && printf '  (already done, excluded:%s)\n' "$(echo "$live_done" | sed 's/ /, /g; s/^,//')"
    compute_groups "$budget" | tr '|' '\n' | {
      gi=0; seen=" ${live_done# } "
      while IFS= read -r g || [ -n "$g" ]; do
        g="$(echo $g)"                       # trim surrounding whitespace
        [ -z "$g" ] && continue
        gi=$((gi + 1))
        gw=0; for q in $g; do gw=$((gw + $(_phase_weight "$q"))); done
        np="$(set -- $g; echo $#)"
        flags=""
        first="${g%% *}"
        miss=""
        for d in ${DEPS[$first]:-}; do _in_list "$d" "$seen" || miss="$miss $d"; done
        [ -n "$miss" ] && flags="$flags  ⚠ waiting on:${miss}"
        ggat=no; for q in $g; do [ "${GATED[$q]:-no}" = yes ] && ggat=yes; done
        [ "$ggat" = yes ] && flags="$flags  🔒 GATED — own session, confirm gates first"
        [ "$gw" -gt "$budget" ] && flags="$flags  ⚠ over budget — split"
        if [ "$np" -gt 1 ]; then
          printf '  Session %s  batch  (~%sK):  %s%s\n' "$gi" "$((gw / 1000))" "$(echo $g | sed 's/  */ → /g')" "$flags"
        else
          printf '  Session %s  solo   (~%sK):  Phase %s%s\n' "$gi" "$((gw / 1000))" "$g" "$flags"
        fi
        seen="${seen}${g} "
      done
    }
    printf '\n'
    exit 0
    ;;
  --boot-prompt)
    [ -z "$arg" ] && { echo "usage: --boot-prompt <phase>" >&2; exit 2; }
    p="$arg"
    # Every other per-phase arm supplies a `:-` default and answers something;
    # this one indexed DEPS/GATED bare, so a phase the table does not hold died
    # with a raw `unbound variable` from a line number — through the console,
    # that is what the operator saw instead of "phase 99 is not in this plan".
    case " ${PHASES[*]} " in
      *" $p "*) ;;
      *) printf 'phase %s is not in this plan (%s has phases: %s)\n' "$p" "$slug" "${PHASES[*]}" >&2; exit 2 ;;
    esac
    # Read-first context = the handoffs of THIS phase's dependencies (what it builds
    # on), not merely the most recent phase — a DAG phase may build on a low-numbered
    # prerequisite while higher-numbered siblings are still unwritten.
    dep_lines=""
    for d in ${DEPS[$p]:-}; do
      pad="$(printf '%02d' "$((10#$d))")"
      hf="$(handoff_file "$pad")"
      [ -n "$hf" ] && dep_lines="${dep_lines}- docs/handoffs/${slug}/$(basename "$hf")"$'\n'
    done
    printf '/phased-execution\n\n'
    printf 'Continue the "%s" plan — start Phase %s in this fresh session.\n' "$slug" "$p"
    sk="$(plan_skills)"
    [ -n "$sk" ] && printf 'First, invoke these skills (every session in this plan uses them): %s\n' "$sk"
    mc="$(mcp_for_phase "$p")"
    if [ -n "$mc" ]; then
      printf 'This phase needs these MCP servers: %s\n' "$mc"
      printf 'Confirm they are connected before implementing (`/mcp`, or `claude mcp list`). If one\n'
      printf 'needs authentication, STOP and ask the operator to sign it in — do not work around a\n'
      printf 'missing server by hand, because the plan chose it for a reason.\n'
    fi
    sp="$(setup_for_phase "$p")"
    if [ -n "$sp" ]; then
      printf 'Bring the stack up first — this phase declares a Setup preamble, and nothing it verifies\n'
      printf 'will work until these have run:\n'
      printf '%s\n' "$sp" | sed 's/^/    /'
      printf 'They are bring-up, not proof: the runner executes them before §Verification and never\n'
      printf 'marks the phase red for one.\n'
    fi
    # The wait procedure: the same rule sentences as WAIT_PROCEDURE_RULES in
    # viewer/server/runner/runner-core.ts, SKILL.md and
    # references/console-surface.md — viewer/test/wait-procedure.test.ts reads
    # this output against that list. It replaced the old advice to poll a
    # background job once per turn, which one session obeyed 311 times.
    printf 'Waiting without polling. Every tool call re-reads your whole context, so a status check\n'
    printf 'costs as much as an edit. Never make two status checks in a row (`ListAgents`,\n'
    printf '`TaskOutput`, `date`, `tail`/`grep`/`cat` of a log, `pgrep`, `gh run view`), and never\n'
    printf 'check on a subagent you dispatched.\n'
    printf '  1. Work remains → keep working; a background result arrives by itself as a\n'
    printf '     `<task-notification>`.\n'
    printf '  2. You need a subagent'\''s answer (a reviewer'\''s verdict) → dispatch the `Agent` in the\n'
    printf '     FOREGROUND; the call returns with the answer and costs nothing while it runs.\n'
    printf '  3. You need your own shell job and nothing else is left → wait in ONE foreground call\n'
    printf '     bounded by the Bash timeout: `until <probe>; do sleep 10; done` with\n'
    printf '     `timeout: 600000`, at most once per ten minutes. The console allows a wait on your\n'
    printf '     own job; it refuses one on somebody else'\''s clock.\n'
    printf '  4. Only subagents or monitors running in the background are left → end your turn; the\n'
    printf '     session stays alive and their notification wakes you. They are stopped ten minutes\n'
    printf '     after your turn ends — dispatch a subagent that may take longer in the FOREGROUND.\n'
    printf '     A background SHELL dies when your turn ends — never end it with one you still need.\n'
    printf '  5. Somebody else'\''s clock (CI, a deploy, a person) → commit, hand off `in-progress`, then\n'
    printf '     %s/phase-outcome.sh %s %s waiting-external --wait-minutes <M> --watch <ref>\n' "$CMD" "$slug" "$p"
    printf '     and stop.\n'
    if [ "${GATED[$p]:-no}" = yes ]; then
      gk="$(gate_kind "$p")"
      ga="$(gate_approved "$p")"
      gc_text="$(gate_conditions "$p")"
      case "$ga" in
        yes*)
          ga_by="$(printf '%s\n' "$ga" | cut -f2)"; ga_on="$(printf '%s\n' "$ga" | cut -f3)"
          printf '✅ GATED phase — gate already approved by %s on %s. Proceed straight to the work.\n' "${ga_by:-someone}" "${ga_on:-an unrecorded date}"
          ;;
        *)
          [ -n "$gc_text" ] || gc_text="(the heading is marked GATED but the plan lists no gate text — see §Phase $p)"
          case "$gk" in
            ai)
              printf '⚠️  GATED phase (ai-clearable) — the GATE CHECK is this session'\''s FIRST task, before any\n'
              printf 'implementation. Conditions:\n'
              printf '%s\n' "$gc_text" | sed 's/^/    /'
              printf 'Verify each condition for real. If one does not hold yet, DO THE WORK to make it true —\n'
              printf 'clearing this gate is in scope for this session. When every condition holds, record it:\n'
              printf '    %s/gate-approve.sh %s %s --by "ai-session" --note "<one line of evidence>"\n' "$CMD" "$slug" "$p"
              printf 'then commit + push docs/handoffs/%s/gate-status.md and continue into the phase.\n' "$slug"
              printf 'Only if a condition is genuinely out of reach (missing credentials, a third party):\n'
              printf 'STOP, report exactly what is missing and what you verified, and hand it to the operator.\n'
              ;;
            human)
              if [ "${PE_GATE_DELEGATE:-0}" = "1" ]; then
                # The operator delegated this gate's verification to the session.
                # `gate-status.md`'s own header already names an AI session that
                # verified the conditions as a legitimate approver, and plans in
                # the wild record exactly that (`by: ai-session-delegated`). The
                # safety is NOT that the session is trusted to judge — it is that
                # a condition it cannot verify from evidence STOPS it, with the
                # unverified condition named, rather than being waved through.
                printf '🤖 GATED phase (human, DELEGATED to you) — verify it yourself before implementing.\n'
                printf 'The operator has delegated this gate. Conditions, verbatim:\n'
                printf '%s\n' "$gc_text" | sed 's/^/    /'
                printf 'For EACH condition: verify it against evidence you can actually read (a command you\n'
                printf 'run, a file, a URL you fetch, a CI status). Quote that evidence.\n'
                printf -- '- Every condition verified → record it and continue into the phase:\n'
                printf -- '    %s/gate-approve.sh %s %s --by "ai-session-delegated" --note "<condition: evidence, per condition>"\n' "$CMD" "$slug" "$p"
                printf -- '- ANY condition you cannot verify from evidence — a visual judgement nobody has made,\n'
                printf -- '  a credential you lack, a person'"'"'s sign-off, a preview nobody has looked at — STOP.\n'
                printf -- '  Do not approve it, do not implement past it, and say exactly which condition and why:\n'
                printf -- '    %s/phase-outcome.sh %s %s blocked --needs gates --reason "<the condition you could not verify>"\n' "$CMD" "$slug" "$p"
                printf 'Never record an approval you cannot cite evidence for. A gate approved on a guess is\n'
                printf 'worse than a gate that stopped the run.\n'
              else
                printf '🧍 GATED phase (human) — STOP: a person must clear this gate before implementation.\n'
                printf 'Operator steps:\n'
                printf '%s\n' "$gc_text" | sed 's/^/    /'
                printf 'Ask the operator to do these steps and approve the gate — Phase Console → plan → phase %s\n' "$p"
                printf -- '→ Gate card, or: %s/gate-approve.sh %s %s --by "<who>" --note "<what was done>"\n' "$CMD" "$slug" "$p"
                printf 'Do NOT implement past an unapproved human gate.\n'
              fi
              ;;
            *)
              gs="$(PHASE_EXEC_GATES=0 DOCS_ROOT="$DOCS_ROOT" "$0" "$slug" --gate-status "$p" 2>/dev/null || true)"
              printf '⚠️  GATED phase (auto-checked) — current verdict: %s\n' "${gs:-unknown}"
              case "$gs" in
                unevaluated:*)
                  # A `cmd` gate read WITHOUT PHASE_EXEC_GATES=1. Do not tell the
                  # session to "confirm it is clear" — the same command would
                  # answer `unevaluated` again and it would fetch a person for a
                  # gate no person owns.
                  printf 'That verdict is NOT a refusal and NOT a person'"'"'s gate: a `cmd` gate only executes for a\n'
                  printf 'caller that opts in, and a plain read never does. Evaluate it yourself:\n'
                  printf '    PHASE_EXEC_GATES=1 %s/phase-graph.sh %s --gate-status %s\n' "$CMD" "$slug" "$p"
                  printf 'Read the command first — you are choosing to run text written in a markdown file.\n'
                  ;;
                *)
                  printf 'Confirm it is clear before implementing:  %s/phase-graph.sh %s --gate-status %s\n' "$CMD" "$slug" "$p"
                  ;;
              esac
              printf '(An operator can override a stuck check: %s/gate-approve.sh %s %s)\n' "$CMD" "$slug" "$p"
              ;;
          esac
          ;;
      esac
    fi
    printf 'Bootstrap from disk only:\n'
    [ -n "$dep_lines" ] && printf '%s' "$dep_lines"
    printf -- '- docs/plans/%s.md §Phase %s + §Session budget (model, budget, branch)\n' "$slug" "$p"
    printf -- '- memory %s\n' "$memory_key"
    printf 'This is a DAG: other phases may be ready too and lower-numbered phases may still be\n'
    printf 'unfinished — do NOT assume phases below %s are done. Run `%s/phase-graph.sh %s`\n' "$p" "$CMD" "$slug"
    printf 'for live state.\n'
    # What earlier phases LEFT for this one — handoff notes, deferral rulings
    # and boot-deliverable mail, in one block. It sits here, immediately after
    # the board and before the decisions manifest, because it is the only part
    # of this prompt that nobody could have written into the plan: everything
    # below is the plan's standing instruction, and this is what actually
    # happened on the way here. Omitted entirely when nobody left anything, so
    # a plan that never writes a note gets a byte-identical prompt.
    bp_notes="$(notes_for "$p")"
    if [ -n "$bp_notes" ]; then
      bp_n="$(printf '%s\n' "$bp_notes" | awk -F'\t' '$2 != "trailer"' | grep -c . || true)"
      printf '\n### Notes from earlier phases (%s) — what they left for you, and nothing you can look up:\n' "$bp_n"
      printf '%s\n' "$bp_notes" | awk -F'\t' '
        $2 == "trailer" { printf "  %s\n", $5; next }
        $2 == "message" { printf "  - [%s] %s (mail from %s)\n", $3, $5, $1; next }
        $2 == "deferral" { printf "  - %s (deferred by %s)\n", $5, $1; next }
        { printf "  - %s (%s)\n", $5, $1 }
      '
      printf 'Each was left by a session that is gone. Say in your handoff what became of each —\n'
      printf 'acted on, or deliberately not; a note nobody answers is a note nobody writes next time.\n'
      if printf '%s\n' "$bp_notes" | awk -F'\t' '$2 == "message"' | grep -q .; then
        printf 'The bracketed ids are mail. Acknowledge the ones you act on, so the sender learns it landed:\n'
        printf -- '    %s/phase-msg.sh %s %s ack <id>\n' "$CMD" "$slug" "$p"
      fi
    fi
    # The decision manifest, resolved for this phase — `outstanding` rows first,
    # because a row nobody has answered is the one thing the session must not
    # discover mid-phase (chapter 13 Tier 0). Then the one duty the manifest
    # puts on a session: a block is declared BY KEY, never asked in prose.
    dec_rows="$(decisions_rows "$p")"
    printf '\nThis phase'\''s DECISIONS (the plan'\''s manifest, `%s/phase-graph.sh %s --decisions %s`):\n' "$CMD" "$slug" "$p"
    if [ -n "$dec_rows" ]; then
      printf '%s\n' "$dec_rows" | awk -F'\t' '$2 == "outstanding" { printf "  - [%s] %s — owner %s, blocking %s: %s\n", $2, $1, ($3 == "" ? "nobody" : $3), $4, ($6 == "" ? "(no value yet)" : $6) }'
      printf '%s\n' "$dec_rows" | awk -F'\t' '$2 != "outstanding" { printf "  - [%s] %s: %s\n", $2, $1, ($6 == "" ? "(no value)" : $6) }'
    else
      printf '  (this plan carries no `## Decisions` manifest — the keys are: %s)\n' "$(printf '%s' "$DECISION_KEYS" | sed 's/ /, /g')"
    fi
    printf 'If you cannot proceed because a decision is missing or wrong, declare it BY KEY and stop:\n'
    printf -- '    %s/phase-outcome.sh %s %s blocked --needs <key> --reason "<what you need>"\n' "$CMD" "$slug" "$p"
    printf -- '`--needs` is REQUIRED on `blocked` and `needs-human` (exit 2 without it): a decision key from\n'
    printf 'the list above, or its short form (%s). Never ask in prose — prose reaches nobody.\n' "$(printf '%s' "$NEED_CLASSES" | sed 's/ /, /g')"
    sc="${REPOS[$p]:-all}"
    printf '\nThis phase'\''s SCOPE (the repos it touches, from the plan'\''s Repos column): %s\n' "$sc"
    printf 'Two sessions may run at once ONLY on disjoint scopes. Before implementing:\n'
    printf -- '  1. `git pull`, then check nothing live shares your tree:\n'
    printf -- '       %s/phase-lock.sh %s conflicts %s --scope "%s" --git\n' "$CMD" "$slug" "$p" "$sc"
    printf -- '     A reported conflict means STOP AND ASK the user — never build over a live session.\n'
    printf -- '  2. Claim it:\n'
    printf -- '       %s/phase-lock.sh %s claim %s --scope "%s" --git\n' "$CMD" "$slug" "$p" "$sc"
    printf -- '     (--owner defaults to $PE_OWNER, which the autopilot already exports to its\n'
    printf -- '      sessions — do not override it, or the supervisor cannot release your lock.\n'
    printf -- '      Only a person driving this by hand should pass --owner "<account>/<session>".)\n'
    printf -- '     Need a checkout of your own beside a live build (a QA round, a review)? Never make a\n'
    printf -- '     sibling folder by hand — `%s/phase-lane.sh %s create %s [--qa <round>] [--detach]`\n' "$CMD" "$slug" "$p"
    printf -- '     puts one under <root>/.worktrees/hand/, locked; `merge` and `remove` fold it back and clean up.\n'
    printf 'The invariant: never two live sessions whose scopes intersect; same repo ⇒ serialized;\n'
    printf '`all` ⇒ exclusive against every unqualified claim; disjoint ⇒ parallel. (Handoff/lock commits in the docs repo are NOT\n'
    printf 'part of your scope — if a commit or pull races another session, pull --rebase and retry\n'
    printf 'up to 3 times; git'\''s own index.lock is the serialization there.)\n'
    printf '\nThen publish this phase'\''s p%s.task* list with `phase-tasks.sh`. Phase Console\n' "$p"
    printf 'renders it live as "What it is doing" — the only way anyone watching an unattended\n'
    printf 'session can see what it thinks it is doing, and it survives a reload and a console\n'
    printf 'restart because the runner folds it into the run record:\n'
    printf -- '    %s/phase-tasks.sh %s %s reset\n' "$CMD" "$slug" "$p"
    printf -- '    %s/phase-tasks.sh %s %s create --subject "p%s.task1 — <what>"\n' "$CMD" "$slug" "$p" "$p"
    printf -- '    %s/phase-tasks.sh %s %s update --id p%s.task1 --status in_progress\n' "$CMD" "$slug" "$p" "$p"
    printf -- '    %s/phase-tasks.sh %s %s update --id p%s.task1 --status completed\n' "$CMD" "$slug" "$p" "$p"
    printf 'The ids are yours: an unnamed create is numbered p%s.task1, p%s.task2 … in order, so an\n' "$p" "$p"
    printf 'update needs nothing read back. Keep the list current as you go.\n'
    printf 'Do NOT go looking for a TodoWrite / TaskCreate / TaskUpdate tool. The CLI stopped\n'
    printf 'providing them to sessions in August 2026 and searching for one is a wasted pass —\n'
    printf 'that is exactly why this script exists. If your harness happens to have them, using\n'
    printf 'them as well is harmless: they feed the same list.\n'
    printf 'Then implement Phase %s to its exit criteria.\n' "$p"
    pad="$(printf '%02d' "$((10#$p))")"
    printf '\nWhen done, the deliverable is the HANDOFF — the board reads `status:` from it, and a\n'
    printf 'phase with no handoff does not exist to the board. Scaffold it with:\n'
    printf -- '    %s/new-handoff.sh %s %s <kebab-title> complete\n' "$CMD" "$slug" "$p"
    printf 'then fill in docs/handoffs/%s/phase-%s-<kebab-title>.md and commit it.\n' "$slug" "$pad"
    printf 'Cannot finish? Hand off `in-progress` (paused, resumable) or `blocked` (needs help) —\n'
    # The QA duty, stated where the session will actually read it — and BEFORE
    # the stop instruction. SKILL.md has always asked a QA-on plan's finishing
    # session to dispatch a QA subagent; the boot prompt never repeated it, and
    # then repeated it AFTER "Stop after the handoff exists." — so a session
    # reading top to bottom was told to stop first, and did. Measured: a
    # `pending` row held a phase's whole downstream cone for hours with no
    # defect recorded anywhere. Named only when QA actually gates; the QA-off
    # output is byte-identical.
    case "$(qa_mode_for_phase "$p")" in
      on)
        printf 'never end the session without a handoff.\n'
        printf '\nThis plan runs QA ON, so the handoff is not the last step: a `complete` handoff\n'
        printf 'writes a `pending` QA row, and a pending row holds every dependent phase exactly\n'
        printf 'as a failure does. Nothing dispatches QA on your behalf. Before you stop, run a\n'
        printf 'FRESH-context QA subagent over this phase (get its brief with\n'
        printf -- '`%s/phase-graph.sh %s --qa-prompt %s`) and record what it finds:\n' "$CMD" "$slug" "$p"
        _bpn="$(qa_next_round "$p")"
        printf -- '    bash %s/qa-record.sh %s %s <pass|fail|waived> --report %s --round %s\n' \
          "$SCRIPT_DIR" "$slug" "$p" "${_bpn#*	}" "${_bpn%%	*}"
        printf 'Never review your own work as the QA verdict, and never hand-edit test-status.md.\n'
        printf 'Dispatch the subagent, record the verdict, THEN stop.\n'
        printf 'The reviewer is work inside your turn: dispatch it in the FOREGROUND, so the call returns\n'
        printf 'with its verdict and costs nothing while it runs, then record the verdict before the turn\n'
        printf 'ends. A turn that ends before the verdict is recorded records nothing.\n'
        ;;
      *)
        printf 'never end the session without a handoff. Stop after the handoff exists.\n'
        ;;
    esac
    printf 'Waiting on something OUTSIDE this session (a CI build, a PR auto-merge, a deploy\n'
    printf 'window)? Saying so in prose is invisible to the supervisor. Hand off `in-progress`,\n'
    printf 'then declare it and stop:\n'
    printf -- '    %s/phase-outcome.sh %s %s waiting-external --wait-minutes <M> --reason "<what>" --watch <ref>\n' "$CMD" "$slug" "$p"
    printf 'The supervisor parks the phase and resumes THIS session when the window elapses.\n'
    exit 0
    ;;
  board) ;;  # fall through to the human board
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac

# ---------------------------------------------------------------------------
# Default: human status board.
# ---------------------------------------------------------------------------
done_n=0
for p in "${PHASES[@]}"; do [ "${STATUS[$p]}" = "done" ] && done_n=$((done_n + 1)); done
total="${#PHASES[@]}"

printf '\nPhase graph — %s   (%s/%s done)\n' "$slug" "$done_n" "$total"

# A closed plan keeps its whole board — closing quiets a plan, it never hides one —
# but the banner goes first so nobody mistakes the phase lines for outstanding work.
if plan_is_closed; then
  printf '\n'
  closed_banner
fi

# Reconcile parsed rows against the plan's declared phase count — a mismatch means
# the table is malformed (e.g. a phase number wrapped oddly) and the board may mislead.
declared="$(grep -m1 '^phases:' "$plan_file" | sed 's/^phases:[[:space:]]*//; s/[[:space:]]*#.*$//' || true)"
if [ -n "$declared" ] && [ "$declared" != TODO ] && [ "$declared" != "$total" ]; then
  if plan_is_closed; then
    printf 'ℹ️  note: frontmatter says phases: %s but the table parsed %s rows.\n' "$declared" "$total"
  else
    printf '⚠️  plan frontmatter says phases: %s but the table parsed %s rows — check the\n' "$declared" "$total"
    printf '    "## Phase graph" table for a row the parser skipped (odd phase-number formatting).\n'
  fi
fi
# F1/F2/F3: surface structural problems by name instead of silently misleading.
# On a closed plan they stay visible — a broken plan must never become invisible —
# but demoted to a note, because nobody owes repairs to a plan they have closed.
_issues="$(compute_issues)"
if [ -n "$_issues" ]; then
  if plan_is_closed; then
    printf 'ℹ️  structural notes (not gating — this plan is closed):\n'
    printf '%s\n' "$_issues" | sed 's/^/      • /'
  else
    printf '⚠️  STRUCTURE PROBLEMS — fix these; the board below may be wrong until you do:\n'
    printf '%s\n' "$_issues" | sed 's/^/      • /'
  fi
fi
echo

ready_list=""; waiting_list=""; inprog_list=""
for p in "${PHASES[@]}"; do
  state="$(phase_state "$p")"
  gmark=""
  if [ "${GATED[$p]:-no}" = yes ]; then
    gmark=" 🔒GATED"
    gk="$(gate_kind "$p")"
    [ "$gk" != none ] && gmark=" 🔒GATED·${gk}"
    case "$(gate_approved "$p")" in yes*) gmark="${gmark} ✓approved" ;; esac
  fi
  case "$state" in
    done)        icon="✅"; extra=""
                 if qa_gates_phase "$p" && ! plan_is_closed; then
                   case "$(qa_result "$p")" in
                     pass|waived) extra=" · QA:verified" ;;
                     fail)        extra=" · QA:FAILED" ;;
                     *)           extra=" · QA:pending" ;;
                   esac
                 fi ;;
    in-progress) icon="🚧"; extra=""; inprog_list="$inprog_list $p" ;;
    stuck)       icon="⛔"; extra=" (handoff status: blocked)"; inprog_list="$inprog_list $p" ;;
    ready)       icon="🔓"; extra=""; ready_list="$ready_list $p" ;;
    waiting)     miss="$(missing_deps "$p")"; icon="⏳"; extra=" needs: $(missing_deps_annotated "$p")"
                 waiting_list="$waiting_list $p(←${miss// /,})" ;;
  esac
  printf '  %s  %-2s %-12s %s%s%s\n' "$icon" "$p" "$state" "${TITLE[$p]}" "$gmark" "$extra"
done

echo
# Everything below this line is a call to action — which is exactly what a closed
# plan must not issue. No ready work, no batching advice, no "finish me" nudge.
if plan_is_closed; then
  printf 'No work is outstanding on a closed plan.\n\n'
  exit 0
fi
[ -n "$ready_list" ]  && printf 'READY NOW:   %s\n' "$(echo "$ready_list" | sed 's/^ //')"
[ -n "$inprog_list" ] && printf 'IN PROGRESS: %s\n' "$(echo "$inprog_list" | sed 's/^ //')"
[ -n "$waiting_list" ]&& printf 'WAITING:     %s\n' "$(echo "$waiting_list" | sed 's/^ *//')"
if [ "$HAVE_SIZES" = 1 ]; then
  board_budget="$(resolve_budget "$(plan_model)")"   # F6: honour the plan's Session budget model
  batches="$(compute_groups "$board_budget" | sed 's/ /+/g; s/|/]  [/g')"
  printf 'SUGGESTED BATCHES (budget ~%sK, joined phases share a session): [%s]\n' "$((board_budget / 1000))" "$batches"
  printf '   model-specific grouping → %s/phase-graph.sh %s --session-plan <model>\n' "$CMD" "$slug"
fi
if [ "$done_n" = "$total" ]; then
  printf '\n🏁 All %s phases done — run §End-to-end verification, then close the plan:\n' "$total"
  printf '   %s/close-plan.sh %s --status complete --reason "<what shipped>"\n' "$CMD" "$slug"
elif [ -z "$ready_list" ] && [ -z "$inprog_list" ]; then
  printf '\n⚠️  Nothing ready and nothing in progress — every remaining phase is waiting on a dep.\n'
  printf '   Check the WAITING list above for a stuck/blocked dependency.\n'
fi
echo

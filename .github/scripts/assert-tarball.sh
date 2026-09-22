#!/usr/bin/env bash
# Assert the npm tarball's contents: everything the console needs at runtime is
# present, and nothing that must never ship is inside. The `files` allowlist in
# package.json is the intent; THIS is the proof — npm-packlist behavior has
# shifted across npm versions, so never trust the allowlist alone.
#
#   assert-tarball.sh <path-to-tgz>
set -uo pipefail

tgz="${1:?assert-tarball.sh needs the tarball path}"
[ -f "$tgz" ] || { echo "no such tarball: $tgz" >&2; exit 2; }

list="$(mktemp)"
trap 'rm -f "$list"' EXIT
tar -tzf "$tgz" > "$list"

fail=0

# Runtime file set — see the packaging plan. server/index.js is the
# pre-stripped entry for installs that land under node_modules.
for p in \
  "viewer/client/dist/index.html" \
  "viewer/client/dist/sw.js" \
  "viewer/client/dist/.build-rev" \
  "viewer/server/index.ts" \
  "viewer/server/index.js" \
  "viewer/server/platform.ts" \
  "viewer/server/registry-file.ts" \
  "viewer/server/watch-refs.ts" \
  "viewer/server/watch-scheduler.ts" \
  "viewer/server/debug/index.ts" \
  "viewer/server/debug/sources.ts" \
  "viewer/server/debug/deps.ts" \
  "viewer/server/platform.js" \
  "viewer/server/fallback-sw.js" \
  "viewer/server/accounts/index.ts" \
  "viewer/server/accounts/workspace.ts" \
  "viewer/server/mcp/index.ts" \
  "viewer/server/mcp/store.ts" \
  "viewer/server/mcp/credentials.ts" \
  "viewer/server/mcp/health.ts" \
  "viewer/server/mcp/catalog.ts" \
  "viewer/server/mcp/config.ts" \
  "viewer/server/issues/index.ts" \
  "viewer/server/issues/inventory.ts" \
  "viewer/server/issues/fetch.ts" \
  "viewer/server/issues/prompt.ts" \
  "viewer/server/mcp/login.ts" \
  "viewer/server/accounts/index.js" \
  "viewer/server/accounts/usage.ts" \
  "viewer/server/accounts/transcripts.ts" \
  "viewer/server/accounts/learned.ts" \
  "viewer/server/accounts/entitlement-probe.ts" \
  "viewer/server/launcher.ts" \
  "viewer/server/launcher.js" \
  "viewer/server/hooks-install.ts" \
  "viewer/server/hooks-install.js" \
  "viewer/server/pty/broker.ts" \
  "viewer/server/pty/broker.js" \
  "viewer/server/pty/client.ts" \
  "viewer/server/pty/client.js" \
  "viewer/server/pty/protocol.ts" \
  "viewer/server/pty/scrollback.ts" \
  "viewer/server/pty/spawn-helper.ts" \
  "viewer/shared/scope.js" \
  "viewer/shared/landing-model.js" \
  "viewer/shared/issues-model.js" \
  "viewer/shared/instances.mjs" \
  "viewer/shared/recovery-model.js" \
  "viewer/shared/situation-model.js" \
  "viewer/shared/decisions-model.js" \
  "viewer/shared/cli-tools.js" \
  "viewer/shared/ladder-model.js" \
  "viewer/shared/attention-model.js" \
  "viewer/shared/run-lifecycle.js" \
  "viewer/shared/fact-map.js" \
  "viewer/shared/evidence-model.js" \
  "viewer/shared/routes.js" \
  "viewer/shared/diff.js" \
  "viewer/shared/run-settings.js" \
  "viewer/shared/status-vocab.js" \
  "viewer/shared/plan-vocab.js" \
  "viewer/shared/ops-vocab.js" \
  "viewer/shared/task-model.js" \
  "viewer/shared/schedule-policy.js" \
  "viewer/shared/projection.js" \
  "viewer/shared/worktree-model.js" \
  "viewer/shared/automation-model.js" \
  "viewer/shared/orchestration-model.js" \
  "viewer/server/inbox.ts" \
  "viewer/server/analysis/spend.ts" \
  "viewer/server/runner/models.ts" \
  "viewer/server/runner/liveness.ts" \
  "viewer/server/runner/session-record.ts" \
  "viewer/server/runner/wait-budget.ts" \
  "viewer/server/runner/run-paths.ts" \
  "viewer/server/actor.ts" \
  "viewer/server/api/actor.ts" \
  "viewer/server/start-ceiling.ts" \
  "viewer/server/runner/rulings.ts" \
  "viewer/server/runner/ultrareview.ts" \
  "viewer/shared/policy-model.js" \
  "viewer/server/runner/policy.ts" \
  "viewer/server/prelude.ts" \
  "viewer/server/credentials-probe.ts" \
  "viewer/server/trace.ts" \
  "viewer/server/shell.ts" \
  "viewer/server/git-trace.ts" \
  "viewer/server/counters.ts" \
  "viewer/shared/message-model.js" \
  "viewer/server/doctor.ts" \
  "viewer/shared/relay-model.js" \
  "viewer/server/relay.ts" \
  "viewer/server/relay-host.ts" \
  "viewer/server/relay-host.js" \
  "viewer/server/cli-init.ts" \
  "viewer/server/shutdown.ts" \
  "viewer/shared/fleet-model.js" \
  "viewer/server/fleet.ts" \
  "viewer/shared/poll-loop.js" \
  "viewer/server/runner/usage.ts" \
  "viewer/server/runner/verify-review.ts" \
  "bin/doctor-verb.mjs" \
  "bin/sessions-verb.mjs" \
  "bin/diagnostics-verb.mjs" \
  "viewer/server/retention.ts" \
  "viewer/server/retention-policy.ts" \
  "viewer/server/debug/bundle.ts" \
  "viewer/server/debug/tar.ts" \
  "scripts/models.env" \
  "viewer/scripts/check-stamp.mjs" \
  "viewer/run" \
  "viewer/package.json" \
  "scripts/phase-graph.sh" \
  "scripts/validate.sh" \
  "scripts/next-phase-prompt.sh" \
  "scripts/phase-lock.sh" \
  "scripts/phase-lane.sh" \
  "scripts/new-plan.sh" \
  "scripts/new-handoff.sh" \
  "scripts/qa-record.sh" \
  "scripts/qa-mode.sh" \
  "scripts/decisions.sh" \
  "scripts/phase-outcome.sh" \
  "scripts/phase-tasks.sh" \
  "scripts/repair-artefacts.sh" \
  "scripts/gate-approve.sh" \
  "scripts/close-plan.sh" \
  "scripts/handoff-status.sh" \
  "scripts/phase-landing.sh" \
  "scripts/scope.sh" \
  "scripts/instance.sh" \
  "scripts/session-hook.sh" \
  "scripts/sizing.env" \
  "scripts/mcp.env" \
  "scripts/gates.env" \
  "scripts/verify.env" \
  "scripts/decisions.env" \
  "scripts/landing.env" \
  "scripts/messages.env" \
  "scripts/issues.env" \
  "templates/plan.md" \
  "templates/handoff.md" \
  "templates/INDEX.md" \
  "references/qa-method.md" \
  "assets/report-template.md" \
  "bin/phase-console" \
  "bin/phase-console.mjs" \
  "bin/btw" \
  "start" \
  "SKILL.md" \
  "LICENSE" \
  "README.md" \
  "package.json"; do
  grep -q "^package/$p\$" "$list" || { echo "MISSING from tarball: $p" >&2; fail=1; }
done


# One deliberate carve-out from the never-ship set below. `viewer/client/src/`
# is forbidden because it is unbuilt SOURCE; a font licence is not source, and
# the SIL OFL requires it to travel with the .woff2 files the client bundles
# into `client/dist/`. Named exactly and to the file, so the rule still catches
# the next .tsx that wanders into the allowlist.
scan="$(mktemp)"
trap 'rm -f "$list" "$scan"' EXIT
grep -vxF "package/viewer/client/src/assets/fonts/OFL.txt" "$list" > "$scan"

# Never-ship set. CLAUDE.md guards local repo guidance; the middle entries guard
# the shared/ modules NOTHING under server/ imports from creeping in.
# `status-vocab` left this list in Phase 6: server/inbox.ts imports its
# `isLiveStatus` rather than keeping a private copy, so it must ship.
# `assets/console.gif` is 34 MB of demo screencast: every npm install and every
# Homebrew bottle paid for it to sit unread on disk, so the README links a
# hosted copy and the allowlist names `assets/report-template.md` instead of
# the whole directory.
for a in \
  "viewer/test/" \
  "viewer/client/src/" \
  "assets/console.gif" \
  "viewer/client/public/" \
  "viewer/vite.config.ts" \
  "viewer/tsconfig.json" \
  "viewer/scripts/stamp-build.mjs" \
  "viewer/scripts/build-rev.mjs" \
  "viewer/scripts/check-dist.mjs" \
  "viewer/scripts/verify-dist.mjs" \
  "viewer/scripts/precompress.mjs" \
  "viewer/scripts/replay-poll-guard.mjs" \
  "docs/" \
  "tests/" \
  "evals/" \
  ".github/" \
  ".claude-plugin/" \
  "package-lock.json" \
  "CLAUDE.md" \
  "viewer/shared/setup-prompts" \
  "viewer/shared/console-model" \
  "viewer/shared/phase-model" \
  "viewer/shared/route-meta" \
  "viewer/shared/sw-push"; do
  if grep -q "package/$a" "$scan"; then
    echo "MUST NOT ship, but is in tarball: $a" >&2
    fail=1
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "tarball assertions PASS ($(wc -l < "$list" | tr -d ' ') files)"
fi
exit "$fail"

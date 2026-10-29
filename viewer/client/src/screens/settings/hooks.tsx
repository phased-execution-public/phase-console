/**
 * Settings ▸ Hooks (measured-console phase 28, D3) — every hook the console
 * knows, read-only, and the hookify rules it writes per plan; first, the one
 * hook it installs itself, the session-presence hook (7.0's, quiet-console
 * phase 21, here since phase 28).
 *
 * ```
 * Session presence     Installed   ~/.claude/settings.json   Remove the hook
 * Every hook           [Plugin] User  Project  Run
 *   SessionStart   command   bash "${CLAUDE_PLUGIN_ROOT}/scripts/session-hook.sh"   15 s · carries on
 *   PreToolUse     http      <console>/hooks/pre-tool-use   Bash|Write|…   3600 s · blocks the call
 * hookify rules, per plan
 *   measured-console   block  bash  publish         git\s+push\b|…   written, current
 * ```
 *
 * A hook's row says its event, where it came from, what it runs, its matcher,
 * its timeout and its `onFailure` — `block`, so a hook that cannot start,
 * times out or answers garbage blocks the call; absent, the CLI carries on.
 * The run's hooks are the ones `runner/approvals.ts` writes into every
 * supervised session's settings, the conditional ones marked with the runs
 * that carry them. The hookify rules are what the plan's `permission.destructive`
 * row and the never list write into the root's `.claude/` when a run starts
 * (`server/hookify.ts`): a rule a person can read, beside — never instead of —
 * the run's own `PreToolUse` hook.
 *
 * ```
 * Session presence
 * A user-scope Claude Code hook tells this console when any Claude session …
 * Not installed   ~/.claude/settings.json   Install the hook
 * Adds SessionStart, SessionEnd, Stop and Notification entries to ~/.claude/settings.json; …
 * From a terminal: phase-console install-hooks, uninstall-hooks, hooks-status. …
 * ```
 *
 * Phase Console learns that a Claude session is live, still live or ended from
 * a user-scope Claude Code hook (`scripts/session-hook.sh`) — the channel an
 * interactive `claude`, a console agent and an autopilot lane did not have.
 * With it installed, a hand-run session shows on Sessions, the autopilot
 * queues behind its lock while it lives, and the lock is debris the moment the
 * session ends. The server edits `~/.claude/settings.json` itself (merge,
 * never clobber — every other key keeps its bytes); this group only asks it
 * to, through the owner door, and says what is there. The terminal spelling of
 * the same act is `phase-console install-hooks`.
 *
 * The hook's standing is a fact about a file, not a status of the console's
 * vocabularies, so it is said in words and painted nothing.
 */

import type { HookRowView, HooksStatusView, HooksView } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useHooks, useHooksStatus, useHooksWrite } from '@/data/sessions';
import { homePath } from '@/lib/format';
import { useRoute } from '@/shell/router';
import { settingsHref } from '@/shell/routes';
import { SectionNav } from '@/shell/section-nav';
import { Banner, Button, Empty, Mono, Skeleton, toast } from '@/ui';
import { SettingsGroup, failureWords } from './setting';

/** Why the button is off on a console that may not edit files. */
export const HOOK_WRITES_OFF =
  'Start the console with --allow-writes to change the hook: it edits ~/.claude/settings.json.';

/** What the settings file holds, in words. */
export function hookStatusWords(status: HooksStatusView | undefined): string {
  if (!status) return 'Checking';
  if (status.parseError) return 'The settings file does not parse';
  if (status.installed) return status.stale ? 'Points at another checkout' : 'Installed';
  if (status.stale) return 'Points at another checkout';
  if (status.partial) return 'Partially installed';
  return 'Not installed';
}

/** What a write that went through says. */
function doneWords(action: 'install' | 'uninstall', changed: boolean): string {
  if (action === 'install') {
    return changed
      ? 'Session hook installed. Sessions started from now on report to this console.'
      : 'The session hook was already installed.';
  }
  return changed ? 'Session hook removed.' : 'No session hook to remove.';
}

export function HooksGroup() {
  const state = useConsoleState();
  const status = useHooksStatus();
  const hooks = useHooksWrite();
  const view = status.data;

  const shownPath = homePath(view?.path, state.data?.home);
  const where = shownPath ?? '~/.claude/settings.json';
  const writesOff = state.data?.allowWrites !== true;
  const removable = Boolean(view?.installed && !view.stale);

  const act = async (action: 'install' | 'uninstall') => {
    try {
      const pressed = await hooks.write(action);
      if (pressed.state === 'asked') toast(pressed.words, 'info', 6000);
      else toast(doneWords(action, pressed.result.changed), 'ok');
    } catch (error) {
      toast(failureWords(error), 'error');
    }
  };

  return (
    <SettingsGroup
      id="hooks"
      title="Session presence"
      lead={
        <>
          A user-scope Claude Code hook tells this console when any Claude session in its repository starts,
          finishes a turn or ends: a hand-run <Mono value="claude" />, a console agent, an autopilot lane.
          Sessions shows them, the autopilot queues behind a live session’s lock, and the lock is released the
          moment its session ends instead of at the end of its lease.
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-body text-ink" data-testid="hook-status">
            {status.error && !view ? `Not read: ${status.error.message}` : hookStatusWords(view)}
          </span>
          {shownPath && <Mono value={shownPath} className="min-w-0 wrap-anywhere" />}
          {removable ? (
            <Button
              size="sm"
              disabled={hooks.busy !== null || writesOff}
              {...(writesOff ? { title: HOOK_WRITES_OFF } : {})}
              onClick={() => void act('uninstall')}
            >
              {hooks.busy === 'uninstall' ? 'Removing…' : 'Remove the hook'}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={hooks.busy !== null || writesOff || Boolean(view?.parseError)}
              {...(writesOff ? { title: HOOK_WRITES_OFF } : {})}
              onClick={() => void act('install')}
            >
              {hooks.busy === 'install'
                ? 'Installing…'
                : view?.stale || view?.partial
                  ? 'Repair the hook'
                  : 'Install the hook'}
            </Button>
          )}
        </div>
        {view && !view.parseError && (
          <p className="max-w-(--measure) text-meta text-ink-muted">
            {removable
              ? `Removing takes out exactly the four entries the console wrote in ${where}; nothing else in the file moves.`
              : `Installing adds SessionStart, SessionEnd, Stop and Notification entries to ${where}; every other key keeps its bytes.`}
          </p>
        )}
        {state.data && writesOff && (
          <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="hook-writes-off">
            {HOOK_WRITES_OFF}
          </p>
        )}
      </div>

      {view?.parseError && (
        <Banner severity="warn">
          {where} does not parse as JSON ({view.parseError}). The console will not write to a settings file it
          cannot read back: fix or move it, then install.
        </Banner>
      )}

      <p className="max-w-(--measure) text-meta text-ink-muted">
        From a terminal: <Mono value="phase-console install-hooks" />, <Mono value="uninstall-hooks" />,{' '}
        <Mono value="hooks-status" />. Sessions already open do not report until they restart. A session
        claiming a phase lock by hand passes <Mono value="--session <id>" /> to <Mono value="phase-lock.sh" />{' '}
        (the hook tells it its id at start); the autopilot’s lanes carry theirs. Off by default: installing it
        is your choice.
      </p>
    </SettingsGroup>
  );
}

/* ------------------------------------------------------------------ *
 * Every hook, and the hookify rules (measured-console phase 28, D3)
 * ------------------------------------------------------------------ */

/** The four places a hook comes from, in the order a session meets them. */
export const HOOK_SOURCE_WORDS: Readonly<Record<HookRowView['source'], string>> = {
  plugin: 'Plugin',
  user: 'User',
  project: 'Project',
  run: 'Run',
};

/** A hook's failure rule, in words. */
export function onFailureWords(hook: Pick<HookRowView, 'onFailure'>): string {
  return hook.onFailure === 'block' ? 'blocks the call if it fails' : 'carries on if it fails';
}

export function HooksSection() {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="settings-hooks">
      <HooksGroup />
      <EveryHook />
    </div>
  );
}

function EveryHook() {
  const { data, isPending, error } = useHooks();
  const route = useRoute();
  const asked = route.query.source as HookRowView['source'] | undefined;
  const source: HookRowView['source'] = asked && asked in HOOK_SOURCE_WORDS ? asked : 'plugin';
  if (error && !data) return <Banner severity="error">Not read: {error.message}</Banner>;
  if (isPending || !data) {
    return (
      <div aria-busy="true" aria-label="Reading the hooks">
        <Skeleton className="h-24" />
      </div>
    );
  }
  const shown = data.hooks.filter((hook) => hook.source === source);
  return (
    <>
      <SettingsGroup
        id="hooks-every"
        title="Every hook"
        lead="Read-only. The console’s plugin, your user settings, this repository’s settings and the settings every supervised run is handed — each hook with what it runs, its timeout and what happens when it fails."
      >
        <SectionNav
          label="Where the hooks come from"
          current={source}
          sections={(Object.keys(HOOK_SOURCE_WORDS) as HookRowView['source'][]).map((id) => ({
            id,
            label: `${HOOK_SOURCE_WORDS[id]} (${data.hooks.filter((hook) => hook.source === id).length})`,
            href: settingsHref('hooks', id === 'plugin' ? undefined : { source: id }),
          }))}
        />
        {!shown.length ? (
          <Empty title={`No ${HOOK_SOURCE_WORDS[source].toLowerCase()} hook is set.`} />
        ) : (
          <ul className="flex min-w-0 flex-col" data-testid="hooks-list">
            {shown.map((hook, index) => (
              <HookLine key={`${hook.event}-${index}`} hook={hook} />
            ))}
          </ul>
        )}
      </SettingsGroup>
      <Hookify view={data} />
    </>
  );
}

function HookLine({ hook }: { hook: HookRowView }) {
  return (
    <li
      className="flex min-w-0 flex-col gap-0.5 border-t border-rule py-2 first:border-t-0"
      data-hook-event={hook.event}
    >
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
        <span className="text-body font-medium text-ink">{hook.event}</span>
        <span className="text-meta text-ink-muted">
          {[
            hook.type,
            hook.matcher ? `on ${hook.matcher}` : null,
            hook.timeout ? `${hook.timeout} s` : 'the CLI’s timeout',
            onFailureWords(hook),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <Mono value={hook.runs} className="min-w-0 wrap-anywhere text-meta text-ink-muted" />
      {hook.when && <span className="text-meta text-ink-muted">Only on {hook.when}.</span>}
    </li>
  );
}

function Hookify({ view }: { view: HooksView }) {
  return (
    <SettingsGroup
      id="hooks-hookify"
      title="hookify rules, per plan"
      lead="Written into this repository’s .claude/ when a run of the plan starts, from the plan’s permission.destructive row and the never list. A session that loads hookify reads them; the run’s own hook enforces the same walls whether it does or not."
    >
      {!view.hookify.length ? (
        <Empty title="No plan is open in this console." />
      ) : (
        view.hookify.map((plan) => (
          <div key={plan.slug} className="flex min-w-0 flex-col gap-1" data-hookify-plan={plan.slug}>
            <span className="text-body font-medium text-ink">{plan.slug}</span>
            <ul className="flex min-w-0 flex-col">
              {plan.rules.map((rule) => {
                const disk = plan.onDisk.find((file) => file.file === rule.file);
                return (
                  <li
                    key={rule.file}
                    className="flex min-w-0 flex-col gap-0.5 py-1.5"
                    data-hookify-rule={rule.rule}
                  >
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                      <span className="text-body text-ink">
                        {rule.action === 'block' ? 'Blocks' : 'Warns'}
                      </span>
                      <Mono value={rule.name} />
                      <span className="text-meta text-ink-muted">
                        {[
                          `on ${rule.event}`,
                          rule.source === 'never' ? 'the never list' : 'permission.destructive',
                          disk ? (disk.current ? 'written' : 'written, out of date') : 'not written yet',
                        ].join(' · ')}
                      </span>
                    </span>
                    <span className="max-w-(--measure) text-meta text-ink-muted">{rule.words}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </SettingsGroup>
  );
}

/**
 * The session-presence hook (7.0's, quiet-console phase 21).
 *
 * ```
 * Session presence
 * A user-scope Claude Code hook tells this console when any Claude session …
 * Not installed   ~/.claude/settings.json   Install the hook
 * Adds SessionStart, SessionEnd and Stop entries to ~/.claude/settings.json; …
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

import type { HooksStatusView } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useHooksStatus, useHooksWrite } from '@/data/sessions';
import { homePath } from '@/lib/format';
import { Banner, Button, Mono, toast } from '@/ui';
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
              ? `Removing takes out exactly the three entries the console wrote in ${where}; nothing else in the file moves.`
              : `Installing adds SessionStart, SessionEnd and Stop entries to ${where}; every other key keeps its bytes.`}
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

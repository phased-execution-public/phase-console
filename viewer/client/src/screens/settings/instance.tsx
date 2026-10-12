/**
 * Settings ▸ This instance — which console is running, how it is reached, and
 * how to replace or stop it (7.0's since quiet-console phase 23).
 *
 * ```
 * This process            the server, the interface this tab runs, the skill, the supervisor
 * Restart                 the plain press, and without updating · when idle · anyway
 * The launch unit         its arguments and capability switches, each with its command
 * Reach                   Tailscale, the hosts and the people it answers
 * Logs and retention      what it keeps, for how long — every key writable
 * The machine profile     the machine-wide fields, read-only, each with its line
 * Shut down               last: the two presses that END things
 * ```
 *
 * In the order the questions arrive: what is serving this page and is it the
 * code on disk, then how to replace it, how it was started, who can reach it
 * and what it keeps — and last the off switch, the one group whose presses end
 * the console itself. The start command and the launcher are Essentials': they
 * answer "how do I run a console", a question a person has before they have
 * one. What a settled run's CHECKOUTS become is a launch default, in
 * Automation; what becomes of this console's LOGS is here.
 */

import type { FleetProfileView } from '@/data/api';
import { useConsoleState, usePrefsSchema } from '@/data/console';
import { useMachineProfile } from '@/data/machine';
import { settingsHref } from '@/shell/routes';
import { Skeleton } from '@/ui';
import { KeyRow } from './everything';
import { ProcessBanners, ProcessGroup } from './process';
import { ReachGroup } from './reach';
import { RestartGroup } from './restart';
import { RetentionGroup } from './retention';
import { SettingsGroup } from './setting';
import { ShutdownGroup } from './shutdown';
import { UnitGroup } from './unit';

/** What this console takes from the machine profile, in one sentence. */
export function profileTakeWords(view: FleetProfileView['console']): string {
  const start =
    view.autostart === true
      ? 'This console starts at login'
      : view.autostart === 'once'
        ? 'This console starts at the next login only'
        : 'This console does not start at login';
  const fields = view.overridden;
  const over = fields.length
    ? `, and overrides the profile’s ${fields.length === 1 ? fields[0] : `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}`} with its own`
    : ', and takes every other field from the profile';
  return `${start}${over}.`;
}

/**
 * The machine profile (`fleet.json`) — fields every console on the machine
 * reads. No page writes one: each row says the value this console runs with,
 * where it came from, and the line that changes it where there is one.
 */
function ProfileGroup() {
  const schema = usePrefsSchema();
  const { data: profile } = useMachineProfile();
  const rows = (schema.data?.rows ?? []).filter((row) => row.group === 'profile');
  return (
    <SettingsGroup
      id="machine-profile"
      title="The machine profile"
      lead={
        <>
          Fields every console on this machine reads from its profile. No page writes one: a row says the
          value this console runs with and where it came from.{' '}
          <a
            href={settingsHref('everything', { q: 'profile' })}
            className="tap-line underline decoration-ink-faint underline-offset-2 hover:text-ink"
          >
            Everything lists them with every other key
          </a>
          .
        </>
      }
    >
      {schema.isPending ? (
        <Skeleton className="h-24" aria-busy="true" />
      ) : (
        <div className="flex min-w-0 flex-col gap-5" data-testid="machine-profile">
          {profile?.console && (
            <p className="max-w-(--measure) text-body text-ink" data-testid="profile-take">
              {profileTakeWords(profile.console)}
            </p>
          )}
          {rows.map((row) => (
            <KeyRow key={row.key} row={row} files={schema.data?.files} />
          ))}
        </div>
      )}
    </SettingsGroup>
  );
}

export function InstanceSection() {
  const { data: state } = useConsoleState();
  if (!state) {
    return (
      <div className="flex min-w-0 flex-col gap-3" aria-busy="true" aria-label="Reading this console">
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="instance-settings">
      <ProcessBanners state={state} />
      <div className="flex min-w-0 flex-col gap-8">
        <ProcessGroup state={state} />
        <RestartGroup />
        <UnitGroup state={state} />
        <ReachGroup
          port={state.port ?? 4123}
          remoteHosts={state.remoteHosts}
          remoteUsers={state.remoteUsers}
        />
        <RetentionGroup />
        <ProfileGroup />
        <ShutdownGroup />
      </div>
    </div>
  );
}

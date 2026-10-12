/**
 * How this console was started — its arguments and the capability switches
 * among them, read-only, each with the line that changes it (7.0's since
 * quiet-console phase 23).
 *
 * ```
 * The launch unit                                   com.phase-console.f922d743-pe-hub
 * Its node arguments are what the machine profile asks.          ~/Library/LaunchAgents/…
 * Node        --max-old-space-size=6144
 * Console     --allow-run --allow-writes … --remote
 *
 * On   --allow-run      start unattended sessions …   phase-console capability pe-hub remove --allow-run
 * Off  --allow-publish  push a finished phase's …     phase-console capability pe-hub add --allow-publish
 * ```
 *
 * No page writes a start argument: a capability is decided where the console
 * starts, and a page that could widen what its own console may do would be a
 * door the flags exist to close. So each switch is shown with the one command
 * that moves it — `phase-console capability <instance> add|remove <flag>`,
 * which edits the launch unit through the console's own unit writer, and the
 * next restart takes it (Pro: the launchd unit, read off its plist into
 * `/api/state.unitArgs`). A console started by hand has no unit: its switches
 * are the ones its start command named, which Essentials composes.
 */

import { CAPABILITY_WORDS } from '@shared/capability-model.js';
import type { ConsoleState } from '@/data/api';
import { settingsHref } from '@/shell/routes';
import {
  Mono,
} from '@/ui';
import { ArgWords, SettingsGroup } from './setting';

/** The line that turns a switch on or off in an instance's launch unit. */
export function capabilityLine(instance: string, flag: string, on: boolean): string {
  return `phase-console capability ${instance} ${on ? 'remove' : 'add'} ${flag}`;
}

/** The console's own arguments in a unit's program arguments — everything after the script. */
export function consoleArgumentsOf(unit: { programArguments: string[] | null; entry: number }): string[] {
  return unit.programArguments && unit.entry > 0 ? unit.programArguments.slice(unit.entry + 1) : [];
}

function FlagRows({
  held,
  line,
}: {
  held: (flag: string) => boolean;
  /** The command beside a switch, when one moves it. */
  line?: ((flag: string, on: boolean) => string) | undefined;
}) {
  return (
    <ul className="flex min-w-0 flex-col gap-3" aria-label="Capability switches">
      {CAPABILITY_WORDS.map((word) => {
        const on = held(word.flag);
        return (
          <li
            key={word.flag}
            className="flex min-w-0 flex-col gap-0.5"
            data-capability={word.flag}
            data-held={on}
          >
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
              <span
                className={on ? 'w-7 shrink-0 text-body text-ink' : 'w-7 shrink-0 text-body text-ink-muted'}
              >
                {on ? 'On' : 'Off'}
              </span>
              <span className="font-mono text-body text-ink">{word.flag}</span>
              <span className="min-w-0 text-meta text-ink-muted">{word.act}</span>
            </span>
            {line && <Mono value={line(word.flag, on)} copyable words className="ms-[2.375rem] min-w-0" />}
          </li>
        );
      })}
    </ul>
  );
}

export function UnitGroup({ state }: { state: ConsoleState }) {
  const field = (flag: string): boolean => {
    const word = CAPABILITY_WORDS.find((row) => row.flag === flag);
    return word ? (state as unknown as Record<string, unknown>)[word.field] === true : false;
  };
  return (
    <SettingsGroup
      id="launch-unit"
      title="What this console was started with"
      lead={
        <>
          Decided where it starts, never from a page.{' '}
          <a
            href={settingsHref('essentials')}
            className="tap-line underline decoration-ink-faint underline-offset-2 hover:text-ink"
          >
            Essentials composes the start command
          </a>{' '}
          with the switches you want.
        </>
      }
    >
      <div data-testid="launch-unit" className="flex min-w-0 flex-col gap-4">
        {state.execArgv?.length ? (
          <p className="min-w-0 text-meta text-ink-muted">
            Node{' '}
            <span className="font-mono text-ink">
              <ArgWords args={state.execArgv} />
            </span>
          </p>
        ) : null}
        <FlagRows held={field} />
      </div>
    </SettingsGroup>
  );
}

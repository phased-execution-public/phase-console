/**
 * Settings ▸ Essentials ▸ Desktop launcher (7.0, quiet-console phase 21).
 *
 * ```
 * Desktop launcher
 * A double-click that starts the console, supervised, so Restart and Shut down work.
 * [Create the Desktop launcher]   ~/Desktop/Phase Console — repo.command
 * The file is one double-clickable .command, named for this console, that starts …
 * ```
 *
 * The server writes the launcher itself (`POST /api/launcher`): one file, named
 * for this console, that starts any console registered on this machine with
 * every capability switch on and no root, port or login baked in. Where it
 * would land and whether this platform can have one is the server's answer
 * (`GET /api/launcher`), drawn as it comes — so the group renders in BOTH
 * editions: the free server answers that the launcher is not part of its
 * edition and says how to start a console instead, and that sentence is what
 * a free console shows here, rather than nothing at all.
 *
 * The one button on Settings that writes an executable, so each state it can
 * be in names its own fix: writes off (restart with the flag), a platform with
 * no launcher (no button, the server's story instead). Since launcher rev 12
 * nothing about a source directory is baked in, so an open one is not a
 * precondition. Every path is drawn `~/…`: a screenshot of Settings carries
 * no username.
 */

import { useState, type ReactNode } from 'react';
import { SETUP_PROMPTS } from '@shared/setup-prompts.js';
import { api } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { useLauncherPlan } from '@/data/machine';
import { homePath } from '@/lib/format';
import { Banner, Button, Mono, Skeleton, toast } from '@/ui';
import { SettingsGroup } from './setting';

/** Why the button is off on a read-only console — said beside it, and on hover. */
const WRITES_OFF = 'Restart with --allow-writes to write it: an executable on the Desktop is a write.';

/** The server's note, its backticked commands in the machine face. */
function noteWords(note: string): ReactNode[] {
  return note.split(/`([^`]+)`/).map((part, index) => (index % 2 ? <Mono key={index} value={part} /> : part));
}


export function LauncherGroup() {
  // Present in Pro only: the walkthrough for the same act lives in the guide.
  const lede = SETUP_PROMPTS.find((prompt) => prompt.id === 'desktop-launcher')?.lede;
  const { data: plan, error } = useLauncherPlan();
  const { data: state } = useConsoleState();
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<{ path: string; note: string } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const writes = state?.allowWrites === true;
  const shownPath = homePath(plan?.path, state?.home);

  const write = () => {
    setWriting(true);
    setRefused(null);
    api
      .createLauncher()
      .then((outcome) => {
        setWritten({ path: outcome.path, note: outcome.note });
        toast('Desktop launcher written, with every capability on.', 'ok');
      })
      .catch((cause: unknown) =>
        setRefused(
          cause instanceof Error && cause.message ? cause.message : 'The write failed and said nothing.',
        ),
      )
      .finally(() => setWriting(false));
  };

  return (
    <SettingsGroup id="launcher" title="Desktop launcher" lead={lede}>
      {error ? (
        <p className="max-w-(--measure) text-body text-ink-muted">
          Where a launcher would go could not be read: {error.message}
        </p>
      ) : !plan ? (
        <div aria-busy="true" data-testid="launcher-loading">
          <Skeleton className="h-16" />
        </div>
      ) : plan.supported ? (
        <div className="flex min-w-0 flex-col gap-3" data-testid="launcher-create">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <Button
              disabled={writing || !writes}
              title={
                writes
                  ? `Writes ${shownPath ?? 'the file'}: one launcher, named for this console, that starts any registered console with every capability switch.`
                  : WRITES_OFF
              }
              onClick={write}
            >
              {writing ? 'Writing…' : 'Create the Desktop launcher'}
            </Button>
            {shownPath ? <Mono value={shownPath} className="min-w-0 wrap-anywhere" /> : null}
          </div>
          {!writes ? <p className="max-w-(--measure) text-meta text-ink-muted">{WRITES_OFF}</p> : null}
          <p className="max-w-(--measure) text-meta text-ink-muted">
            {/* A FRAGMENT around the Pro words: prettier pulls a marker comment up
                onto a bare element's line, and a marker that is not its own line
                leaves the region open in the free tree. */}
            <>{noteWords(written ? written.note : plan.note)}</>
          </p>
          {written ? (
            <p className="text-body text-ink" data-testid="launcher-written">
              Written to{' '}
              <Mono value={homePath(written.path, state?.home) ?? written.path} className="wrap-anywhere" />.
            </p>
          ) : null}
          {refused ? <Banner severity="error">The launcher was not written: {refused}</Banner> : null}
        </div>
      ) : (
        <Banner severity="info" data-testid="launcher-unsupported">
          {noteWords(plan.note)}
        </Banner>
      )}

    </SettingsGroup>
  );
}

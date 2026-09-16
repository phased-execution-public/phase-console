/**
 * The Desktop launcher card.
 *
 * It sits next to *This process* because that is where the question arrives:
 * the Restart button refuses when nothing is supervising this console, and the
 * refusal explains the cause without giving you a way to fix it. The Create
 * button answers it directly: the server writes the launcher itself — one file,
 * named for this console, that starts any console registered on this machine,
 * with every capability switch on and no root, port or login baked in. The paste-
 * into-Claude walkthrough for the same act lives in the guide and the README
 * (`shared/setup-prompts.js`), not here — a page with a working button does
 * not also need the manual procedure beside it.
 */

import { useState } from 'react';
import { SETUP_PROMPTS } from '@shared/setup-prompts.js';
import { api } from '@/lib/api';
import { toastError, useConsoleState, useLauncherPlan } from '@/lib/queries';
import { Banner, Button, Card, CardBody, CardHeader, CardTitle, toast } from '@/components/ui';
import { homePath } from '@/lib/format';

export function LauncherCard({ supervised }: { supervised?: boolean }) {
  const setup = SETUP_PROMPTS.find((p) => p.id === 'desktop-launcher');
  const { data: plan } = useLauncherPlan();
  const { data: state } = useConsoleState();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ path: string; note: string } | null>(null);
  // No prompt, no card. That is also the tier split: the `desktop-launcher`
  // entry sits in a marker region, so the free tree — which ships neither the
  // template nor a platform `launcherPlan` supports — draws nothing here rather
  // than a card advertising something it does not have.
  if (!setup) return null;

  // "$HOME/…" in the shown path, same rule as the start-command card: portable
  // to read, no username in a screenshot.
  const shownPath = homePath(plan?.path, state?.home);

  const create = () => {
    setCreating(true);
    api
      .createLauncher()
      .then((outcome) => {
        setCreated({ path: outcome.path, note: outcome.note });
        toast('Desktop launcher written — every capability on.', 'ok');
      })
      .catch(toastError)
      .finally(() => setCreating(false));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{setup.title}</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {/* The server writes the launcher itself — named for this console,
            all seven switches on, no root, port or login baked in. */}
        {plan?.supported ? (
          <div className="flex flex-col gap-2 rounded border border-rule bg-ground-deep p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="action"
                disabled={creating || state?.allowWrites !== true}
                title={
                  state?.allowWrites !== true
                    ? 'Restart with --allow-writes — writing an executable to the Desktop is a write.'
                    : `Writes ${shownPath ?? 'the launcher'}: one launcher, named for this console, that starts any registered console with every capability switch.`
                }
                onClick={create}
              >
                {creating ? 'Writing…' : 'Create the Desktop launcher — full options'}
              </Button>
              {shownPath ? <code className="text-2xs text-ink-faint">{shownPath}</code> : null}
            </div>
            <p className="m-0 text-2xs text-ink-faint">
              {plan.platform === 'darwin' ? (
                <>
                  macOS: one double-clickable .command, named for this console, that starts any console
                  registered on this machine with{' '}
                  {(plan.fullFlags ?? []).map((flag) => (
                    <code key={flag} className="mr-1">
                      {flag}
                    </code>
                  ))}
                  on — no root, port or login baked in: each console&rsquo;s root and port come from the
                  registry, and remote access from the machine profile.
                </>
              ) : (
                'Linux: an XDG .desktop entry that runs the start command — full flag set — in a terminal.'
              )}{' '}
              {created ? created.note : plan.note}
            </p>
            {created ? (
              <p className="m-0 text-2xs text-ink-muted">
                Written to <code>{created.path}</code>.
              </p>
            ) : null}
          </div>
        ) : plan ? (
          <Banner severity="info">{plan.note}</Banner>
        ) : null}

        <p className="text-sm text-ink-muted">{setup.lede}</p>

        {supervised === false && (
          <Banner severity="warn">
            Nothing is supervising this console: Restart starts a successor by itself, but a crash would not
            come back. A launcher started with <code>SUPERVISED="yes"</code> installs a launchd agent, and a
            clean exit or a crash comes straight back.
          </Banner>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * "Your restart stopped these runs — shall I pick them up?"
 *
 * Until 3.5.0 a console restart was silently a *launch*: every run the restart
 * had interrupted started spending again the moment the process was back. That
 * is the right behaviour for an unattended fleet and a startling one for a
 * person, because restarting a console is something you do to change a setting
 * or pick up a new build — and the first thing it did was board sessions
 * nobody asked for, against accounts with real money on them, before the
 * operator had finished reading the page.
 *
 * So the console asks. `resumeAtBoot: 'ask'` is the shipped default; the
 * convergence loop defers instead of relaunching, registers the runs, and this
 * is what puts them in front of whoever opens the app next.
 *
 * Three properties worth keeping:
 *
 * **It is a question, not an errand.** Nothing is written to the runs and no
 * inbox row is raised — an errand is a job somebody owes, and this is a choice
 * only the person in front of the console can make. Dismissing it leaves the
 * runs exactly as the restart left them, ready for the ordinary Continue
 * button whenever they get to it.
 *
 * **It asks once per console boot.** The answer lives in the server's memory,
 * not on disk, because a restart is precisely the event that makes the
 * question new again — see `Service.resumeAsks`.
 *
 * **It is not a route.** Like the palette and the help sheet, it is state over
 * the shell rather than an address, because it must be answerable from
 * wherever the operator happens to land.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useConsoleState } from '@/lib/queries';
import { AlertDialog, AlertDialogContent } from '@/components/ui';

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function ResumeAsk() {
  const { data: state } = useConsoleState();
  // Answering hides it for this page's lifetime as well as the server's, so
  // the dialog cannot flicker back between the POST and the next state poll.
  const [answered, setAnswered] = useState(false);
  const queryClient = useQueryClient();

  const decide = useMutation({
    mutationFn: (decision: 'continue' | 'dismiss') => api.bootResume(decision),
    onSuccess: () => {
      setAnswered(true);
      void queryClient.invalidateQueries({ queryKey: ['state'] });
    },
    // A failed answer must not leave the dialog stuck open with no way past
    // it: the runs are untouched either way, and the question comes back on
    // the next boot.
    onError: () => setAnswered(true),
  });

  const asks = state?.resumeAsk ?? [];
  if (answered || asks.length === 0) return null;

  const phases = asks.reduce((n, ask) => n + ask.phases.length, 0);
  const slugs = [...new Set(asks.map((ask) => ask.slug))];

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) decide.mutate('dismiss');
      }}
    >
      <AlertDialogContent
        title={`Continue ${asks.length} interrupted ${plural(asks.length, 'run')}?`}
        confirmLabel={decide.isPending ? 'Starting…' : 'Continue them'}
        cancelLabel="Not now"
        onConfirm={() => decide.mutate('continue')}
      >
        <p className="mt-2 text-sm text-ink-muted">
          This console restarted while {asks.length === 1 ? 'a run was' : 'these runs were'} working.
          Continuing picks {asks.length === 1 ? 'it' : 'them'} up where the restart left off — resuming each
          phase&apos;s own session where it still exists — and that means spending again, unattended, on
          whichever account the run is set to.
        </p>
        <ul className="mt-3 flex flex-col gap-1">
          {asks.map((ask) => (
            <li key={ask.runId} className="text-2xs text-ink">
              <code className="rounded bg-surface-raised px-1 font-mono">{ask.slug}</code>{' '}
              <span className="text-ink-muted">
                {ask.phases.length
                  ? `${plural(ask.phases.length, 'phase')} ${ask.phases.join(', ')}`
                  : 'nothing boarded yet'}
                {ask.sessions.length
                  ? ` · ${ask.sessions.length} ${plural(ask.sessions.length, 'session')} to resume`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-2xs text-ink-faint">
          <b>Not now</b> changes nothing: the {plural(phases || asks.length, 'run')} stay exactly as the
          restart left {asks.length === 1 ? 'it' : 'them'}, and Continue on{' '}
          {slugs.length === 1 ? 'the run page' : 'each run page'} still works whenever you want it. This
          question is asked once per console start — Settings ▸ Automation ▸{' '}
          <i>Resume killed lanes at boot</i> switches it to <b>Always</b> (the old behaviour) or <b>Never</b>.
        </p>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * "Your restart stopped these runs — shall I pick them up?"
 *
 * A console restart used to be silently a *launch*: every run the restart had
 * interrupted started spending again the moment the process was back. So the
 * console asks (`resumeAtBoot: 'ask'`), once per boot, from wherever the
 * person lands — state over the shell, not a route. **A question, not an
 * errand**: nothing is written to the runs and no inbox row is raised, and
 * dismissing it leaves the runs exactly as the restart left them.
 *
 * Loaded only while there is something to ask (`App.tsx`): a dialog first
 * paint is not showing costs it nothing.
 */

import { useState } from 'react';
import { Button } from '@/ui';
import { Dialog, DialogContent, DialogFooter } from '@/ui/dialog';
import { useBootResume, useConsoleState } from '@/data/console';

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export default function ResumeAsk() {
  const { data: state } = useConsoleState();
  // Answering hides it for this page's lifetime as well as the server's, so
  // the dialog cannot flicker back between the POST and the next state read.
  // A failed answer must not leave it stuck open either: the runs are untouched
  // either way, and the question comes back on the next boot.
  const [answered, setAnswered] = useState(false);
  const decide = useBootResume();

  const asks = state?.resumeAsk ?? [];
  if (answered || asks.length === 0) return null;

  const answer = (decision: 'continue' | 'dismiss') =>
    decide.mutate(decision, { onSettled: () => setAnswered(true) });
  const slugs = [...new Set(asks.map((ask) => ask.slug))];

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) answer('dismiss');
      }}
    >
      <DialogContent
        title={`Continue ${asks.length} interrupted ${plural(asks.length, 'run')}?`}
        description={`This console restarted while ${asks.length === 1 ? 'a run was' : 'these runs were'} working.`}
      >
        <p className="text-body text-ink-muted">
          Continuing picks {asks.length === 1 ? 'it' : 'them'} up where the restart left off — resuming each
          phase&apos;s own session where it still exists — and that means spending again, unattended, on
          whichever account the run is set to.
        </p>
        <ul className="mt-3 flex flex-col gap-1">
          {asks.map((ask) => (
            <li key={ask.runId} className="text-meta text-ink">
              <code className="rounded bg-surface-raised px-1 font-mono">{ask.slug}</code>{' '}
              <span className="text-ink-muted">
                {ask.phases.length
                  ? `${plural(ask.phases.length, 'phase')} ${ask.phases.join(', ')}`
                  : 'nothing boarded yet'}
                {ask.sessions.length
                  ? `, ${ask.sessions.length} ${plural(ask.sessions.length, 'session')} to resume`
                  : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-meta text-ink-faint">
          Not now changes nothing: the {plural(asks.length, 'run')} stay exactly as the restart left{' '}
          {asks.length === 1 ? 'it' : 'them'}, and Continue on{' '}
          {slugs.length === 1 ? 'the run page' : 'each run page'} still works whenever you want it. Settings ▸
          Automation ▸ Resume killed lanes at boot switches this question to Always or Never.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer('dismiss')} disabled={decide.isPending}>
            Not now
          </Button>
          <Button variant="primary" onClick={() => answer('continue')} disabled={decide.isPending}>
            {decide.isPending ? 'Starting…' : 'Continue them'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Essentials — the front door.
 *
 * Six answers, in the order somebody who has just opened Settings needs them:
 * what directory this console is reading, what it is ALLOWED to do, the line
 * that starts one with everything, how to install that line as a launcher, the
 * engine behind every status, and the keys.
 *
 * Three of these were the 2.x *General* section and three were buried under a
 * heading called *This process* — which is where an operator looking for "how
 * do I turn runs on" would never look, because it names an implementation
 * rather than a question. The regrouping is the point of the section: the
 * settings index is read top to bottom by someone who does not yet know which
 * section holds their answer, so the FIRST section has to be the one that
 * answers the most common ones.
 *
 * **Nothing here is a second control.** The capability card reads flags that
 * only a restart can change and links to the sections that use them; the
 * automation row links to Automation rather than repeating a toggle. Two
 * controls for one preference disagree the day their fallbacks do — the
 * invariant `automation-coverage.test.tsx` enforces one level down.
 */

import { navigate } from '@/app/router';
import { useConsoleState } from '@/lib/queries';
import { weight } from '@/lib/format';
import { settingsHref } from '@/app/routes';
import { Button, Card, CardBody, CardHeader, CardTitle, KeyValue, Skeleton } from '@/components/ui';
import { SettingsSectionFrame, sectionFor } from './nav';
import { CAPABILITIES, StartCommandCard } from './start-command';
import { LauncherCard } from './launcher';

/**
 * What each switch actually unlocks, and where that lives.
 *
 * The flag names are in `start-command.tsx` because the command is composed
 * from them; the MEANINGS are here because this is the only surface that
 * explains them. Keyed off the same array, so a capability cannot be added to
 * the start command and stay unexplained — the defect `--allow-mcp` already
 * had once, when it was parsed, exposed, and named nowhere a person reads.
 */
const UNLOCKS: Record<string, { does: string; where?: string }> = {
  allowWrites: { does: 'Scaffold plans and handoffs, record QA, take locks. Never commits or pushes.' },
  allowRun: { does: 'Spawn unattended sessions that edit a repository for hours.', where: 'automation' },
  allowTerminal: { does: 'Open a real shell in the browser.' },
  allowAgent: { does: 'Run interactive Claude sessions and the plan wizard.' },
  allowAccounts: {
    does: 'Register accounts and pick one per run. Reading the meters never needs it.',
    where: 'accounts',
  },
  allowMcp: {
    does: 'Register MCP servers and hold their credentials. Reading the registry never needs it.',
    where: 'mcp',
  },
  allowWebhooks: {
    does: 'POST every announcement to the URLs you register — the only switch that sends anything off this machine.',
    where: 'notifications',
  },
};

export function EssentialsSection() {
  const { data: state } = useConsoleState();
  const section = sectionFor('essentials')!;

  if (!state) {
    return (
      <SettingsSectionFrame section={section}>
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </SettingsSectionFrame>
    );
  }

  const repo = state.repo;
  const dirty = repo?.dirty ?? [];

  return (
    <SettingsSectionFrame section={section}>
      <Card>
        <CardHeader>
          <CardTitle>Source</CardTitle>
          <Button size="sm" onClick={() => navigate('source')}>
            Change
          </Button>
        </CardHeader>
        <CardBody>
          <KeyValue
            items={[
              ['Directory', <code key="d">{state.root?.path}</code>],
              ['Plans', `${state.root?.planCount ?? 0} files in docs/plans`],
              ['Handoff folders', String(state.root?.handoffCount ?? 0)],
              [
                'Repository',
                repo?.available
                  ? `${repo.branch}${repo.ahead ? ` · ${repo.ahead} ahead` : ''}${repo.behind ? ` · ${repo.behind} behind` : ''}`
                  : 'not a git repository',
              ],
              [
                'Uncommitted under docs/',
                dirty.length ? (
                  <span key="u" className="font-mono text-2xs break-words">
                    {dirty.slice(0, 6).join(', ')}
                    {dirty.length > 6 ? ` +${dirty.length - 6}` : ''}
                  </span>
                ) : (
                  'none'
                ),
              ],
              ['Indexed sections', String(state.searchDocs ?? 0)],
            ]}
          />
        </CardBody>
      </Card>

      <CapabilitiesCard />

      {/* Directly under the list of what is off: this is the line that turns
          any of it on, and *This instance* is where Restart refuses without it. */}
      <StartCommandCard />

      <LauncherCard supervised={state.supervisor?.supervised} />

      <Card>
        <CardHeader>
          <CardTitle>Engine</CardTitle>
        </CardHeader>
        <CardBody>
          <KeyValue
            items={[
              ['Scripts', <code key="s">{state.scriptsDir}</code>],
              [
                'Phase weights',
                `S ${weight(state.sizing?.S)} · M ${weight(state.sizing?.M)} · L ${weight(state.sizing?.L)}`,
              ],
              [
                'Session budgets',
                `1M-class ${weight(state.sizing?.budgetBig)} · 200K-class ${weight(state.sizing?.budgetHaiku)}`,
              ],
            ]}
          />
          <p className="mt-3 text-2xs text-ink-faint">
            Status, session batches, boot prompts and lint always come from these scripts. The console parses
            the markdown only for the parts they do not expose.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Keyboard</CardTitle>
        </CardHeader>
        <CardBody>
          {/* Three keys, not eight. The 2.x list was seven single-letter jumps
              that had to be memorised from a card you had to remember to
              visit; the palette replaced all of them with one chord that shows
              you its own contents — and prints the chord on itself, in the
              header, on every page. What is left here is what the palette
              cannot document from inside itself. */}
          <KeyValue
            items={[
              ['⌘ K', 'search and commands'],
              ['/', 'the same, without a modifier'],
              ['Esc', 'close a dialog, sheet or the palette'],
            ]}
          />
        </CardBody>
      </Card>
    </SettingsSectionFrame>
  );
}

/**
 * What this console may do — the seven switches, plus whether it runs work by
 * itself.
 *
 * A read-out, not a control: every one of these is decided at launch and can
 * only change by restarting, which is exactly why they were previously
 * invisible. The console's whole posture — "it can read but never write", "it
 * can spawn sessions but not register accounts" — was a fact you could only
 * learn by hitting a disabled button and reading the refusal.
 *
 * `Off` is drawn as the plain, calm state rather than an alarm. Six of the
 * seven off is the correct, safe shipping default; painting the default red
 * teaches people to ignore the colour.
 */
function CapabilitiesCard() {
  const { data: state } = useConsoleState();
  if (!state) return null;

  // The console runs work by itself only when BOTH are true: the flag that
  // permits spawning, and a convergence loop that has not been switched off.
  // Saying "on" for `--allow-run` alone would claim a console with
  // `--no-converge` boards phases by itself, which it does not.
  const runsWork = state.allowRun === true && state.autopilot !== false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>What this console may do</CardTitle>
        <span className="text-2xs text-ink-faint">decided at launch</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <ul className="flex min-w-0 flex-col gap-2">
          {CAPABILITIES.map(([key, flag]) => {
            const on = state[key] === true;
            const unlock = UNLOCKS[key];
            return (
              <li key={key} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
                {/* The word, not a colour: a badge that says "on" survives a
                    greyscale screenshot, a colour-blind reader and a phone in
                    daylight. `tnum` keeps the two words the same width so the
                    second column starts on one pixel down the whole list. */}
                <span
                  className={
                    on
                      ? 'tnum w-8 text-2xs font-medium text-ink'
                      : 'tnum w-8 text-2xs font-medium text-ink-faint'
                  }
                >
                  {on ? 'on' : 'off'}
                </span>
                <code className="min-w-0 truncate text-xs text-ink">{flag}</code>
                <span aria-hidden />
                <span className="min-w-0 text-2xs text-ink-faint">
                  {unlock?.does}
                  {unlock?.where && (
                    <>
                      {' '}
                      <a href={settingsHref(unlock.where)} className="text-action underline">
                        Open {sectionFor(unlock.where)?.title ?? unlock.where}
                      </a>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-rule pt-3 text-sm text-ink-muted">
          {runsWork ? (
            <>
              This console <strong className="text-ink">boards phases by itself</strong> — the convergence
              loop retries what stops and the ladder decides how far.{' '}
              <a href={settingsHref('automation')} className="text-action underline">
                Automation
              </a>{' '}
              holds every budget and threshold it obeys.
            </>
          ) : state.allowRun === true ? (
            <>
              Sessions may be spawned, but the convergence loop is off (<code>--no-converge</code>), so
              nothing boards without a press.{' '}
              <a href={settingsHref('automation')} className="text-action underline">
                Automation
              </a>{' '}
              still holds what a press then obeys.
            </>
          ) : (
            <>
              This console runs nothing by itself. Everything below is what it <em>would</em> obey with{' '}
              <code>--allow-run</code> —{' '}
              <a href={settingsHref('automation')} className="text-action underline">
                Automation
              </a>
              .
            </>
          )}
        </div>

        <p className="text-2xs text-ink-faint">
          A switch changes nothing until a console restarts with it. The command below carries all seven.
        </p>
      </CardBody>
    </Card>
  );
}

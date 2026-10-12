/**
 * Decisions (ZTD-2, QRL-2) — everything a run could ask a person mid-run,
 * asked here before anything starts.
 *
 * The section renders the decision manifest as the console resolves it for
 * THIS draft — every row with its state and where its answer came from — the
 * pre-spawn probes (accounts, MCP, credentials, delivery, verification, the
 * shared checkout, the plan's git lines, your turns) with their verdicts, and
 * the answers the door requires: whether to continue after a console restart,
 * whether the relay is armed, and an acknowledgement of every waived row.
 * Launch stays disabled while a blocking row is outstanding and the footer
 * names it; the one way past that is the override, which records who signed it
 * (`run.manifest-override`).
 *
 * The prelude is asked of the server (`GET /api/run/:slug/prelude`) with the
 * draft's answers, so what this shows is what the start door will judge — one
 * computation, not a client-side imitation of it.
 *
 * The live settings sheet shows the restart and relay answers too, and nothing
 * else of this: a run already through the door has no prelude to ask, so there
 * are no probes, no manifest and nothing that could hold the Apply button.
 */

import type { Prelude, PreludeRow, ProbeVerdict, VerificationDetail } from '@/data/api';
import { cn } from '@/lib/cn';
import { Button, Input, SectionHeading } from '@/ui';
import { OpsStatus, type WordOf } from '@/ui/status';
import { DECISION_STATES } from '@shared/decisions-model.js';
import { RELAY_MODES } from '@shared/run-settings.js';
import { SelectField, SetupField, ToggleField } from './fields';
import { useSetupForm } from './form-context';
import { useDraftPrelude } from './model/facts';
import { runsPrelude } from './model/modes';

// The draft's prelude is the launch model's; the sections that ask it read it here.
export { preludeDraft, useDraftPrelude } from './model/facts';

const RELAY_LABELS: Record<(typeof RELAY_MODES)[number], string> = {
  off: 'Off — the console never answers a question on a person’s behalf',
  'last-resort': 'Last resort — a person is paged first; after 60 s the console answers by rule',
};

/** Every probe the section lists, in the prelude's order. */
const PROBE_LABELS: Record<keyof Prelude['probes'], string> = {
  accounts: 'Accounts',
  mcp: 'MCP servers',
  credentials: 'Credentials',
  delivery: 'Delivery channel',
  verification: 'Verification commands',
  trees: 'Shared checkout',
  'git-strategy': 'Plan git lines',
  'human-steps': 'Your turns',
};

/** A word of the manifest's closed vocabulary — the status family draws it; anything else is the plan's own text. */
const isDecisionState = (word: string): word is WordOf<'decision'> =>
  (DECISION_STATES as readonly string[]).includes(word);

/** Where a manifest row's answer came from, in the operator's words. */
function originWords(origin: string): string {
  if (origin === 'plan') return 'from the plan';
  if (origin === 'run') return 'from this launch';
  return 'the shipped default';
}

export function Decisions() {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <DecisionsSection />
    </div>
  );
}

/**
 * The controls and the manifest — one section, rendered by the Decisions
 * category and by the flat layout, and nothing when the mode asks neither the
 * restart nor the relay answer.
 */
export function DecisionsSection() {
  const f = useSetupForm();
  const { data: prelude, isLoading, error } = useDraftPrelude();
  if (!f.on('resumeOnRestart') && !f.on('relay')) return null;
  // A launch passes the door; a live run already did, and edits its answers.
  const door = runsPrelude(f.mode);

  const rows: PreludeRow[] = prelude?.rows ?? [];
  const blocking = prelude?.blocking ?? [];
  const waivedRows = rows.filter((row) => row.state === 'waived');
  const deliveryFailed = prelude?.probes.delivery.status === 'fail';
  const acknowledged = new Set(f.values.acknowledgedWaivers);
  const toggleAck = (key: string, on: boolean) => {
    const next = new Set(f.values.acknowledgedWaivers);
    if (on) next.add(key);
    else next.delete(key);
    f.set('acknowledgedWaivers', [...next]);
  };
  // A signed override lets Launch through, so the open rows stop holding it.
  const signed = Boolean(f.values.manifestOverride.trim());

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {blocking.length > 0 && (
        <div
          role="status"
          data-testid="decisions-blocking"
          // The one amber here, and only while the open rows hold Launch.
          className={cn(
            'flex min-w-0 flex-col gap-1 border-s-2 ps-3 text-body',
            signed ? 'border-rule-strong' : 'state-needs-you border-state',
          )}
        >
          <p className="font-medium text-ink">
            {blocking.length === 1
              ? 'One decision is still open'
              : `${blocking.length} decisions are still open`}
            {signed
              ? ' — the start will be recorded as an override'
              : ' — Launch is disabled until each is answered'}
          </p>
          <ul className="flex min-w-0 list-disc flex-col gap-0.5 ps-5 text-ink-muted">
            {blocking.map((b) => (
              <li key={`${b.key}:${b.why}`} className="min-w-0 break-words">
                <code className="font-mono text-meta text-ink">{b.key}</code> — {b.why}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="flex min-w-0 flex-col gap-3">
        <SectionHeading as="h4">
          {door ? 'What the door requires' : 'Restarts, questions and accounts'}
        </SectionHeading>
        {f.on('resumeOnRestart') && (
          <ToggleField
            label="If the console restarts, continue this run"
            hint={
              <>
                The run’s own answer to the <code className="font-mono">resume.on-restart</code> row. On: a
                lane a restart cut off resumes its session by itself. Off: the run waits for a person, with
                one errand naming it — and is never asked again at every boot.
              </>
            }
            value={f.values.resumeOnRestart}
            onChange={(next) => f.set('resumeOnRestart', next)}
          />
        )}
        {f.on('relay') && (
          <SelectField
            label="Relay questions to a person"
            hint="The relay row. Off until phase 14 arms it; last resort pages a person and, unanswered after the window, answers by the rule table."
            source={f.src('relay')}
            effect={f.fx('relay')}
            value={f.values.relay}
            options={RELAY_MODES.map((mode) => [mode, RELAY_LABELS[mode]] as const)}
            onChange={(next) => f.set('relay', next as (typeof RELAY_MODES)[number])}
          />
        )}
        {/* The plan's git lines are answered in the Git category's reconcile
            panel, and the account pool beside the account — each where its
            question is. */}
      </section>

      {door && (
        <>
          <section className="flex min-w-0 flex-col gap-3">
            <SectionHeading as="h4">What the probes found</SectionHeading>
            {isLoading && !prelude && <p className="text-meta text-ink-muted">Asking the console…</p>}
            {error && (
              <p className="text-meta text-failed">
                The prelude could not be read: {(error as Error).message}
              </p>
            )}
            {prelude && (
              <ul className="flex min-w-0 flex-col gap-1.5 text-body" aria-label="Probe verdicts">
                {(Object.keys(PROBE_LABELS) as (keyof Prelude['probes'])[]).map((id) => {
                  const verdict = prelude.probes[id];
                  // A console older than a probe does not answer it.
                  if (!verdict) return null;
                  return (
                    <li
                      key={id}
                      // The verdict, the probe and its reason; below 640 the
                      // reason drops under the probe's name.
                      className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 sm:grid-cols-[5.5rem_10rem_minmax(0,1fr)]"
                    >
                      <OpsStatus vocab="probe" word={verdict.status} />
                      <span className="min-w-0 text-ink">{PROBE_LABELS[id]}</span>
                      <span className="col-start-2 min-w-0 break-words text-meta text-ink-muted sm:col-start-auto">
                        {verdict.reason}
                      </span>
                      {verdict.warnings?.length ? (
                        <ul className="col-start-2 min-w-0 list-disc ps-5 text-meta text-ink-muted sm:col-start-3">
                          {verdict.warnings.map((w) => (
                            <li key={w} className="break-words">
                              {w}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {prelude && deliveryFailed && f.on('acknowledgedWaivers') && (
              <ToggleField
                label="Start anyway with no delivery channel"
                hint={
                  <>
                    Nobody will hear this run’s announcements — no subscribed device, no notify command, no
                    webhook. Acknowledging records the <code className="font-mono">announce</code> row as
                    waived for this run.
                  </>
                }
                value={acknowledged.has('announce')}
                onChange={(next) => toggleAck('announce', next)}
              />
            )}
          </section>

          {prelude && f.on('verifyAnswers') && <VerificationAnswers verdict={prelude.probes.verification} />}

          {prelude && (
            <section className="flex min-w-0 flex-col gap-3">
              <SectionHeading as="h4">The manifest</SectionHeading>
              {!prelude.manifestPresent && (
                <p className="max-w-(--measure) text-meta text-ink-muted">
                  This plan writes no <code className="font-mono">## Decisions</code> section, so every row
                  below is the console’s own answer — the launch form’s, the plan’s other lines, or the
                  shipped default. Only a row the plan writes can hold a start.
                </p>
              )}
              <ul className="flex min-w-0 flex-col gap-2.5" aria-label="Decision manifest">
                {rows.map((row) => (
                  <li key={`${row.key}:${row.state}`} className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <code className="min-w-0 wrap-anywhere font-mono text-meta text-ink">{row.key}</code>
                      {/* A word of the closed vocabulary is a dot and a word; a
                          state the plan misspelt is its own text, breakable,
                          never dressed as a word this console knows. */}
                      {isDecisionState(row.state) ? (
                        <OpsStatus vocab="decision" word={row.state} />
                      ) : (
                        <span className="min-w-0 wrap-anywhere text-meta text-ink-muted">{row.state}</span>
                      )}
                      {row.blocking === 'yes' && (
                        <span className="text-meta text-ink-muted">blocks a start</span>
                      )}
                      <span className="text-meta text-ink-muted">{originWords(row.origin)}</span>
                      {row.owner && row.state === 'outstanding' && (
                        <span className="min-w-0 break-words text-meta text-ink-muted">
                          owed by {row.owner}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 break-words text-meta text-ink-muted">{row.value || '—'}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {prelude && waivedRows.length > 0 && f.on('acknowledgedWaivers') && (
            <section className="flex min-w-0 flex-col gap-2">
              <SectionHeading as="h4">Acknowledged waivers</SectionHeading>
              <p className="max-w-(--measure) text-meta text-ink-muted">
                The plan waived these rows. Each needs a reader’s acknowledgement before the run starts.
              </p>
              {waivedRows.map((row) => (
                <ToggleField
                  key={row.key}
                  label={
                    <>
                      <code className="font-mono">{row.key}</code> — waived
                    </>
                  }
                  hint={row.value || 'no reason given'}
                  value={acknowledged.has(row.key)}
                  onChange={(next) => toggleAck(row.key, next)}
                />
              ))}
            </section>
          )}

          {f.on('manifestOverride') && blocking.length > 0 && (
            <SetupField
              label="Start anyway, recorded as"
              hint={
                <>
                  The one way past a blocking row, and it is recorded:{' '}
                  <code className="font-mono">run.manifest-override</code> names who signed it and which rows
                  were open. Type your name to enable Launch; leave it empty to answer the rows instead.
                </>
              }
              source={f.src('manifestOverride')}
              effect={f.fx('manifestOverride')}
            >
              <Input
                value={f.values.manifestOverride}
                placeholder="your name"
                onChange={(event) => f.set('manifestOverride', event.target.value)}
              />
            </SetupField>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The fifth probe's answers: every §Verification command the run would stop on
 * for a person, answered here once. Approve the exact command where an approval
 * can make it run — every other check still judges it — or waive a check for
 * this run. The prelude is re-asked with each answer, so what this shows is
 * what the start door will judge, and nothing is asked mid-run.
 */
function VerificationAnswers({ verdict }: { verdict: ProbeVerdict | undefined }) {
  const f = useSetupForm();
  const detail = verdict?.detail as VerificationDetail | undefined;
  const reviews = detail?.reviews ?? [];
  const answers = f.values.verifyAnswers;
  const open = reviews.flatMap((review) => review.items.map((item) => ({ phase: review.phase, item })));
  const setAside = reviews.flatMap((review) => review.waived.map((item) => ({ phase: review.phase, item })));
  // Approved commands leave `items` for `runs`, so they are listed from the
  // resolved answers — still shown, still checked, still revocable.
  const approved = (detail?.answers?.approve ?? []).filter(
    (entry) => !open.some(({ item }) => item.fp === entry.fp),
  );
  if (!open.length && !approved.length && !setAside.length) return null;

  const approve = new Set(answers.approve);
  const waive = new Set(answers.waive);
  const toggle = (list: 'approve' | 'waive', key: string, on: boolean) => {
    const next = new Set(list === 'approve' ? approve : waive);
    if (on) next.add(key);
    else next.delete(key);
    f.set('verifyAnswers', { ...answers, [list]: [...next] });
  };
  const approvable = open.filter(({ item }) => item.approvable && item.fp).map(({ item }) => item.fp!);

  return (
    <section className="flex min-w-0 flex-col gap-2" aria-label="Verification commands">
      <SectionHeading as="h4">Verification commands</SectionHeading>
      <p className="max-w-(--measure) text-meta text-ink-muted">
        {verdict?.reason ?? ''} — the runner judges every §Verification command before a session is bought.
        Approve an exact command to let it run (the deny wall and the off-machine checks still apply), or
        waive a check for this run. An answer is bound to the command&rsquo;s exact text: a plan edited later
        is asked again.
      </p>
      {approvable.length > 1 && (
        <Button
          size="sm"
          className="self-start"
          onClick={() =>
            f.set('verifyAnswers', {
              ...answers,
              approve: [...new Set([...answers.approve, ...approvable])],
            })
          }
        >
          Approve all {approvable.length}
        </Button>
      )}
      <ul className="flex min-w-0 flex-col gap-1" aria-label="Verification answers">
        {open.map(({ phase, item }) => {
          if (!item.fp) return null;
          const fp = item.fp;
          return (
            <li key={`${phase}:${fp}`}>
              <ToggleField
                label={
                  <>
                    {item.approvable ? 'Approve ' : 'Waive for this run: '}
                    <code className="wrap-anywhere font-mono text-ink">{item.text}</code>
                  </>
                }
                hint={`phase ${phase} — ${item.reason}${
                  item.approvable ? '' : ' — no approval can make it run; fix the plan to prove it instead'
                }`}
                value={item.approvable ? approve.has(fp) : waive.has(`${phase}:${fp}`)}
                onChange={(next) =>
                  item.approvable ? toggle('approve', fp, next) : toggle('waive', `${phase}:${fp}`, next)
                }
              />
            </li>
          );
        })}
        {approved.map((entry) => (
          <li key={`approved:${entry.fp}`}>
            <ToggleField
              label={
                <>
                  Approve <code className="wrap-anywhere font-mono text-ink">{entry.text}</code>
                </>
              }
              hint="approved — it runs with every other check"
              value={approve.has(entry.fp)}
              onChange={(next) => toggle('approve', entry.fp, next)}
            />
          </li>
        ))}
        {setAside.map(({ phase, item }) => {
          if (!item.fp) return null;
          const key = `${phase}:${item.fp}`;
          return (
            <li key={`waived:${key}`}>
              <ToggleField
                label={
                  <>
                    Waive for this run: <code className="wrap-anywhere font-mono text-ink">{item.text}</code>
                  </>
                }
                hint={`phase ${phase} — set aside, recorded on the run`}
                value={waive.has(key)}
                onChange={(next) => toggle('waive', key, next)}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

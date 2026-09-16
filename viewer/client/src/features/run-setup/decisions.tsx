/**
 * Stage 0 — Decisions (phase 11 of zero-touch-console; ZTD-2, QRL-2).
 *
 * Everything a run could ask a person mid-run, asked here before anything
 * starts. The stage renders the decision manifest as the console resolves it
 * for THIS draft — every row with its state and where its answer came from —
 * the four pre-spawn probes (accounts, MCP, credentials, delivery) with their
 * verdicts, and the answers the door requires: whether to continue after a
 * console restart, whether the relay is armed, which accounts the run may
 * spend and how much headroom each must show, and an acknowledgement of every
 * waived row. Launch stays disabled while a blocking row is outstanding and
 * the footer names it; the one way past that is the override control, which
 * records who signed it (`run.manifest-override`).
 *
 * The prelude is asked of the server (`GET /api/run/:slug/prelude`) with the
 * draft's answers, so what this stage shows is what the start door will judge
 * — one computation, not a client-side imitation of it.
 */

import { Badge, Checkbox, Input, SectionHeading, field as fieldClass } from '@/components/ui';
import type { Prelude, PreludeRow, ProbeVerdict } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePrelude } from '@/lib/queries';
import { RELAY_MODES } from '@shared/run-settings.js';
import { DECISION_STATES } from '@shared/decisions-model.js';
import { SelectField, SetupField } from './fields';
import { useSetupForm } from './form-context';
import { parseAccounts } from './schema';

const RELAY_LABELS: Record<(typeof RELAY_MODES)[number], string> = {
  off: 'Off — the console never answers a question on a person’s behalf',
  'last-resort': 'Last resort — a person is paged first; after 60 s the console answers by rule',
};

const PROBE_LABELS: Record<keyof Prelude['probes'], string> = {
  accounts: 'Accounts',
  mcp: 'MCP servers',
  credentials: 'Credentials',
  delivery: 'Delivery channel',
};

const MARK: Record<ProbeVerdict['status'], string> = { ok: '✓', fail: '✗', skip: '–' };

/** The draft the prelude is asked about — the five answers, as the door will read them. */
export function preludeDraft(values: {
  accounts: string;
  relay: string;
  resumeOnRestart: boolean;
  acknowledgedWaivers: string[];
  model: string;
  permissionProfile: string;
  mcpPolicy: string;
}) {
  const accounts = parseAccounts(values.accounts) ?? [];
  return {
    ...(accounts.length ? { accounts } : {}),
    relay: (RELAY_MODES as readonly string[]).includes(values.relay)
      ? (values.relay as (typeof RELAY_MODES)[number])
      : 'off',
    resumeOnRestart: values.resumeOnRestart,
    ...(values.acknowledgedWaivers.length ? { acknowledgedWaivers: values.acknowledgedWaivers } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.permissionProfile ? { profile: values.permissionProfile } : {}),
    ...(values.mcpPolicy ? { mcpPolicy: values.mcpPolicy } : {}),
  };
}

/**
 * The stage's own prelude query — the same key the run-setup shell asks for
 * its submit gate, over the SEED and the operator's edits (the shell seeds the
 * account list from the answer, so the draft must not include it twice).
 */
export function useDraftPrelude() {
  const f = useSetupForm();
  const asks = f.on('resumeOnRestart') || f.on('relay') || f.on('accounts');
  return usePrelude(
    f.context.slug,
    preludeDraft({
      ...f.values,
      // The seeded list is the prelude's own answer; only a typed one changes the question.
      accounts: f.values.accounts !== f.seed.accounts ? f.values.accounts : '',
    }),
    asks,
  );
}

/** How a row's state paints — the three `DECISION_STATES`, nothing else invented. */
function stateTone(state: string): 'ok' | 'accent' | 'wait' | 'neutral' {
  if (state === 'answered') return 'ok';
  if (state === 'outstanding') return 'accent';
  if (state === 'waived') return 'wait';
  return 'neutral';
}

export function Decisions() {
  return (
    <div className="flex flex-col gap-6">
      <DecisionsSection />
    </div>
  );
}

/**
 * The controls and the manifest — one section, rendered by the stage and by
 * the flat layout, and nothing when the mode asks none of the five.
 */
export function DecisionsSection() {
  const f = useSetupForm();
  const { data: prelude, isLoading, error } = useDraftPrelude();
  if (!f.on('resumeOnRestart') && !f.on('relay') && !f.on('accounts')) return null;

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

  return (
    <div className="flex flex-col gap-6">
      {blocking.length > 0 && (
        <div
          role="status"
          data-testid="decisions-blocking"
          className="rounded-md border border-accent/50 bg-accent/5 p-3 text-sm"
        >
          <p className="font-medium text-ink">
            {blocking.length === 1
              ? 'One decision is still open'
              : `${blocking.length} decisions are still open`}
            {f.values.manifestOverride.trim()
              ? ' — the start will be recorded as an override'
              : ' — Launch is disabled until each is answered'}
          </p>
          <ul className="mt-1 list-disc pl-5 text-ink-muted">
            {blocking.map((b) => (
              <li key={`${b.key}:${b.why}`}>
                <code className="text-ink">{b.key}</code> — {b.why}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="flex flex-col gap-3">
        <SectionHeading as="h3" tone="muted">
          What the door requires
        </SectionHeading>
        {f.on('resumeOnRestart') && (
          <label className="tap-row flex flex-wrap items-start gap-2 text-sm">
            <Checkbox
              className="mt-1"
              checked={f.values.resumeOnRestart}
              onCheckedChange={(next) => f.set('resumeOnRestart', next === true)}
            />
            <span className="min-w-0 flex-1">
              If the console restarts, continue this run
              <span className="block text-2xs text-ink-muted">
                The run’s own answer to the <code>resume.on-restart</code> row. On: a lane a restart cut off
                resumes its session by itself. Off: the run waits for a person, with one errand naming it —
                and is never asked again at every boot.
              </span>
            </span>
          </label>
        )}
        {f.on('relay') && (
          <SelectField
            label="Relay questions to a person"
            hint="The relay row. Off until phase 14 arms it; last resort pages a person and, unanswered after the window, answers by the rule table."
            source={f.src('relay')}
            value={f.values.relay}
            options={RELAY_MODES.map((mode) => [mode, RELAY_LABELS[mode]] as const)}
            onChange={(next) => f.set('relay', next as (typeof RELAY_MODES)[number])}
          />
        )}
        {f.on('accounts') && (
          <SetupField
            label="Accounts it may spend (id:minimum headroom %)"
            hint={
              <>
                In order, each with the five-hour headroom it must show before a phase boards — the plan’s{' '}
                <code>**Accounts:**</code> clause when it has one, else the machine login. The accounts probe
                below refuses the start when every one of them is retired, signed out or under its minimum.
              </>
            }
            source={f.src('accounts')}
            error={f.errors.accounts}
          >
            <Input
              className={fieldClass}
              value={f.values.accounts}
              placeholder="default:20, work:10"
              onChange={(event) => f.set('accounts', event.target.value)}
            />
          </SetupField>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading as="h3" tone="muted">
          What the probes found
        </SectionHeading>
        {isLoading && !prelude && <p className="text-xs text-ink-muted">Asking the console…</p>}
        {error && (
          <p className="text-xs text-failed">The prelude could not be read: {(error as Error).message}</p>
        )}
        {prelude && (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Probe verdicts">
            {(Object.keys(PROBE_LABELS) as (keyof Prelude['probes'])[]).map((id) => {
              const verdict = prelude.probes[id];
              return (
                <li key={id} className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    aria-hidden
                    className={cn(
                      'font-mono',
                      verdict.status === 'ok' && 'text-done',
                      verdict.status === 'fail' && 'text-failed',
                      verdict.status === 'skip' && 'text-ink-muted',
                    )}
                  >
                    {MARK[verdict.status]}
                  </span>
                  <span className="text-ink">{PROBE_LABELS[id]}</span>
                  <span className="text-ink-muted">
                    <span className="sr-only">{verdict.status}: </span>
                    {verdict.reason}
                  </span>
                  {verdict.warnings?.length ? (
                    <ul className="w-full list-disc pl-8 text-2xs text-ink-muted">
                      {verdict.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {prelude && deliveryFailed && f.on('acknowledgedWaivers') && (
          <label className="tap-row flex flex-wrap items-start gap-2 text-sm">
            <Checkbox
              className="mt-1"
              checked={acknowledged.has('announce')}
              onCheckedChange={(next) => toggleAck('announce', next === true)}
            />
            <span className="min-w-0 flex-1">
              Start anyway with no delivery channel
              <span className="block text-2xs text-ink-muted">
                Nobody will hear this run’s announcements — no subscribed device, no notify command, no
                webhook. Acknowledging records the <code>announce</code> row as waived for this run.
              </span>
            </span>
          </label>
        )}
      </section>

      {prelude && (
        <section className="flex flex-col gap-3">
          <SectionHeading as="h3" tone="muted">
            The manifest
          </SectionHeading>
          {!prelude.manifestPresent && (
            <p className="text-xs text-ink-muted">
              This plan writes no <code>## Decisions</code> section, so every row below is the console’s own
              answer — the launch form’s, the plan’s other lines, or the shipped default. Only a row the plan
              writes can hold a start.
            </p>
          )}
          <ul className="flex flex-col divide-y divide-rule text-sm" aria-label="Decision manifest">
            {rows.map((row) => (
              <li
                key={`${row.key}:${row.state}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5"
              >
                <code className="text-ink">{row.key}</code>
                {(DECISION_STATES as readonly string[]).includes(row.state) ? (
                  <Badge tone={stateTone(row.state)}>{row.state}</Badge>
                ) : (
                  <span className="text-2xs text-ink-muted break-all">{row.state}</span>
                )}
                {row.blocking === 'yes' && <Badge tone="neutral">blocks a start</Badge>}
                <span className="text-2xs text-ink-muted">
                  {row.origin === 'plan'
                    ? 'from the plan'
                    : row.origin === 'run'
                      ? 'from this launch'
                      : 'the shipped default'}
                  {row.owner && row.state === 'outstanding' ? ` · owed by ${row.owner}` : ''}
                </span>
                <span className="w-full text-xs text-ink-muted break-words">{row.value || '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {prelude && waivedRows.length > 0 && f.on('acknowledgedWaivers') && (
        <section className="flex flex-col gap-2">
          <SectionHeading as="h3" tone="muted">
            Acknowledged waivers
          </SectionHeading>
          <p className="text-xs text-ink-muted">
            The plan waived these rows. Each needs a reader’s acknowledgement before the run starts.
          </p>
          {waivedRows.map((row) => (
            <label key={row.key} className="tap-row flex flex-wrap items-start gap-2 text-sm">
              <Checkbox
                className="mt-1"
                checked={acknowledged.has(row.key)}
                onCheckedChange={(next) => toggleAck(row.key, next === true)}
              />
              <span className="min-w-0 flex-1">
                <code>{row.key}</code> — waived
                <span className="block text-2xs text-ink-muted break-words">
                  {row.value || 'no reason given'}
                </span>
              </span>
            </label>
          ))}
        </section>
      )}

      {f.on('manifestOverride') && blocking.length > 0 && (
        <section className="flex flex-col gap-2">
          <SetupField
            label="Start anyway, recorded as"
            hint={
              <>
                The one way past a blocking row, and it is recorded: <code>run.manifest-override</code> names
                who signed it and which rows were open. Type your name to enable Launch; leave it empty to
                answer the rows instead.
              </>
            }
            source={f.src('manifestOverride')}
          >
            <Input
              className={fieldClass}
              value={f.values.manifestOverride}
              placeholder="your name"
              onChange={(event) => f.set('manifestOverride', event.target.value)}
            />
          </SetupField>
        </section>
      )}
    </div>
  );
}

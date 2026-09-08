/**
 * The boarding schedule — when this console is willing to START phases.
 *
 * The one clock on this page that is the operator's rather than the machine's.
 * Everything else in Automation answers "is it safe to start"; this answers "is
 * now a time I want sessions starting", which nothing could infer: a laptop is
 * perfectly capable of boarding an eleven-phase plan at 03:40, and did.
 *
 * Three rules, composing in the order `shared/schedule-policy.js` states them —
 * windows and cron openings ALLOW, quiet hours DENY and win. The card renders
 * that order rather than restating it: quiet hours sit below the windows with
 * the sentence that says they beat them.
 *
 * Same discipline as the cards beside it: rendered from `/api/state` (what the
 * server process holds, never a local copy of the intention) and saved through
 * `POST /api/prefs`. The whole policy is sent on every change, because its
 * parts are lists and a merge of two lists has no meaning an operator could
 * predict when what they did was delete a window.
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useConsoleState, useSavePrefs } from '@/lib/queries';
import {
  DAY_NAMES,
  describeOpening,
  sanitiseSchedule,
  scheduleState,
  type BoardingWindow,
  type SchedulePolicy,
} from '@shared/schedule-policy.js';
import { Button, Card, CardBody, CardHeader, CardTitle, CardSkeleton, field, toast } from '@/components/ui';

/** Mon–Fri, 09:00–18:00 — the window somebody adding their first one means. */
const FIRST_WINDOW: BoardingWindow = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
/** …and the quiet hours somebody adding their first ones means. */
const FIRST_QUIET: BoardingWindow = { from: '22:00', to: '07:00' };

/** One row of the two window lists. `days` is only offered on the allow-list. */
function WindowRow({
  window: w,
  days,
  disabled,
  onChange,
  onRemove,
  label,
}: {
  window: BoardingWindow;
  days: boolean;
  disabled: boolean;
  onChange: (next: BoardingWindow) => void;
  onRemove: () => void;
  label: string;
}) {
  const time = (which: 'from' | 'to') => (
    <label className="flex items-center gap-1 text-2xs text-ink-muted">
      {which}
      <input
        type="time"
        aria-label={`${label} ${which}`}
        value={w[which]}
        disabled={disabled}
        onChange={(event) => onChange({ ...w, [which]: event.target.value })}
        className={cn(field, 'px-1')}
      />
    </label>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {time('from')}
      {time('to')}
      {days && (
        <div className="flex items-center gap-0.5" role="group" aria-label={`${label} days`}>
          {DAY_NAMES.map((name, index) => {
            const on = !w.days?.length || w.days.includes(index);
            return (
              <button
                key={name}
                type="button"
                aria-pressed={on}
                aria-label={name}
                disabled={disabled}
                onClick={() => {
                  // An empty list means "every day", so the first click has to
                  // start from all seven and remove one — starting from nothing
                  // would silently mean every day again.
                  const current = w.days?.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
                  const next = on ? current.filter((d) => d !== index) : [...current, index].sort();
                  onChange({ ...w, days: next });
                }}
                // The one control on this card that is a glyph rather than a
                // word: sized to a thumb where there is no pointer, and 28 px
                // where there is — seven of these in a row at tap size would
                // be a keyboard.
                className={cn(
                  'size-7 rounded border text-2xs disabled:opacity-50 [@media(hover:none)]:size-(--tap-min)',
                  on ? 'border-accent bg-accent/15 text-ink' : 'border-rule text-ink-faint',
                )}
              >
                {name.slice(0, 1)}
              </button>
            );
          })}
        </div>
      )}
      <Button size="sm" disabled={disabled} onClick={onRemove} aria-label={`Remove this ${label}`}>
        <Trash2 size={13} aria-hidden />
      </Button>
    </div>
  );
}

export function ScheduleCard() {
  const { data: state, isPending } = useConsoleState();
  const [cronDraft, setCronDraft] = useState('');

  const save = useSavePrefs();
  /** The whole policy on every change — see the header for why it is not a merge. */
  const write = (policy: SchedulePolicy) => save.mutate({ boardingSchedule: policy });

  if (isPending && !state) return <CardSkeleton loading h="64" />;

  // Through the same coercer the server uses, so what this form edits is what
  // the server would have stored — a config file hand-edited into something
  // unreadable renders as the empty policy rather than as a crash.
  const policy = sanitiseSchedule(state?.prefs?.boardingSchedule);
  const busy = save.isPending;
  const patch = (next: Partial<SchedulePolicy>) => write({ ...policy, ...next });
  const setList = (key: 'windows' | 'quiet', list: BoardingWindow[]) => patch({ [key]: list });

  // What the policy says right now, computed in the browser from the same
  // module the scheduler uses. Advisory: the server's answer is the one that
  // decides, and the clocks are the same clock.
  const now = Date.now();
  const live = scheduleState(policy, now);

  const list = (key: 'windows' | 'quiet', label: string, days: boolean) => (
    <div className="flex flex-col gap-2">
      {policy[key].map((w, index) => (
        <WindowRow
          key={`${key}-${index}`}
          window={w}
          days={days}
          label={label}
          disabled={busy}
          onChange={(next) =>
            setList(
              key,
              policy[key].map((old, i) => (i === index ? next : old)),
            )
          }
          onRemove={() =>
            setList(
              key,
              policy[key].filter((_, i) => i !== index),
            )
          }
        />
      ))}
      <div>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => setList(key, [...policy[key], key === 'windows' ? FIRST_WINDOW : FIRST_QUIET])}
        >
          <Plus size={13} aria-hidden /> Add {label}
        </Button>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Boarding schedule</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="max-w-prose">
            <p className="text-sm">Only start phases at these times</p>
            <p className="text-2xs text-ink-faint">
              Off — the default — boards at any hour, which is what this console has always done. A recovery
              you ask for is never held: this governs what the autopilot starts.
            </p>
          </div>
          <Button
            size="sm"
            aria-pressed={policy.enabled}
            disabled={busy}
            onClick={() => patch({ enabled: !policy.enabled })}
          >
            {policy.enabled ? 'On' : 'Off'}
          </Button>
        </div>

        {policy.enabled && (
          <p className="text-2xs text-ink-muted" data-testid="schedule-now">
            {live.open
              ? 'Open now — a ready phase would board.'
              : `Closed — ${live.opensAt === null ? 'nothing opens in the next 8 days' : `opens ${describeOpening(live.opensAt, now)}`}.`}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-2xs font-medium text-ink-muted">Boarding windows</p>
          <p className="max-w-prose text-2xs text-ink-faint">
            With none set, every hour is allowed. A window that ends before it begins runs past midnight and
            belongs to the day it started on — 22:00→06:00 on Friday is Friday night.
          </p>
          {list('windows', 'window', true)}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-2xs font-medium text-ink-muted">Quiet hours</p>
          <p className="max-w-prose text-2xs text-ink-faint">
            Nothing boards inside these, whatever the windows say. Quiet hours win — that is what makes them
            worth setting.
          </p>
          {list('quiet', 'quiet hours', false)}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-2xs font-medium text-ink-muted">Cron openings</p>
          <p className="max-w-prose text-2xs text-ink-faint">
            Five-field expressions, in this machine&rsquo;s local time. Each match opens boarding for{' '}
            {policy.cronMinutes} minutes. Same allow-list as the windows, said in the vocabulary a crontab
            already uses.
          </p>
          <ul className="flex flex-col gap-1">
            {policy.cron.map((expression, index) => (
              <li key={expression} className="flex items-center gap-2">
                <code className="rounded bg-ground px-1 py-0.5 font-mono text-2xs">{expression}</code>
                <Button
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove ${expression}`}
                  onClick={() => patch({ cron: policy.cron.filter((_, i) => i !== index) })}
                >
                  <Trash2 size={13} aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="cron-draft">
              Cron expression
            </label>
            <input
              id="cron-draft"
              value={cronDraft}
              disabled={busy}
              placeholder="0 9 * * 1-5"
              onChange={(event) => setCronDraft(event.target.value)}
              className={cn(field, 'w-48 font-mono')}
            />
            <Button
              size="sm"
              disabled={busy || !cronDraft.trim()}
              onClick={() => {
                // Validated by the same parser the scheduler uses, and REFUSED
                // rather than dropped: a silently discarded expression looks
                // exactly like one that is set and never fires.
                const clean = sanitiseSchedule({ cron: [cronDraft] }).cron;
                if (!clean.length) {
                  toast(`${cronDraft.trim()} is not a five-field cron expression.`, 'error');
                  return;
                }
                patch({ cron: [...new Set([...policy.cron, ...clean])] });
                setCronDraft('');
              }}
            >
              Add opening
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * The boarding schedule — when this console is willing to START phases (7.0's,
 * quiet-console phase 21).
 *
 * ```
 * Boarding schedule
 * [x] Only start phases at these times
 *     Closed now: boarding opens tomorrow 09:00.
 * Boarding windows
 *   From [09:00]  To [18:00]  Sun Mon Tue Wed Thu Fri Sat        Remove
 *   Add a window
 * Quiet hours
 *   From [22:00]  To [07:00]                                     Remove
 *   Add quiet hours
 * Cron openings
 *   0 9 * * 1-5                                                  Remove
 *   Cron expression [0 9 * * 1-5]  Add opening
 * Set here   Reset
 * ```
 *
 * The one clock in Automation that is the operator's rather than the machine's.
 * Everything else answers "is it safe to start"; this answers "is now a time I
 * want sessions starting", which nothing could infer: a laptop is perfectly
 * capable of boarding an eleven-phase plan at 03:40, and did.
 *
 * Three rules, composing in the order `shared/schedule-policy.js` states them —
 * windows and cron openings ALLOW, quiet hours DENY and win. The group draws
 * that order rather than restating it: quiet hours sit below the windows with
 * the sentence that says they beat them.
 *
 * Read from the settings schema through the same coercer the server uses, and
 * saved through `POST /api/prefs`. The WHOLE policy is sent on every change,
 * because its parts are lists, and a merge of two lists has no meaning an
 * operator could predict when what they did was delete a window.
 */

import { useEffect, useId, useState } from 'react';
import {
  DAY_NAMES,
  SCAN_DAYS,
  describeOpening,
  parseHhMm,
  sanitiseSchedule,
  scheduleState,
  type BoardingWindow,
  type SchedulePolicy,
} from '@shared/schedule-policy.js';
import { cn } from '@/lib/cn';
import { Button, Input, Label, Mono, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Origin, SettingsGroup, useSetting } from './setting';

/** Mon–Fri, 09:00–18:00 — the window somebody adding their first one means. */
const FIRST_WINDOW: BoardingWindow = { days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
/** …and the quiet hours somebody adding their first ones means. */
const FIRST_QUIET: BoardingWindow = { from: '22:00', to: '07:00' };
/** Every day, for the first press on a window that names none. */
const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/** Whether boarding is open now, and when it next opens — a sentence, computed from the module the scheduler uses. */
export function scheduleNowWords(policy: SchedulePolicy, now: number): string {
  const live = scheduleState(policy, now);
  if (live.open) return 'Open now: a ready phase would board.';
  return live.opensAt === null
    ? `Closed now: nothing opens in the next ${SCAN_DAYS} days.`
    : `Closed now: boarding opens ${describeOpening(live.opensAt, now)}.`;
}

export function ScheduleGroup() {
  const setting = useSetting<unknown>('boardingSchedule');
  const id = useId();

  // Through the same coercer the server uses, so what this edits is what the
  // server would have stored — a config file hand-edited into something
  // unreadable reads as the empty policy rather than as a crash.
  const policy = sanitiseSchedule(setting.value);
  const write = (next: SchedulePolicy) => setting.save(next);
  const patch = (next: Partial<SchedulePolicy>) => write({ ...policy, ...next });

  return (
    <SettingsGroup
      id="schedule"
      title="Boarding schedule"
      lead="When this console may start phases. A recovery you ask for is never held: this governs what the autopilot starts."
    >
      <div data-pref="boardingSchedule" className="flex min-w-0 flex-col gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <label className="tap-row flex min-w-0 items-start gap-2.5 text-body">
            <Checkbox
              className="mt-0.5"
              checked={policy.enabled}
              onCheckedChange={(next) => patch({ enabled: next === true })}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="min-w-0 break-words text-ink">Only start phases at these times</span>
              <span className="max-w-(--measure) break-words text-meta text-ink-muted">
                Off, the default, boards at any hour, which is what this console has always done. Turning it
                off keeps the windows below.
              </span>
            </span>
          </label>
          {policy.enabled && (
            <p className="ps-[1.625rem] text-meta text-ink" data-testid="schedule-now">
              {/* Advisory: the server's answer is the one that decides, on the same clock. */}
              {scheduleNowWords(policy, Date.now())}
            </p>
          )}
        </div>

        <WindowList
          title="Boarding windows"
          hint="With none set, every hour is allowed. A window that ends before it begins runs past midnight and belongs to the day it started on: 22:00 to 06:00 on Friday is Friday night."
          noun="Boarding window"
          addLabel="Add a window"
          windows={policy.windows}
          first={FIRST_WINDOW}
          days
          onChange={(windows) => patch({ windows })}
        />

        <WindowList
          title="Quiet hours"
          hint="Nothing boards inside these, whatever the windows say. Quiet hours win: that is what makes them worth setting."
          noun="Quiet hours"
          addLabel="Add quiet hours"
          windows={policy.quiet}
          first={FIRST_QUIET}
          days={false}
          onChange={(quiet) => patch({ quiet })}
        />

        <section aria-labelledby={`${id}-cron`} className="flex min-w-0 flex-col gap-2">
          <h3 id={`${id}-cron`} className="text-body font-medium text-ink">
            Cron openings
          </h3>
          <p className="max-w-(--measure) text-meta text-ink-muted">
            Five-field expressions, in this machine’s local time. Each match opens boarding for{' '}
            {policy.cronMinutes} minutes: the same allow-list as the windows, in the words a crontab already
            uses.
          </p>
          {policy.cron.length > 0 && (
            <ul className="flex min-w-0 flex-col gap-1" aria-label="Cron openings">
              {policy.cron.map((expression, index) => (
                <li key={expression} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <Mono value={expression} className="min-w-0 wrap-anywhere text-body text-ink" />
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${expression}`}
                    onClick={() => patch({ cron: policy.cron.filter((_, i) => i !== index) })}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <CronAdd onAdd={(clean) => patch({ cron: [...new Set([...policy.cron, ...clean])] })} />
        </section>

        <Origin pref="boardingSchedule" row={setting.row} files={setting.files} />
      </div>
    </SettingsGroup>
  );
}

/** One of the two window lists. `days` is offered only on the allow-list: quiet hours are about the clock. */
function WindowList({
  title,
  hint,
  noun,
  addLabel,
  windows,
  first,
  days,
  onChange,
}: {
  title: string;
  hint: string;
  noun: string;
  addLabel: string;
  windows: readonly BoardingWindow[];
  first: BoardingWindow;
  days: boolean;
  onChange: (next: BoardingWindow[]) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <h3 id={id} className="text-body font-medium text-ink">
        {title}
      </h3>
      <p className="max-w-(--measure) text-meta text-ink-muted">{hint}</p>
      {windows.map((window, index) => (
        <WindowRow
          key={`${noun}-${index}`}
          label={`${noun} ${index + 1}`}
          window={window}
          days={days}
          onChange={(next) => onChange(windows.map((old, i) => (i === index ? next : old)))}
          onRemove={() => onChange(windows.filter((_, i) => i !== index))}
        />
      ))}
      <div>
        <Button size="sm" onClick={() => onChange([...windows, first])}>
          {addLabel}
        </Button>
      </div>
    </section>
  );
}

function WindowRow({
  label,
  window: w,
  days,
  onChange,
  onRemove,
}: {
  label: string;
  window: BoardingWindow;
  days: boolean;
  onChange: (next: BoardingWindow) => void;
  onRemove: () => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
      <TimeField label="From" value={w.from} onCommit={(from) => onChange({ ...w, from })} />
      <TimeField label="To" value={w.to} onCommit={(to) => onChange({ ...w, to })} />
      {days && (
        <div role="group" aria-label={`${label} days`} className="flex min-w-0 flex-wrap gap-1">
          {DAY_NAMES.map((name, index) => {
            const on = !w.days?.length || w.days.includes(index);
            return (
              <Button
                key={name}
                size="sm"
                variant="ghost"
                aria-pressed={on}
                aria-label={name}
                title={name}
                className={cn(
                  'min-w-10 border',
                  on
                    ? 'border-ink bg-ink text-ground hover:bg-ink hover:text-ground'
                    : 'border-rule-strong text-ink-muted',
                )}
                onClick={() => {
                  // An empty list means "every day", so the first press has to
                  // start from all seven and take one away — starting from
                  // nothing would silently mean every day again.
                  const current = w.days?.length ? w.days : EVERY_DAY;
                  const next = on
                    ? current.filter((day) => day !== index)
                    : [...current, index].sort((a, b) => a - b);
                  onChange({ ...w, days: next });
                }}
              >
                {name.slice(0, 3)}
              </Button>
            );
          })}
        </div>
      )}
      <Button size="sm" variant="ghost" aria-label={`Remove ${label.toLowerCase()}`} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

/**
 * A time, committed when the field is left or Enter is pressed — never on each
 * segment typed, which would save 01:00 on the way to 10:00. A field emptied or
 * left unreadable goes back to the time held: clearing it never deletes the
 * window.
 */
function TimeField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text === value) return;
    if (parseHhMm(text) === null) return setText(value);
    onCommit(text);
  };
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Label htmlFor={id} className="font-normal text-ink-muted">
        {label}
      </Label>
      <Input
        id={id}
        type="time"
        className="w-32"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setText(value);
        }}
      />
    </span>
  );
}

/**
 * A new opening, validated by the parser the scheduler uses and REFUSED rather
 * than dropped: a silently discarded expression looks exactly like one that is
 * set and never fires.
 */
function CronAdd({ onAdd }: { onAdd: (clean: string[]) => void }) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const add = () => {
    if (!draft.trim()) return;
    const clean = sanitiseSchedule({ cron: [draft] }).cron;
    if (!clean.length) {
      toast(`${draft.trim()} is not a five-field cron expression.`, 'error');
      return;
    }
    onAdd(clean);
    setDraft('');
  };
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>Cron expression</Label>
        <Input
          id={id}
          className="w-56 font-mono"
          value={draft}
          placeholder="0 9 * * 1-5"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
        />
      </div>
      <Button size="sm" disabled={!draft.trim()} onClick={add}>
        Add opening
      </Button>
    </div>
  );
}

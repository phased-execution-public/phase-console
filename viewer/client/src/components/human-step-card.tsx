/**
 * A person's turn — ONE card, whatever raised it (control-tower phase 42,
 * §Architecture 12, operator decision 7).
 *
 * When a run needs an act only a person can do, the console says so in one
 * place and one shape: what to do, where, the ONE action for that kind,
 * *Open again* whenever they want it, and the proof when it lands. Every row
 * that is a person's turn carries the same view (`humanStepView`, phase 44) —
 * a ledger step and each card the console built by hand before the family
 * existed (a sign-in, an MCP sign-in, the verification card, a plan to
 * approve, a gate, a relayed question, a QA verdict, a protected edit) — so
 * this file draws them all, and it joins the halt card's family (design.md
 * §8): a kind mark, one sentence, the one recommended action, everything
 * else one press away.
 *
 *   1. the kind's icon and plain label — read from `KIND_META`, the ONE place
 *      a kind is named — and a WHERE badge: *At the machine* or *Any device*;
 *   2. the step's own words, and its numbered lines;
 *   3. a device code, large, mono, selectable and copyable;
 *   4. ONE primary action chosen by kind (`PRIMARY_ACT`), then *Open again*,
 *      *Check now*, *Snooze* and *I can't do this*;
 *   5. a quiet status line — opened, last checked, next reminder, expiry —
 *      and the proof's own words when a check did not land;
 *   6. one press away, every datum: who declared it and when, each open, each
 *      check and what it read, the proof ref, the window — and a raw view.
 *
 * A folded card (no ledger step behind it) keeps the actions its row carries:
 * its primary is the row's recommended verb, performed exactly as the server
 * spelled it. A `secret-entry` card has no field for its value: it says where
 * the value goes (control-tower phase 133) — the console never takes a secret.
 *
 * `variant="row"` folds the card to a line — kind, title, where and the
 * primary — that expands in place to the full card.
 */

import { useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Building2,
  ChevronRight,
  ClipboardCheck,
  Fingerprint,
  Hash,
  Lock,
  LogIn,
  Mail,
  Plug,
  Smartphone,
  Split,
  Terminal,
  Usb,
  type LucideIcon,
} from 'lucide-react';

import {
  HUMAN_STEP_OPEN_STATES,
  KIND_META,
  type HumanStepKind,
  type HumanStepState,
  type HumanStepView,
} from '@shared/human-step-model.js';
import {
  type HumanStepMoveView,
  type HumanStepRecord,
  type InboxAction,
  type InboxItem,
  type StepTerminalTicket,
  type StepVerbAnswer,
} from '@/lib/api';
import { humanStepsApi as api } from '@/lib/api/human-steps';
import { keys, patchHumanStep } from '@/lib/queries';
import { Button, CopyButton, Input, toast } from '@/components/ui';
import { cn } from '@/lib/cn';
import { STATUS_ICONS } from '@/components/ui/status/status-icons';
import { OpsBadge } from '@/components/ui/status/ops-badge';
import { useRoute } from '@/app/router';
import { splitActions } from '@/features/runs/lanes-model';
import { StepTerminalSheet } from './step-terminal-sheet';
import { WHERE_LABEL, primaryActOf, primaryLabel } from './human-step-words';

/* ------------------------------------------------------------------ *
 * The words — which act leads, by kind
 * ------------------------------------------------------------------ */

export { PRIMARY_ACT, WHERE_LABEL, primaryActOf, primaryLabel, type PrimaryAct } from './human-step-words';

/**
 * Lucide's glyph for each icon NAME `KIND_META` uses — keyed by the name, never
 * by a kind. The four the status family already draws (`key-round`,
 * `user-round-check`, `shield-check`, `eye`) are borrowed from its map, so the
 * card adds no shared glyph chunk to the first paint's preload map.
 */
const ICONS: Readonly<Record<string, LucideIcon>> = {
  ...STATUS_ICONS,
  'log-in': LogIn,
  smartphone: Smartphone,
  hash: Hash,
  plug: Plug,
  fingerprint: Fingerprint,
  'building-2': Building2,
  usb: Usb,
  split: Split,
  lock: Lock,
  terminal: Terminal,
  bot: Bot,
  mail: Mail,
  'clipboard-check': ClipboardCheck,
};

/** The glyph an icon name draws, for the test that holds every kind to one. */
export function kindIcon(name: string): LucideIcon | undefined {
  return ICONS[name];
}

export const BIRTH_WORDS: Readonly<Record<string, string>> = {
  plan: 'the plan',
  session: 'the phase’s session',
  console: 'the console, on a person’s word',
};

const MOVE_WORDS: Readonly<Record<string, string>> = {
  due: 'came due',
  notify: 'announced',
  remind: 'reminded',
  open: 'opened',
  check: 'checked',
  prove: 'proven',
  snooze: 'snoozed',
  cannot: 'handed back',
  dismiss: 'withdrawn',
  expire: 'expired',
};

/** Is a step still waiting on a person — every state short of settled. */
export function isOpenState(state: string): boolean {
  return (HUMAN_STEP_OPEN_STATES as readonly string[]).includes(state);
}

/* ------------------------------------------------------------------ *
 * Clocks, in words
 * ------------------------------------------------------------------ */

export function span(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} m` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

function clockTime(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : iso;
}

export function stamp(iso: string | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  return Number.isFinite(at.getTime())
    ? at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : iso;
}

/** The status line's parts — separate words, never a dotted string. */
export function statusParts(
  record: Pick<
    HumanStepRecord,
    'opened' | 'checkedAt' | 'nextReminderAt' | 'windowEnd' | 'until' | 'snoozeUntil'
  >,
  opened: number,
  now: number,
): { key: string; text: string }[] {
  const parts: { key: string; text: string }[] = [];
  parts.push({ key: 'opened', text: opened ? `opened ${opened}×` : 'not opened yet' });
  const checked = record.checkedAt ? Date.parse(record.checkedAt) : NaN;
  if (Number.isFinite(checked))
    parts.push({ key: 'checked', text: `last checked ${span(now - checked)} ago` });
  const snoozed = record.snoozeUntil ? Date.parse(record.snoozeUntil) : NaN;
  if (Number.isFinite(snoozed) && snoozed > now)
    parts.push({ key: 'snoozed', text: `snoozed until ${clockTime(record.snoozeUntil!)}` });
  else if (record.nextReminderAt)
    parts.push({ key: 'reminder', text: `next reminder ${clockTime(record.nextReminderAt)}` });
  const end = Date.parse(record.windowEnd ?? record.until ?? '');
  if (Number.isFinite(end))
    parts.push({
      key: 'expires',
      text: end > now ? `expires in ${span(end - now)}` : 'the window has closed',
    });
  return parts;
}

/**
 * The human-step ledger — every step with its moves, the reminder clock's
 * words and what this console can do on the machine (control-tower phase 43).
 * Patched by the `human-step` event, so it is read once per page.
 */
export function useHumanSteps(enabled = true) {
  return useQuery({
    queryKey: keys.humanSteps(),
    queryFn: () => api.humanSteps(),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/* ------------------------------------------------------------------ *
 * Pressing — the verbs, as the card and the strip press them
 * ------------------------------------------------------------------ */

type Busy = 'open' | 'check' | 'snooze' | 'cannot' | 'host' | null;

function errorWords(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The human-step verbs for one step — open (here, on the machine, or in the
 * terminal), check, snooze, cannot — each answer written straight into the
 * caches (`patchHumanStep`), so the status line moves in the tick.
 */
export function useStepVerbs(view: HumanStepView) {
  const client = useQueryClient();
  const id = view.stepId;
  const [busy, setBusy] = useState<Busy>(null);
  const [answer, setAnswer] = useState<StepVerbAnswer | null>(null);
  const [ticket, setTicket] = useState<StepTerminalTicket | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  async function run(which: Exclude<Busy, null>, call: () => Promise<StepVerbAnswer>) {
    setBusy(which);
    try {
      const got = await call();
      setAnswer(got);
      if (got.step) patchHumanStep(client, got.step);
      return got;
    } catch (cause) {
      toast(errorWords(cause), 'warn', 8000);
      return null;
    } finally {
      setBusy(null);
      void client.invalidateQueries({ queryKey: keys.inbox() });
    }
  }

  /**
   * *Open* and *Open again*. A link opens in a NEW tab, synchronously in the
   * press — a popup opened after an await is one a phone blocks — and the
   * console is told afterwards, so it counts. The card never navigates away.
   */
  function open(what?: 'url' | 'command') {
    if (!id) return;
    const url = what !== 'command' ? view.openUrl : undefined;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    void run('open', () => api.humanStepOpen(id, { where: 'here', what: url ? 'url' : 'command' })).then(
      (got) => {
        if (got?.opened?.terminal) setTicket(got.opened.terminal);
        else if (got?.opened?.why) toast(got.opened.why, 'warn', 10_000);
      },
    );
  }

  /** *Open on the machine* — the console answers the full URL first; it opens only once sent back. */
  function openOnMachine() {
    if (!id) return;
    void run('host', () =>
      api.humanStepOpen(id, { where: 'host', what: 'url', ...(confirm ? { confirm } : {}) }),
    ).then((got) => {
      if (got?.confirm) setConfirm(got.confirm.url);
      else if (got?.opened) {
        setConfirm(null);
        toast('Opened on the machine.', 'ok');
      }
    });
  }

  function check() {
    if (!id) return;
    void run('check', () => api.humanStepCheck(id)).then((got) => {
      if (got?.check?.landed) toast('Proven — the phase carries on.', 'ok');
    });
  }

  function snooze() {
    if (!id) return;
    void run('snooze', () => api.humanStepSnooze(id, 60)).then((got) => {
      if (got?.snoozed) toast(`No reminder before ${clockTime(got.snoozed.until)}.`, 'ok');
    });
  }

  function cannot(reason: string) {
    if (!id || !reason.trim()) return;
    void run('cannot', () => api.humanStepCannot(id, reason.trim())).then((got) => {
      if (got) toast('Handed back — it is an errand now, with your reason.', 'ok');
    });
  }

  return {
    busy,
    answer,
    ticket,
    confirm,
    open,
    openOnMachine,
    check,
    snooze,
    cannot,
    closeTerminal: () => setTicket(null),
    cancelConfirm: () => setConfirm(null),
  };
}

/* ------------------------------------------------------------------ *
 * The pieces
 * ------------------------------------------------------------------ */

type Perform = (item: InboxItem, action: InboxAction, says?: string) => void;

/** The kind's glyph and plain label — `KIND_META`'s, and nobody else's. */
export function KindMark({ kind, className }: { kind: HumanStepKind; className?: string }) {
  const meta = KIND_META[kind];
  const Icon = kindIcon(meta.icon) ?? Hash;
  return (
    <span
      data-testid="step-kind"
      data-kind={kind}
      data-icon={meta.icon}
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-2xs font-medium text-ink', className)}
    >
      <Icon size={14} aria-hidden className="text-ink-muted" />
      {meta.label}
    </span>
  );
}

export function WhereBadge({ where }: { where: HumanStepView['where'] }) {
  return (
    <span
      data-testid="step-where"
      data-where={where}
      className="inline-flex shrink-0 items-center rounded-sm border border-rule-strong px-1.5 py-px text-2xs text-ink"
    >
      {WHERE_LABEL[where]}
    </span>
  );
}

/** A device code: the one code a step shows on purpose — large, mono, selectable, copyable. */
export function DeviceCode({ code }: { code: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="step-code-block">
      <output
        data-testid="step-code"
        aria-label="Device code"
        className="font-mono text-2xl leading-none tracking-[0.12em] text-ink select-all"
      >
        {code}
      </output>
      <CopyButton text={code} label="Copy code" size="sm" />
    </div>
  );
}

/**
 * What an operator act asks to be run, in its own words — on every row, so
 * the queue reads as a list of commands a person can copy (control-tower
 * phase 121, #182).
 */
function StepCommand({ command }: { command: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="step-command">
      <code className="min-w-0 font-mono text-xs break-all text-ink select-all">{command}</code>
      <CopyButton text={command} label="Copy command" size="sm" />
    </div>
  );
}

/** Not due yet: what the act waits on before it becomes a person's turn. */
export function DueLine({ dueWhen }: { dueWhen: string | undefined }) {
  return (
    <p data-testid="step-due" className="max-w-prose text-2xs text-ink-muted">
      {dueWhen ? (
        <>
          Due when <code className="font-mono break-all text-ink">{dueWhen}</code> lands.
        </>
      ) : (
        'Not due yet.'
      )}
    </p>
  );
}

/**
 * A `secret-entry` item's one rule, said where its form used to be: the value
 * goes somewhere the console names and never into this page (control-tower
 * phase 133). The server's words carry commands in backticks; each is drawn
 * as code so it can be read and copied whole.
 */
export function SecretWhere({ where }: { where: string | undefined }) {
  const parts = (where ?? 'the place the steps above name').split('`');
  return (
    <p data-testid="step-secret-where" className="max-w-prose text-2xs text-ink-muted">
      This console never takes the value. It goes in{' '}
      {parts.map((part, index) =>
        index % 2 ? (
          <code key={index} className="font-mono break-all text-ink">
            {part}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
      . Put it there yourself, then check — the check looks for it by name.
    </p>
  );
}

interface PrimaryProps {
  item: InboxItem;
  view: HumanStepView;
  verbs: ReturnType<typeof useStepVerbs>;
  perform?: Perform | undefined;
  busy?: string | undefined;
  size?: 'sm' | 'lg';
  className?: string;
  /** The strip names its one action `strip-action`; the card's is `step-primary`. */
  testId?: string;
}

/**
 * The ONE action. A ledger step leads with its kind's act; a folded card with
 * its row's recommended verb, exactly as the server spelled it.
 */
function PrimaryButton({
  item,
  view,
  verbs,
  perform,
  busy,
  size = 'sm',
  className,
  testId = 'step-primary',
}: PrimaryProps) {
  const act = primaryActOf(view);
  const settled = !isOpenState(view.state);
  if (!view.stepId) {
    if (act === 'open' && view.openUrl) {
      return (
        <Button
          size={size}
          variant="action"
          data-testid={testId}
          data-act="open"
          className={className}
          disabled={settled}
          onClick={() => window.open(view.openUrl, '_blank', 'noopener,noreferrer')}
        >
          {primaryLabel('open', view.kind)}
        </Button>
      );
    }
    const { primary } = splitActions(item);
    if (!primary || !perform) return null;
    return (
      <Button
        size={size}
        variant="action"
        data-testid={testId}
        data-act="row"
        data-verb={primary.verb}
        className={className}
        disabled={Boolean(primary.flag) || busy === `${item.id}:${primary.verb}`}
        onClick={() => perform(item, primary)}
      >
        {primary.label}
      </Button>
    );
  }
  const press = () => {
    if (act === 'open') verbs.open('url');
    else if (act === 'terminal' || act === 'machine') verbs.open('command');
    else verbs.check();
  };
  const working =
    (act === 'open' || act === 'terminal' || act === 'machine' ? 'open' : 'check') === verbs.busy;
  return (
    <Button
      size={size}
      variant="action"
      data-testid={testId}
      data-act={act}
      className={className}
      disabled={settled || working}
      onClick={press}
    >
      {working ? 'Working…' : primaryLabel(act, view.kind)}
    </Button>
  );
}

/**
 * The strip's ONE action for a run whose phase waits on a person — the
 * step's primary, with the terminal it may open (control-tower phase 42).
 */
export function HumanStepPrimary({
  item,
  perform,
  busy,
  className,
  testId,
}: {
  item: InboxItem;
  perform?: Perform;
  busy?: string;
  className?: string;
  testId?: string;
}) {
  const view = item.humanStep;
  if (!view) return null;
  return (
    <PrimaryWithVerbs
      item={item}
      view={view}
      perform={perform}
      busy={busy}
      className={className}
      testId={testId}
    />
  );
}

function PrimaryWithVerbs({
  item,
  view,
  perform,
  busy,
  className,
  testId,
}: {
  item: InboxItem;
  view: HumanStepView;
  perform?: Perform | undefined;
  busy?: string | undefined;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  const verbs = useStepVerbs(view);
  return (
    <>
      <PrimaryButton
        item={item}
        view={view}
        verbs={verbs}
        perform={perform}
        busy={busy}
        {...(className ? { className } : {})}
        {...(testId ? { testId } : {})}
      />
      {view.openCommand && (
        <StepTerminalSheet
          ticket={verbs.ticket}
          command={view.openCommand}
          title={view.title}
          onClose={verbs.closeTerminal}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * The datums — one press away, and a raw view one more
 * ------------------------------------------------------------------ */

export function MoveLine({ move }: { move: HumanStepMoveView }) {
  const where =
    move.where === 'host'
      ? ' on the machine'
      : move.where === 'terminal'
        ? ' in the terminal'
        : move.where === 'here'
          ? ' in a browser'
          : '';
  return (
    <li data-testid="step-move" data-verb={move.verb} className="flex min-w-0 flex-wrap gap-x-2">
      <span className="shrink-0 tabular-nums text-ink-muted">{stamp(move.at)}</span>
      <span className="min-w-0 text-ink">
        {MOVE_WORDS[move.verb] ?? move.verb}
        {where}
        {move.by ? ` by ${move.by}` : ''}
        {move.note ? <span className="text-ink-muted"> — {move.note}</span> : null}
      </span>
    </li>
  );
}

function Datums({ view, record }: { view: HumanStepView; record: HumanStepRecord | undefined }) {
  const [raw, setRaw] = useState(false);
  const rows: [string, ReactNode][] = [];
  if (record) {
    const who =
      record.birth === 'session' && record.sessionId
        ? `${BIRTH_WORDS.session} (${record.sessionId})`
        : (BIRTH_WORDS[record.birth] ?? record.birth);
    rows.push(['Declared by', `${who}, ${stamp(record.declaredAt)}`]);
    rows.push([
      'For',
      // Phase 0 is the plan's own act, under its `## Operator errands` (phase 121).
      `${record.slug}, ${record.phase ? `phase ${record.phase}` : 'the plan itself'}${record.runId ? ` (run ${record.runId})` : ''}`,
    ]);
  }
  rows.push([
    'What proves it',
    record?.proof || view.proof ? <code className="font-mono">{record?.proof ?? view.proof}</code> : '—',
  ]);
  const dueWhen = record?.dueWhen ?? view.dueWhen;
  if (dueWhen)
    rows.push([
      'Due when',
      <>
        <code className="font-mono">{dueWhen}</code>
        {record?.dueAt ? ` landed, ${stamp(record.dueAt)}` : ' lands'}
      </>,
    ]);
  if (record)
    rows.push([
      'The window',
      record.state === 'upcoming'
        ? 'starts when it is due'
        : `${stamp(record.dueAt ?? record.declaredAt)} until ${stamp(record.windowEnd ?? record.until)}`,
    ]);
  if (record?.provenBy) rows.push(['Proven by', record.provenBy]);
  if (record?.note) rows.push(['Last word', record.note]);
  const moves = record?.moves ?? [];
  return (
    <div
      data-testid="step-datums"
      className="flex flex-col gap-2 rounded border border-rule bg-ground px-3 py-2 text-2xs"
    >
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="min-w-0 break-words text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {view.stepId && !record && <p className="text-ink-muted">Reading the ledger…</p>}
      {moves.length > 0 && (
        <div>
          <p className="font-medium text-ink">Every open and every check</p>
          <ol className="mt-0.5 flex flex-col gap-0.5">
            {moves.map((move, index) => (
              <MoveLine key={`${move.at}-${index}`} move={move} />
            ))}
          </ol>
        </div>
      )}
      <button
        type="button"
        aria-expanded={raw}
        data-testid="step-raw-toggle"
        onClick={() => setRaw((was) => !was)}
        className="self-start text-left text-ink-muted underline underline-offset-2 hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
      >
        {raw ? 'Hide the raw record' : 'The raw record'}
      </button>
      {raw && (
        <pre
          data-testid="step-raw"
          className="max-h-72 overflow-auto rounded bg-surface p-2 font-mono text-2xs whitespace-pre-wrap text-ink-muted"
        >
          {JSON.stringify(record ? { ...record } : view, null, 2)}
        </pre>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

export interface HumanStepCardProps {
  /** The inbox row that is a person's turn — its `humanStep` view, and its actions. */
  item: InboxItem;
  /** `row` folds the card to a line that expands in place; `primary` is its one action alone (the strip's). */
  variant?: 'full' | 'row' | 'primary';
  /** Performs a folded card's row actions, exactly as the server spelled them. */
  perform?: Perform;
  /** `${item.id}:${verb}` of whatever row action is in flight. */
  busy?: string;
  className?: string;
  /** The primary's test id — the strip names its one action `strip-action`. */
  testId?: string;
}

export function HumanStepCard(props: HumanStepCardProps) {
  const view = props.item.humanStep;
  if (!view) return null;
  if (props.variant === 'primary') return <HumanStepPrimary {...props} />;
  return props.variant === 'row' ? <StepRow {...props} view={view} /> : <FullCard {...props} view={view} />;
}

function StepRow({ item, view, perform, busy, className }: HumanStepCardProps & { view: HumanStepView }) {
  const [open, setOpen] = useState(false);
  // An act born before it is due is shown, never pressed: the ledger refuses
  // an open or a check until its due-when ref lands (control-tower phase 121).
  const upcoming = view.state === 'upcoming';
  return (
    <div
      data-testid="human-step-row"
      data-kind={view.kind}
      data-state={view.state}
      className={cn('flex min-w-0 flex-col gap-2', className)}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <KindMark kind={view.kind} />
        <WhereBadge where={view.where} />
        <span data-testid="step-title" className="min-w-48 flex-1 text-sm font-medium text-ink">
          {view.title}
        </span>
        {item.slug && (
          <span className="font-mono text-2xs text-ink-muted" data-testid="step-scope">
            {item.slug}
            {item.phase != null ? `, phase ${item.phase}` : ''}
          </span>
        )}
      </div>
      {view.code && <DeviceCode code={view.code} />}
      {upcoming && !open && <DueLine dueWhen={view.dueWhen} />}
      {view.kind === 'operator-act' && view.openCommand && !open && (
        <StepCommand command={view.openCommand} />
      )}
      {/* `relative`, as the inbox row's title link is (`components/inbox-row.tsx`):
          in a row with a pick box, the box's 44px touch overlay (`tap-area`)
          overhangs its 16px box by 14px — past the row's 10px gap — and this
          line starts flush under it. Unpositioned, the primary lost its
          top-left corner to the box: the register's touch-wins, in the bell. */}
      <div className="relative flex flex-wrap items-center gap-1.5">
        {!open && !upcoming && <PrimaryWithVerbs item={item} view={view} perform={perform} busy={busy} />}
        <button
          type="button"
          aria-expanded={open}
          data-testid="step-expand"
          onClick={() => setOpen((was) => !was)}
          className="flex items-center gap-1 text-left text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
        >
          <ChevronRight size={12} aria-hidden className={cn('transition-transform', open && 'rotate-90')} />
          {open ? 'Fold the step' : 'The whole step'}
        </button>
      </div>
      {open && (
        <div className="expand-region">
          <FullCard item={item} view={view} perform={perform} busy={busy} embedded />
        </div>
      )}
    </div>
  );
}

function FullCard({
  item,
  view,
  perform,
  busy,
  className,
  embedded = false,
}: HumanStepCardProps & { view: HumanStepView; embedded?: boolean }) {
  const verbs = useStepVerbs(view);
  const { data: list } = useHumanSteps(Boolean(view.stepId));
  const record = view.stepId ? list?.steps.find((step) => step.id === view.stepId) : undefined;
  const [details, setDetails] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const state = record?.state ?? view.state;
  const live = isOpenState(state);
  // Coming up (control-tower phase 121): open, but not yet a person's turn —
  // nothing to open, check or snooze until its due-when ref lands.
  const upcoming = state === 'upcoming';
  const due = live && !upcoming;
  const opened = Math.max(record?.opened ?? 0, verbs.answer?.opened?.n ?? 0);
  const act = primaryActOf(view);
  const canOpen = Boolean(view.stepId && (view.openUrl || view.openCommand));
  const read = verbs.answer?.check && !verbs.answer.check.landed ? verbs.answer.check.read : record?.read;
  const unlanded =
    live && Boolean(read) && (verbs.answer?.check ? !verbs.answer.check.landed : (record?.checks ?? 0) > 0);
  const { rest } = splitActions(item);
  const now = Date.now();
  // The card a push pointed at (`#/approve?step=<id>`) says so to a screen reader.
  const pointed = useRoute().query.step === view.stepId && Boolean(view.stepId);

  return (
    <section
      data-testid="human-step-card"
      data-kind={view.kind}
      data-state={state}
      data-fold={view.fold ?? undefined}
      aria-current={pointed ? 'true' : undefined}
      aria-label={`${upcoming ? 'Coming up' : 'Your turn'}: ${KIND_META[view.kind].label}`}
      className={cn('flex min-w-0 flex-col gap-2.5', className)}
    >
      {!embedded && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <KindMark kind={view.kind} />
          <WhereBadge where={view.where} />
          <span className="text-2xs text-ink-muted" data-testid="step-scope">
            {item.slug ?? 'no plan named'}
            {item.phase != null ? `, phase ${item.phase}` : ''}
          </span>
          <span data-testid="step-state">
            <OpsBadge vocab="step" word={state as HumanStepState} />
          </span>
        </div>
      )}
      {!embedded && (
        <p data-testid="step-title" className="max-w-prose text-base font-medium text-ink">
          {view.title}
        </p>
      )}
      {upcoming && <DueLine dueWhen={record?.dueWhen ?? view.dueWhen} />}
      {view.kind === 'operator-act' && view.openCommand && <StepCommand command={view.openCommand} />}
      {view.lines.length > 0 && (
        <ol
          data-testid="step-lines"
          className="flex max-w-prose list-decimal flex-col gap-1 pl-5 text-xs text-ink"
        >
          {view.lines.map((line, index) => (
            <li key={`${index}-${line}`}>{line}</li>
          ))}
        </ol>
      )}
      {view.act && view.path && (
        <p className="max-w-prose text-2xs text-ink-muted" data-testid="step-protected">
          The edit is to <code className="font-mono text-ink">{view.path}</code>: {view.act}
        </p>
      )}
      {!embedded && view.code && <DeviceCode code={view.code} />}
      {view.kind === 'secret-entry' && live && <SecretWhere where={record?.secretWhere} />}
      {verbs.confirm && (
        <div
          data-testid="step-confirm"
          className="flex flex-col gap-1.5 rounded border border-rule-strong px-3 py-2 text-2xs"
        >
          <p className="text-ink">Open this on the machine the console runs on?</p>
          <code className="font-mono break-all text-ink">{verbs.confirm}</code>
          <div className="flex gap-1.5">
            <Button size="sm" variant="action" onClick={verbs.openOnMachine}>
              Open it there
            </Button>
            <Button size="sm" variant="ghost" onClick={verbs.cancelConfirm}>
              Not now
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5" data-testid="step-actions">
        {!upcoming && (
          <PrimaryButton
            item={item}
            view={{ ...view, state }}
            verbs={verbs}
            perform={perform}
            busy={busy}
            size="lg"
            className="min-h-(--tap-min)"
          />
        )}
        {canOpen && due && (
          <Button
            size="sm"
            data-testid="step-open-again"
            disabled={verbs.busy === 'open'}
            onClick={() => verbs.open()}
          >
            Open again
          </Button>
        )}
        {view.stepId && due && view.where === 'host' && view.openUrl && list?.can.openHost && (
          <Button size="sm" variant="ghost" data-testid="step-open-host" onClick={verbs.openOnMachine}>
            Open on the machine
          </Button>
        )}
        {view.stepId && due && act !== 'check' && (
          <Button
            size="sm"
            data-testid="step-check"
            disabled={verbs.busy === 'check'}
            onClick={() => verbs.check()}
          >
            Check now
          </Button>
        )}
        {view.stepId && due && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="step-snooze"
            disabled={verbs.busy === 'snooze'}
            onClick={verbs.snooze}
          >
            Snooze
          </Button>
        )}
        {view.stepId && live && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="step-cannot"
            aria-expanded={asking}
            onClick={() => setAsking((was) => !was)}
          >
            I can’t do this
          </Button>
        )}
        {!view.stepId &&
          perform &&
          rest.map((action) => (
            <Button
              key={action.verb}
              size="sm"
              data-verb={action.verb}
              disabled={Boolean(action.flag) || busy === `${item.id}:${action.verb}`}
              onClick={() => perform(item, action)}
            >
              {action.label}
            </Button>
          ))}
      </div>

      {asking && (
        <form
          className="flex max-w-prose flex-wrap items-end gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            verbs.cannot(reason);
            setAsking(false);
            setReason('');
          }}
        >
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-2xs text-ink-muted">
            Why not? It becomes an errand with your words.
            <Input
              data-testid="step-cannot-reason"
              value={reason}
              placeholder="Who can do it, or what is in the way"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <Button size="sm" type="submit" disabled={!reason.trim()}>
            Hand it back
          </Button>
        </form>
      )}

      {view.stepId && !upcoming && (
        <p data-testid="step-status" className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-ink-muted">
          {statusParts(record ?? { opened }, opened, now).map((part, index) => (
            <span key={part.key} data-part={part.key}>
              {index > 0 && <span className="sr-only">, </span>}
              {part.text}
            </span>
          ))}
        </p>
      )}
      {unlanded && read && (
        <p data-testid="step-read" className="max-w-prose text-2xs text-ink">
          The check did not land. The proof read: <span className="text-ink-muted">{read}</span>
        </p>
      )}
      {!live && state === 'proven' && (
        <p data-testid="step-proven" className="text-2xs text-ink">
          Proven{record?.provenBy ? ` by ${record.provenBy}` : ''} — the phase carries on.
        </p>
      )}

      <button
        type="button"
        aria-expanded={details}
        data-testid="step-details-toggle"
        onClick={() => setDetails((was) => !was)}
        className="flex items-center gap-1 self-start text-left text-2xs text-ink-muted hover:text-ink [@media(hover:none)]:min-h-(--tap-min)"
      >
        <ChevronRight size={12} aria-hidden className={cn('transition-transform', details && 'rotate-90')} />
        {details ? 'Hide the details' : 'Details: who asked, each open and check, the proof, the window'}
      </button>
      {details && <Datums view={view} record={record} />}

      {view.openCommand && (
        <StepTerminalSheet
          ticket={verbs.ticket}
          command={view.openCommand}
          title={view.title}
          onClose={verbs.closeTerminal}
        />
      )}
    </section>
  );
}

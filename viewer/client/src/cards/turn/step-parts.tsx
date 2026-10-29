/**
 * The pieces a person's step is drawn from — the kind's mark, where it is
 * done, a device code, a command, the due line, a secret's one rule, a move,
 * the raw record — the step's verbs, and its ONE primary action.
 *
 * The one card (`cards/item-card.tsx`) draws a step from these, whole or
 * folded to a row (measured-console phase 32 folded the old human-step card
 * into it); a surface that draws only a step's mark or its primary — the item
 * row, the launch door — takes the piece without the card.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Building2,
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

import { KIND_META, type HumanStepKind, type HumanStepView } from '@shared/human-step-model.js';
import { splitActions, type InboxAction, type InboxItem } from '@/data/api';
import {
  humanStepsApi as api,
  type HumanStepMoveView,
  type StepTerminalTicket,
  type StepVerbAnswer,
} from '@/data/human-steps';
import { keys } from '@/data/keys';
import { patchHumanStep } from '@/data/live';
import { press } from '@/data/press';
import { cn } from '@/lib/cn';
import { Button, toast } from '@/ui';
import { CodeBlock } from '@/ui/code-block';
import { CopyButton } from '@/ui/copy-button';
import { STATUS_ICONS } from '@/ui/status';
import { WHERE_LABEL, primaryActOf, primaryLabel } from '../human-step-words';
import { StepTerminalSheet } from '../step-terminal-sheet';
import { MOVE_WORDS, hourMinute, errorWords, isOpenState, stamp } from './step-words';

/* ------------------------------------------------------------------ *
 * The glyphs
 * ------------------------------------------------------------------ */

/**
 * Lucide's glyph for each icon NAME `KIND_META` uses — keyed by the name, never
 * by a kind. The ones the status family already draws are borrowed from its
 * map, so the card brings no glyph of its own for them.
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

/* ------------------------------------------------------------------ *
 * Pressing — the verbs, as the card and the strip press them
 * ------------------------------------------------------------------ */

type Busy = 'open' | 'check' | 'snooze' | 'cannot' | 'host' | null;

/**
 * The human-step verbs for one step — open (here, on the machine, or in the
 * terminal), check, snooze, cannot — each through the owner door, each answer
 * written straight into the caches (`patchHumanStep`) so the status line moves
 * in the tick, and the inbox re-read whatever happened.
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
      const pressed = await press(call);
      if (pressed.state === 'asked') {
        toast(pressed.words, 'info', 8000);
        return null;
      }
      const got = pressed.result;
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

  /**
   * *I've done this — check*: the proof runs now, and its outcome is SAID
   * either way (#266) — proven, being checked, or not yet, in the verdict's
   * own words (what the proof read, the exit it saw).
   */
  function check(note?: string) {
    if (!id) return;
    const said = note?.trim();
    void run('check', () => (said ? api.humanStepCheck(id, said) : api.humanStepCheck(id))).then((got) => {
      if (!got) return;
      if (got.check?.landed || got.verdict?.state === 'passed') toast('Proven — the phase carries on.', 'ok');
      else if (got.check?.state === 'checking')
        toast('Being checked — the verdict lands on the item.', 'info', 8000);
      else toast(got.verdict?.note ?? got.check?.why ?? 'Not yet — the proof did not hold.', 'warn', 8000);
    });
  }

  /** *Snooze* — an hour by default; the card's menu offers longer. */
  function snooze(minutes = 60) {
    if (!id) return;
    void run('snooze', () => api.humanStepSnooze(id, minutes)).then((got) => {
      if (got?.snoozed) toast(`No reminder before ${hourMinute(got.snoozed.until)}.`, 'ok');
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

export type StepVerbs = ReturnType<typeof useStepVerbs>;

/* ------------------------------------------------------------------ *
 * The pieces
 * ------------------------------------------------------------------ */

/** Presses a row action verbatim, exactly as the server spelled it. */
export type Perform = (item: InboxItem, action: InboxAction, says?: string) => void;

/** The kind's glyph and plain label — `KIND_META`'s, and nobody else's. */
export function KindMark({ kind, className }: { kind: HumanStepKind; className?: string }) {
  const meta = KIND_META[kind];
  const Icon = kindIcon(meta.icon) ?? Hash;
  return (
    <span
      data-testid="step-kind"
      data-kind={kind}
      data-icon={meta.icon}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-meta text-ink', className)}
    >
      <Icon size={14} aria-hidden className="shrink-0 text-ink-muted" />
      {meta.label}
    </span>
  );
}

/** Where it is done — at the machine, or on any device — as a quiet word, never a chip. */
export function WhereWord({ where }: { where: HumanStepView['where'] }) {
  return (
    <span data-testid="step-where" data-where={where} className="text-meta text-ink-muted">
      {WHERE_LABEL[where]}
    </span>
  );
}

/** A device code: the one code a step shows on purpose — large, mono, selectable, copyable. */
export function DeviceCode({ code }: { code: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-3" data-testid="step-code-block">
      <output
        data-testid="step-code"
        aria-label="Device code"
        dir="ltr"
        className="font-mono text-title leading-none text-ink select-all"
      >
        {code}
      </output>
      <CopyButton text={code} label="Copy code" />
    </div>
  );
}

/** What an operator act asks to be run, in its own words — a queue of commands a person can copy. */
export function StepCommand({ command }: { command: string }) {
  return <CodeBlock code={command} testId="step-command" copyLabel="Copy command" />;
}

/** Not due yet: what the act waits on before it becomes a person's turn. */
export function DueLine({ dueWhen }: { dueWhen: string | undefined }) {
  return (
    <p data-testid="step-due" className="max-w-prose text-meta text-ink-muted">
      {dueWhen ? (
        <>
          Due when <code className="font-mono wrap-anywhere text-ink">{dueWhen}</code> lands.
        </>
      ) : (
        'Not due yet.'
      )}
    </p>
  );
}

/**
 * A `secret-entry` item's one rule, said where a form would be: the value goes
 * somewhere the console names and never into this page. The server's words
 * carry commands in backticks; each is drawn as code, to be read and copied
 * whole.
 */
export function SecretWhere({ where }: { where: string | undefined }) {
  const parts = (where ?? 'the place the steps above name').split('`');
  return (
    <p data-testid="step-secret-where" className="max-w-prose text-meta text-ink-muted">
      This console never takes the value. It goes in{' '}
      {parts.map((part, index) =>
        index % 2 ? (
          <code key={index} className="font-mono wrap-anywhere text-ink">
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

/** One move of a step — when, what, where and by whom, and its note. */
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
    <li data-testid="step-move" data-verb={move.verb} className="flex min-w-0 flex-wrap gap-x-2 text-meta">
      <span className="shrink-0 text-ink-muted tabular-nums">{stamp(move.at)}</span>
      <span className="min-w-0 text-ink">
        {MOVE_WORDS[move.verb] ?? move.verb}
        {where}
        {move.by ? ` by ${move.by}` : ''}
        {move.note ? <span className="text-ink-muted"> — {move.note}</span> : null}
      </span>
    </li>
  );
}

/** A record whole, as the ledger holds it — the last of the doors to depth. */
export function RawRecord({ value, testId }: { value: unknown; testId: string }) {
  return (
    <pre
      data-testid={testId}
      role="group"
      aria-label="The raw record"
      tabIndex={0}
      dir="ltr"
      className="mt-1.5 max-h-72 overflow-auto rounded bg-surface p-2.5 font-mono text-meta whitespace-pre-wrap text-ink-muted"
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/* ------------------------------------------------------------------ *
 * The ONE action
 * ------------------------------------------------------------------ */

interface PrimaryProps {
  item: InboxItem;
  view: HumanStepView;
  verbs: StepVerbs;
  perform?: Perform | undefined;
  busy?: string | undefined;
  /** `sm` on a row or a strip; the card's own is `md`. */
  size?: 'sm' | 'md';
  className?: string | undefined;
  /** The strip names its one action `strip-action`; the card's is `step-primary`. */
  testId?: string;
}

/**
 * The ONE action. A ledger step leads with its kind's act; a folded card with
 * its row's recommended verb, exactly as the server spelled it.
 */
export function StepPrimaryButton({
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
          variant="primary"
          size={size}
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
        variant="primary"
        size={size}
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
  const pressIt = () => {
    if (act === 'open') verbs.open('url');
    else if (act === 'terminal' || act === 'machine') verbs.open('command');
    else verbs.check();
  };
  const working =
    (act === 'open' || act === 'terminal' || act === 'machine' ? 'open' : 'check') === verbs.busy;
  return (
    <Button
      variant="primary"
      size={size}
      data-testid={testId}
      data-act={act}
      className={className}
      disabled={settled || working}
      onClick={pressIt}
    >
      {working ? 'Working…' : primaryLabel(act, view.kind)}
    </Button>
  );
}

/** The ONE action with verbs of its own, and the terminal it may open — a row's or a strip's. */
export function StepPrimary({
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
      <StepPrimaryButton
        item={item}
        view={view}
        verbs={verbs}
        perform={perform}
        busy={busy}
        className={className}
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

/**
 * A strip's ONE action for a run whose phase waits on a person — the step's
 * primary, with the terminal it may open.
 */
export function HumanStepPrimary({
  item,
  ...rest
}: {
  item: InboxItem;
  perform?: Perform | undefined;
  busy?: string | undefined;
  className?: string | undefined;
  testId?: string | undefined;
}) {
  const view = item.humanStep;
  if (!view) return null;
  return <StepPrimary item={item} view={view} {...rest} />;
}

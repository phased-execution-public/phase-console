/**
 * The guarded write verbs (7.0, quiet-console phase 9) — the eight acts the
 * console's script door takes from a plan and its phases:
 *
 *   new-plan · close-plan · reopen-plan · open-editor   (a plan)
 *   new-handoff · qa-record · lock-claim · lock-release (a phase)
 *
 * Each runs one phased-execution script, refused by the server unless it was
 * started with `--allow-writes`. Every form shows THE EXACT INVOCATION before
 * anything runs — a dry run (`?dry=1`) per settled edit, the newest answer
 * winning — and nothing is ever committed or pushed: `--git` is not the
 * console's to pass. The run itself goes through `press()`, the one door an
 * authority verb takes, so an owner key that asks to be touched is touched
 * once and a request the owner must confirm says so instead of claiming done.
 *
 * Reopen takes no field and so gets a confirm, never a form; Open in editor
 * takes none and asks nothing. The plan page (phase 10) and the phase panel
 * draw `WriteMenu`; the library draws the scaffold through `ScaffoldPlanDialog`.
 */

import { useEffect, useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CLOSED_PLAN_STATUSES, HANDOFF_STATUSES, QA_RESULTS } from '@shared/plan-vocab.js';
import { api, type PhaseView, type PlanDetail, type WriteRequest, type WriteResult } from '@/data/api';
import { keys } from '@/data/keys';
import { useLockRelease } from '@/data/plans';
import { press, type Pressed } from '@/data/press';
import { isClosed } from '@/lib/closure';
import { Banner, Button, Input, SectionHeading, toast } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { ConfirmButton } from '@/ui/confirm';
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/ui/dialog';
import { NativeSelect } from '@/ui/native-select';

/** The eight, in the order a plan meets them. */
export const WRITE_ACTIONS = [
  'new-plan',
  'close-plan',
  'reopen-plan',
  'open-editor',
  'new-handoff',
  'qa-record',
  'lock-claim',
  'lock-release',
] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

/** Remembered owner — the lock forms prefill it, once one succeeded. */
const OWNER_KEY = 'phase-console.owner';

/** How long a form sits still before the server is asked for the command. */
export const PREVIEW_DEBOUNCE_MS = 150;

interface WriteField {
  name: string;
  label: string;
  type?: 'text' | 'select' | 'checkbox';
  options?: readonly string[];
  placeholder?: string;
  required?: boolean;
  /** Remembered in localStorage under this key once the act succeeds. */
  remember?: string;
}

interface WriteForm {
  title: string;
  hint: string;
  fields: readonly WriteField[];
}

/** The six acts that take a field — what each asks, and why. */
export const WRITE_FORMS: Readonly<Record<string, WriteForm>> = {
  'new-plan': {
    title: 'Scaffold a plan',
    hint: 'Runs new-plan.sh, which creates docs/plans/<slug>.md from the template. The phases are yours to write.',
    fields: [
      { name: 'slug', label: 'Slug, in kebab case', placeholder: 'customer-tool-requests', required: true },
    ],
  },
  // Two decisions, so a form: WHICH terminal word (each means something different
  // to the next reader) and WHY — the server refuses a close with no reason.
  // `active` is not offered: reopening is its own verb.
  'close-plan': {
    title: 'Close this plan',
    hint: 'Runs close-plan.sh. The plan stops reporting ready work, warnings and prompts; its board stays readable. Reopen puts it back.',
    fields: [
      { name: 'status', label: 'Close it as', type: 'select', options: [...CLOSED_PLAN_STATUSES] },
      {
        name: 'reason',
        label: 'Why, in one line',
        placeholder: 'superseded by console-operability',
        required: true,
      },
    ],
  },
  'new-handoff': {
    title: 'Scaffold a handoff',
    hint: 'Runs new-handoff.sh, which also writes INDEX.md and the boot prompts of what this phase unblocks.',
    fields: [
      { name: 'title', label: 'Title, in kebab case', placeholder: 'cart-api-endpoint', required: true },
      { name: 'status', label: 'Status', type: 'select', options: [...HANDOFF_STATUSES] },
      { name: 'qa', label: 'Turn QA on for this plan (--qa)', type: 'checkbox' },
      { name: 'force', label: 'Overwrite a handoff that exists (--force)', type: 'checkbox' },
    ],
  },
  'qa-record': {
    title: 'Record a QA result',
    hint: 'Writes one row of test-status.md. A recorded fail holds every dependent until it is run again.',
    fields: [
      { name: 'result', label: 'Result', type: 'select', options: [...QA_RESULTS] },
      {
        name: 'report',
        label: 'Report path, relative',
        placeholder: 'reports/phase-08-qa.md',
        required: true,
      },
    ],
  },
  'lock-claim': {
    title: 'Claim the phase',
    hint: 'A cooperative lock, so two sessions never build the same phase. Written here only — not committed or pushed.',
    fields: [
      {
        name: 'owner',
        label: 'Owner, as account/session',
        placeholder: 'you@example.com/session-name',
        required: true,
        remember: OWNER_KEY,
      },
      { name: 'force', label: 'Take over a live lock (--force)', type: 'checkbox' },
    ],
  },
  'lock-release': {
    title: 'Release the phase',
    hint: 'Clears the lock file — for a session that ended without releasing it.',
    fields: [
      {
        name: 'owner',
        label: 'Owner, as account/session',
        placeholder: 'you@example.com/session-name',
        required: true,
        remember: OWNER_KEY,
      },
    ],
  },
};

type Values = Record<string, string | boolean>;

function initialValues(form: WriteForm): Values {
  const out: Values = {};
  for (const field of form.fields) {
    if (field.type === 'checkbox') out[field.name] = false;
    else if (field.type === 'select') out[field.name] = field.options?.[0] ?? '';
    else out[field.name] = field.remember ? (readRemembered(field.remember) ?? '') : '';
  }
  return out;
}

function readRemembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Everything one write could have moved: the plan, the list it is on, the totals. */
function settleCaches(client: ReturnType<typeof useQueryClient>, slug: string | undefined): void {
  for (const key of keys.afterPlanWrite(slug)) void client.invalidateQueries({ queryKey: key });
}

/** What a press came back as, said once — done, asked of the owner, or refused. */
function sayPressed(pressed: Pressed<WriteResult>, done: string): void {
  if (pressed.state === 'asked') {
    toast(pressed.words, 'info');
    return;
  }
  toast(pressed.result.ok ? done : 'The script reported a problem', pressed.result.ok ? 'ok' : 'error');
}

/**
 * One guarded write as a form: its fields, the command it will run, and the
 * script's own answer once it has.
 */
export function WriteDialog({
  action,
  base,
  onClose,
  onDone,
}: {
  action: string;
  /** What the act is about — `{slug}` for a plan, `{slug, phase}` for a phase, `{}` for a new plan. */
  base: Partial<WriteRequest>;
  onClose: () => void;
  onDone?: () => void;
}) {
  const form = WRITE_FORMS[action]!;
  const id = useId();
  const client = useQueryClient();
  const [values, setValues] = useState<Values>(() => initialValues(form));
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState(false);

  const payload: WriteRequest = { action, ...base, ...values };
  const key = JSON.stringify(payload);

  // A dry run per SETTLED edit, never per keystroke — and `live` drops an
  // answer that lands after a newer question, so the command on screen is
  // always the answer to what is in the form.
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .write(JSON.parse(key) as WriteRequest, true)
        .then((result) => {
          if (!live) return;
          setPreview(result.command ?? null);
          setError(null);
        })
        .catch((failure: Error) => {
          if (!live) return;
          setPreview(null);
          setError(String(failure.message ?? failure));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [key]);

  const missing = form.fields.some((f) => f.required && !String(values[f.name] ?? '').trim());

  const run = async () => {
    setBusy(true);
    try {
      const pressed = await press(() => api.write(payload));
      if (pressed.state === 'done') {
        setOutcome(pressed.result);
        for (const field of form.fields) {
          const value = values[field.name];
          if (field.remember && typeof value === 'string' && value) {
            try {
              localStorage.setItem(field.remember, value);
            } catch {
              /* private mode: the next form starts empty */
            }
          }
        }
      }
      settleCaches(client, typeof base.slug === 'string' ? base.slug : undefined);
      sayPressed(pressed, 'Done');
      onDone?.();
    } catch (failure) {
      setError(String((failure as Error).message ?? failure));
    } finally {
      setBusy(false);
    }
  };

  const set = (name: string, value: string | boolean) =>
    setValues((current) => ({ ...current, [name]: value }));

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent title={form.title} description={form.hint} data-write-action={action}>
        <div className="flex min-w-0 flex-col gap-3">
          {form.fields.map((field) =>
            field.type === 'checkbox' ? (
              <div key={field.name} className="flex min-w-0 items-start gap-2">
                <Checkbox
                  id={`${id}-${field.name}`}
                  checked={Boolean(values[field.name])}
                  onCheckedChange={(next) => set(field.name, next === true)}
                  className="mt-0.5"
                />
                <label htmlFor={`${id}-${field.name}`} className="min-w-0 text-body text-ink">
                  {field.label}
                </label>
              </div>
            ) : (
              <label key={field.name} className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted">
                {field.label}
                {field.type === 'select' ? (
                  <NativeSelect
                    value={String(values[field.name] ?? '')}
                    onChange={(event) => set(field.name, event.target.value)}
                    className="w-full max-w-none"
                  >
                    {field.options?.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    block
                    value={String(values[field.name] ?? '')}
                    placeholder={field.placeholder}
                    required={field.required}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="font-mono"
                    onChange={(event) => set(field.name, event.target.value)}
                  />
                )}
              </label>
            ),
          )}

          {error && <Banner severity="error">{error}</Banner>}

          {preview && (
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-meta text-ink-muted">Will run</span>
              <pre
                data-testid="write-preview"
                className="overflow-x-auto whitespace-pre-wrap wrap-anywhere rounded border border-rule bg-ground p-2 font-mono text-meta text-ink"
              >
                {preview}
              </pre>
            </div>
          )}

          {outcome && (
            <div className="flex min-w-0 flex-col gap-2">
              <Banner severity={outcome.ok ? 'ok' : 'error'}>
                {outcome.ok ? 'Completed' : `Exit code ${outcome.code}`}
              </Banner>
              {outcome.stdout && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded border border-rule bg-ground p-2 font-mono text-meta text-ink-muted">
                  {outcome.stdout}
                </pre>
              )}
              {outcome.stderr && (
                <pre className="state-failed max-h-48 overflow-auto whitespace-pre-wrap rounded border border-rule bg-ground p-2 font-mono text-meta text-state">
                  {outcome.stderr}
                </pre>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="items-center justify-between">
          <span className="text-meta text-ink-muted">Nothing is committed or pushed.</span>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button variant="ghost">{outcome ? 'Close' : 'Cancel'}</Button>
            </DialogClose>
            {!outcome && (
              <Button variant="primary" disabled={!preview || missing || busy} onClick={() => void run()}>
                {busy ? 'Running…' : 'Run'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Hand the plan's file to the editor this machine opens — one act, nothing asked. */
export async function openInEditor(path: string): Promise<void> {
  try {
    const pressed = await press(() => api.write({ action: 'open-editor', path }));
    toast(
      pressed.state === 'asked' ? pressed.words : 'Handed to your editor',
      pressed.state === 'asked' ? 'info' : 'ok',
    );
  } catch (failure) {
    toast(String((failure as Error).message ?? failure), 'error');
  }
}

/**
 * Reopen a closed plan — confirmed, because from this side it is one small
 * button and from the console's it is a plan back on the ready board, in the
 * counts and in every announcement at once. Not destructive: it restores.
 */
export function ReopenPlanButton({ slug, onDone }: { slug: string; onDone?: () => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const reopen = async () => {
    setBusy(true);
    try {
      const pressed = await press(() => api.write({ action: 'reopen-plan', slug }));
      settleCaches(client, slug);
      sayPressed(pressed, 'Reopened. The plan is active again');
      onDone?.();
    } catch (failure) {
      toast(String((failure as Error).message ?? failure), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmButton
      size="sm"
      busy={busy}
      title="Reopen this plan?"
      description={`Sets ${slug} back to active and clears its closed reason. Its ready phases come back to the board and the counts, and it raises warnings again.`}
      confirmLabel="Reopen"
      onConfirm={() => void reopen()}
    >
      {busy ? 'Reopening…' : 'Reopen plan'}
    </ConfirmButton>
  );
}

/**
 * Free a lapsed claim on a phase — through the one release door every place a
 * lock is seen uses (`data/plans.ts` `useLockRelease`, Sessions ▸ Locks
 * since quiet-console phase 15). The owner lives in the lock file and the
 * server reads it, so nothing here names one.
 */
function ReleaseLapsed({ slug, phase, onDone }: { slug: string; phase: number; onDone?: () => void }) {
  const { release, busy } = useLockRelease();
  return (
    <Button size="sm" disabled={busy} onClick={() => void release(slug, phase).then(() => onDone?.())}>
      Release the lapsed claim
    </Button>
  );
}

/**
 * The write verbs of a plan, or of one of its phases.
 *
 * `allowWrites` is passed rather than read here, so no caller can forget it.
 * Off, a header draws nothing (the console's read-only state is said once, on
 * the shell); the phase panel's inline block says what turning it on gives.
 */
export function WriteMenu({
  detail,
  phase,
  allowWrites,
  inline = false,
  onChanged,
}: {
  detail: PlanDetail;
  phase?: PhaseView;
  allowWrites: boolean;
  /** Drawn as a section of its own — the phase panel's. */
  inline?: boolean;
  onChanged?: () => void;
}) {
  const [action, setAction] = useState<string | null>(null);
  const slug = detail.summary.slug;
  const base: Partial<WriteRequest> = phase ? { slug, phase: phase.phase } : { slug };

  if (!allowWrites) {
    if (!inline) return null;
    return (
      <section className="flex min-w-0 flex-col gap-2">
        <SectionHeading as="h3">Actions</SectionHeading>
        <p className="text-body text-ink-muted">
          Writes are off. Restart with <code className="font-mono">--allow-writes</code> to scaffold handoffs,
          record QA results and manage phase locks from here.
        </p>
      </section>
    );
  }

  // Close or Reopen, never both: they are the two ends of one switch.
  const closed = isClosed(detail.summary);
  const forms: [string, string][] = phase
    ? [
        ['new-handoff', 'Scaffold handoff'],
        ['qa-record', 'Record QA'],
        phase.lock && !phase.lock.expired ? ['lock-release', 'Release lock'] : ['lock-claim', 'Claim phase'],
      ]
    : closed
      ? []
      : [['close-plan', 'Close plan']];

  const buttons = (
    <div className="flex min-w-0 flex-wrap gap-2" data-testid="write-menu">
      {forms.map(([id, label]) => (
        <Button key={id} size="sm" onClick={() => setAction(id)}>
          {label}
        </Button>
      ))}
      {!phase && closed && <ReopenPlanButton slug={slug} onDone={onChanged} />}
      {/* A lapsed claim is freed, not taken: Claim would take it. */}
      {phase?.lock?.expired && <ReleaseLapsed slug={slug} phase={phase.phase} onDone={onChanged} />}
      {!phase && detail.plan?.path && (
        <Button size="sm" onClick={() => void openInEditor(detail.plan!.path!)}>
          Open in editor
        </Button>
      )}
    </div>
  );

  return (
    <>
      {inline ? (
        <section className="flex min-w-0 flex-col gap-2">
          <SectionHeading as="h3">Actions</SectionHeading>
          {buttons}
        </section>
      ) : (
        buttons
      )}
      {action && (
        <WriteDialog action={action} base={base} onClose={() => setAction(null)} onDone={onChanged} />
      )}
    </>
  );
}

/** The scaffold — `new-plan.sh <slug>` — as a dialog the library opens. */
export function ScaffoldPlanDialog({ onClose }: { onClose: () => void }) {
  return <WriteDialog action="new-plan" base={{}} onClose={onClose} />;
}

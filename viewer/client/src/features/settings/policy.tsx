/**
 * The policy editor — this console's answers to the decision manifest, one
 * row per intervention class (zero-touch phase 12; the table is chapter 13
 * §1.3's, owned by `shared/policy-model.js`).
 *
 * Every row shows four things: the class and what it decides, the decision
 * key it answers, the shipped default, and this console's override — a select
 * of the key's closed words (plus a name for the two owner keys), or one line
 * of text for the free-text keys. Pick a plan and a fifth column shows what
 * THAT plan says for the key (its `## Decisions` row, or the prelude's
 * synthesised answer), with the answer in force and its source — the plan
 * outranks the console, which outranks the shipped default.
 *
 * Same discipline as the ladder beside it: rendered from `/api/state`, saved
 * through `POST /api/prefs`. The `policy` preference is ONE object written
 * WHOLE (a merge would leave an answer the operator meant to clear), so every
 * change sends the full merged object; the server journals each changed key
 * as `policy.changed {key, from, to, by}`.
 *
 * Eighteen rows, thirteen keys: five keys are answered by two classes each
 * (`permission.policy` by the tool ask and the declared permission block, and
 * so on), and each row carries its own control — writing the same key —
 * because the rows are what a person reads, and a row without a control reads
 * as a row that cannot be changed.
 */

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { useConsoleState, usePlans, usePrelude, useSavePrefs } from '@/lib/queries';
import { ladderPrefs } from '@/lib/api';
import {
  DECISION_ANSWERS,
  OWNER_KEYS,
  OWNER_RE,
  POLICY_DEFAULTS,
  POLICY_TABLE,
  resolvePolicy,
  type DecisionKey,
} from '@shared/policy-model.js';
import { Button, Card, CardBody, CardHeader, CardTitle, CardSkeleton, field } from '@/components/ui';
import { RelayRulesEditor } from './relay-rules';

type Answers = Partial<Record<string, string>>;

/** A row's plan-level reading, when a plan is picked. */
type PlanReading = { value: string; state: string; source: string; origin: string } | null;

export function PolicyAnswersCard() {
  const { data: state, isPending } = useConsoleState();
  const save = useSavePrefs();
  const [slug, setSlug] = useState('');
  const { data: plans } = usePlans();
  // The prelude is the wizard's live preview and the run door's reading: the
  // manifest as it holds for that plan, every key answered by something.
  const { data: prelude } = usePrelude(slug || undefined, {}, Boolean(slug));

  if (isPending && !state) return <CardSkeleton loading h="64" />;

  const answers: Answers = ladderPrefs(state).policy ?? {};
  const busy = save.isPending;
  const write = (key: string, word: string) => {
    const next: Answers = { ...answers };
    if (word) next[key] = word;
    else delete next[key];
    save.mutate({ policy: next });
  };
  const planRows = new Map<string, PlanReading>(
    (prelude?.rows ?? []).map((row) => [
      row.key,
      { value: row.value, state: row.state, source: row.source, origin: row.origin },
    ]),
  );
  const planDecisions = (prelude?.rows ?? [])
    .filter((row) => row.origin === 'plan' && row.state === 'answered')
    .map((row) => ({ key: row.key, state: row.state, value: row.value }));

  return (
    <Card data-pref="policy">
      <CardHeader>
        <CardTitle>Automation · policy answers</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-2xs text-ink-muted">
          What the console answers by itself when a run stops on a decision. A plan&apos;s own{' '}
          <code>## Decisions</code> row outranks these; these outrank the shipped default; a ruling remembered
          on this console lands here. Every change is journalled as <code>policy.changed</code>.
        </p>

        <label className="flex flex-col gap-1">
          <span className="text-2xs tracking-wide text-ink-faint uppercase">Compare with a plan</span>
          <select
            aria-label="Compare with a plan"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            className={cn(field, 'w-full max-w-56')}
          >
            <option value="">none — the console alone</option>
            {(plans ?? []).map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.slug}
              </option>
            ))}
          </select>
        </label>

        <div className="overflow-x-auto">
          {/* hand-rolled because: every row's fourth cell is a live form control
              bound to one key (a select, or a text field with its own draft),
              and two columns come and go with the plan picker — a DataTable
              renders values, not controls that write. */}
          <table className="w-full text-2xs" aria-label="Policy answers">
            <thead>
              <tr className="text-left text-ink-faint">
                <th className="py-1 pr-2 font-normal">Class</th>
                <th className="py-1 pr-2 font-normal">Decision key</th>
                <th className="py-1 pr-2 font-normal">Shipped</th>
                <th className="py-1 pr-2 font-normal">This console</th>
                {slug && <th className="py-1 pr-2 font-normal">{slug}</th>}
                {slug && <th className="py-1 font-normal">In force</th>}
              </tr>
            </thead>
            <tbody>
              {POLICY_TABLE.map((row) => {
                const key = row.decisionKey as DecisionKey;
                const shipped = POLICY_DEFAULTS[key] ?? '';
                const mine = answers[key] ?? '';
                const words = DECISION_ANSWERS[key];
                const owner = (OWNER_KEYS as readonly string[]).includes(key);
                const reading = slug ? (planRows.get(key) ?? null) : null;
                const inForce = slug
                  ? resolvePolicy(key, { plan: planDecisions, prefs: { policy: answers } })
                  : null;
                return (
                  <tr key={row.class} className="border-t border-rule align-top" data-policy-row={row.class}>
                    <td className="py-1.5 pr-2">
                      <span className="block text-sm text-ink">{row.class}</span>
                      <span className="block text-ink-muted">{row.blurb}</span>
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      <code>{key}</code>
                    </td>
                    <td className="py-1.5 pr-2 whitespace-nowrap">
                      {shipped || <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="py-1.5 pr-2">
                      <AnswerControl
                        rowClass={row.class}
                        decisionKey={key}
                        words={words}
                        owner={owner}
                        value={mine}
                        disabled={busy}
                        onChange={(word) => write(key, word)}
                      />
                    </td>
                    {slug && (
                      <td className="py-1.5 pr-2" data-policy-plan={row.class}>
                        {reading ? (
                          <>
                            <span className="block">
                              {reading.value || <span className="text-ink-faint">—</span>}
                            </span>
                            <span className="block text-ink-faint">
                              {reading.origin === 'plan'
                                ? `the plan's row · ${reading.state}`
                                : `no plan row · ${reading.origin}`}
                            </span>
                          </>
                        ) : (
                          <span className="text-ink-faint">reading…</span>
                        )}
                      </td>
                    )}
                    {slug && (
                      <td className="py-1.5" data-policy-in-force={row.class}>
                        {inForce ? (
                          <>
                            <span className="block">{inForce.answer}</span>
                            <span className="block text-ink-faint">from the {inForce.source}</span>
                          </>
                        ) : (
                          <span className="text-ink-faint">unstated</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Tier 2's answers (phase 14): what the console answers to a question
            nobody else did — the `ambiguity` row above says whether a question
            is relayed at all; these say what the relay answers. */}
        <RelayRulesEditor />
      </CardBody>
    </Card>
  );
}

/**
 * One row's control: the key's closed words as a select (an owner name typed
 * beside it for the two owner keys), or one line of text for a free-text key.
 * Exactly one element per row carries `data-policy-control`, which is how the
 * coverage test proves every row can be changed from here.
 */
function AnswerControl({
  rowClass,
  decisionKey,
  words,
  owner,
  value,
  disabled,
  onChange,
}: {
  rowClass: string;
  decisionKey: string;
  words: readonly string[] | null;
  owner: boolean;
  value: string;
  disabled: boolean;
  onChange: (word: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const label = `${decisionKey} on this console (${rowClass})`;
  if (words === null) {
    // Free text: saved on blur or Enter, cleared by emptying the field.
    const shown = draft ?? value;
    const commit = () => {
      const next = shown.trim();
      setDraft(null);
      if (next !== value) onChange(next);
    };
    return (
      <input
        type="text"
        aria-label={label}
        data-policy-control={rowClass}
        className={cn(field, 'w-full min-w-40')}
        value={shown}
        maxLength={200}
        placeholder="no override"
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
    );
  }
  const custom = owner && value && !words.includes(value) ? value : '';
  return (
    <span className="flex flex-wrap items-center gap-1">
      <select
        aria-label={label}
        data-policy-control={rowClass}
        className={cn(field, 'w-full max-w-40')}
        value={custom ? '__owner' : value}
        disabled={disabled}
        onChange={(event) => {
          const word = event.target.value;
          if (word === '__owner') {
            setDraft(custom || '');
            return;
          }
          setDraft(null);
          onChange(word);
        }}
      >
        <option value="">shipped default</option>
        {words.map((word) => (
          <option key={word} value={word}>
            {word}
          </option>
        ))}
        {owner && <option value="__owner">{custom ? `owner: ${custom}` : 'an owner…'}</option>}
      </select>
      {owner && draft !== null && (
        <span className="flex items-center gap-1">
          <input
            type="text"
            aria-label={`${decisionKey} owner (${rowClass})`}
            className={cn(field, 'w-full min-w-32')}
            value={draft}
            placeholder="who owns it"
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            size="sm"
            disabled={disabled || !OWNER_RE.test(draft.trim())}
            onClick={() => {
              const who = draft.trim();
              setDraft(null);
              onChange(who);
            }}
          >
            Set
          </Button>
        </span>
      )}
    </span>
  );
}

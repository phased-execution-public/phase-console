/**
 * Policy answers — this console's answers to the decision manifest, one row
 * per intervention class (zero-touch phase 12; the table is chapter 13 §1.3's,
 * owned by `shared/policy-model.js`; 7.0's, quiet-console phase 21), and the
 * relay's rules under them.
 *
 * ```
 * Policy answers
 * What this console answers by itself when a run stops on a decision. …
 * Compare with a plan                                       [ No plan     ▾ ]
 * Manual gate                                               [ The shipped default ▾ ]
 * A manual gate is a person's: never delegated, …
 * gates   Ships as delegated   Same answer as Gate block
 * shop says operator, answered   In force: operator, from the plan
 * …
 * Set here   Reset
 * Relay rules
 * …
 * ```
 *
 * Every row shows the class and what it decides, the decision key it answers,
 * the shipped default, and this console's answer — a select of the key's
 * closed words (plus a name for the two owner keys), or one line of text for
 * the free-text keys. Pick a plan and each row also says what THAT plan says
 * for the key (its `## Decisions` row, or the prelude's synthesised answer)
 * and the answer in force with its source — the plan outranks the console,
 * which outranks the shipped default.
 *
 * The `policy` preference is ONE object written WHOLE (a merge would leave an
 * answer the operator meant to clear), so every change sends the full object,
 * merged over the value on screen; the server journals each changed key as
 * `policy.changed {key, from, to, by}`.
 *
 * Nineteen rows, thirteen keys: five keys are answered by two classes each
 * (`permission.policy` by the tool ask and the declared permission block, and
 * so on), and each row carries its own control — writing the same key —
 * because the rows are what a person reads, and a row without a control reads
 * as a row that cannot be changed. Each says which row shares its answer.
 * `data-policy-control` marks the one control per row, `data-pref="policy"`
 * the editor once: `automation-coverage.test.tsx` counts both.
 */

import { useState } from 'react';
import {
  DECISION_ANSWERS,
  OWNER_KEYS,
  OWNER_RE,
  POLICY_DEFAULTS,
  POLICY_TABLE,
  resolvePolicy,
  type DecisionKey,
  type ResolvedPolicy,
} from '@shared/policy-model.js';
import type { PreludeDraft, PreludeRow } from '@/data/api';
import { usePlans } from '@/data/plans';
import { usePrelude } from '@/data/runs';
import { Button, Input, Mono, Skeleton } from '@/ui';
import { NativeSelect } from '@/ui/native-select';
import { RelayRulesEditor } from './relay-rules';
import { Origin, SettingRow, SettingsGroup, useSchemaRow, useSetting, type ControlIds } from './setting';

type Answers = Readonly<Record<string, string>>;

/** The select's word for "an owner's name", which no closed vocabulary holds. */
const OWNER_CHOICE = '__owner';

/** The prelude's draft for a comparison: no launch answers, only the plan's own rows and the console's. */
const NO_DRAFT: PreludeDraft = Object.freeze({});

/** A class's id as a person reads it: `qa-exhausted` → "QA exhausted", `mcp-sign-in` → "MCP sign in". */
export function policyClassWords(cls: string): string {
  const text = cls
    .split('-')
    .map((word) => (word === 'qa' || word === 'mcp' ? word.toUpperCase() : word))
    .join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The rows answered by the same key as each class — read together, they are one answer. */
const SHARED_WITH: ReadonlyMap<string, string[]> = new Map(
  POLICY_TABLE.map((row) => [
    row.class,
    POLICY_TABLE.filter((other) => other.decisionKey === row.decisionKey && other.class !== row.class).map(
      (other) => policyClassWords(other.class),
    ),
  ]),
);

/** Only the answers a person can read back: a stored value that is not a word is not an answer. */
function answersOf(value: unknown): Answers {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** Where an answer in force came from, as a person says it. */
const sourceWords = (source: ResolvedPolicy['source']): string =>
  source === 'default' ? 'the shipped default' : `the ${source}`;

export function PolicyGroup() {
  const setting = useSetting<unknown>('policy');
  // The one legacy switch that IS the `gates` answer: the server resolves with
  // it, so the answer in force does too.
  const gatesSwitch = useSchemaRow('delegateHumanGates').row;
  const plans = usePlans();
  const [slug, setSlug] = useState('');
  // The prelude is the launch door's reading: the manifest as it holds for
  // that plan, every key answered by something.
  const prelude = usePrelude(slug || undefined, NO_DRAFT, Boolean(slug));

  const answers = answersOf(setting.value);
  const write = (key: string, word: string) => {
    const next: Record<string, string> = { ...answers };
    if (word) next[key] = word;
    else delete next[key];
    setting.save(next);
  };

  const readings = new Map<string, PreludeRow>((prelude.data?.rows ?? []).map((row) => [row.key, row]));
  const planDecisions = (prelude.data?.rows ?? [])
    .filter((row) => row.origin === 'plan' && row.state === 'answered')
    .map((row) => ({ key: row.key, state: row.state, value: row.value }));
  const gatesValue = gatesSwitch ? (gatesSwitch.value ?? gatesSwitch.default) : undefined;
  const compared = slug
    ? {
        slug,
        read: prelude.data !== undefined,
        failed: prelude.error ? prelude.error.message || 'the read failed and said nothing' : null,
        reading: (key: string) => readings.get(key) ?? null,
        inForce: (key: DecisionKey) =>
          prelude.data
            ? resolvePolicy(key, {
                plan: planDecisions,
                prefs: { policy: answers, delegateHumanGates: gatesValue },
              })
            : undefined,
      }
    : null;

  return (
    <SettingsGroup
      id="policy"
      title="Policy answers"
      lead={
        <>
          What this console answers by itself when a run stops on a decision. A plan’s own{' '}
          <Mono value="## Decisions" /> row outranks these, and these outrank the shipped default; a ruling
          remembered on this console lands here. Every change is journalled as <Mono value="policy.changed" />
          .
        </>
      }
    >
      <div data-pref="policy" className="flex min-w-0 flex-col gap-5">
        <SettingRow
          label="Compare with a plan"
          hint="Each row then says what the plan answers, and which answer is in force."
          note={compared?.failed ? `${compared.slug} could not be read: ${compared.failed}` : undefined}
        >
          {({ id, describedBy }) => (
            <NativeSelect
              id={id}
              aria-describedby={describedBy}
              className="w-full sm:w-56"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            >
              <option value="">No plan</option>
              {(plans.data ?? []).map((plan) => (
                <option key={plan.slug} value={plan.slug}>
                  {plan.slug}
                </option>
              ))}
            </NativeSelect>
          )}
        </SettingRow>

        {setting.reading && !setting.row ? (
          <div
            className="flex min-w-0 flex-col gap-4"
            aria-busy="true"
            aria-label="Reading the policy answers"
          >
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : (
          POLICY_TABLE.map((row) => {
            const key = row.decisionKey as DecisionKey;
            const shipped = (POLICY_DEFAULTS as Readonly<Partial<Record<string, string>>>)[key];
            const shared = SHARED_WITH.get(row.class) ?? [];
            const reading = compared?.reading(key);
            const inForce = compared?.inForce(key);
            return (
              <div key={row.class} data-policy-row={row.class} className="min-w-0">
                <SettingRow
                  label={policyClassWords(row.class)}
                  hint={row.blurb}
                  facts={
                    <>
                      <Mono value={key} />
                      <span>{shipped ? `Ships as ${shipped}` : 'Nothing ships'}</span>
                      {shared.length > 0 && <span>Same answer as {shared.join(' and ')}</span>}
                      {compared && (
                        <span data-policy-plan={row.class} className="min-w-0 break-words">
                          {reading
                            ? reading.origin === 'plan'
                              ? `${compared.slug} says ${reading.value || 'nothing'}, ${reading.state}`
                              : `${compared.slug} has no row; the ${reading.origin} says ${reading.value || 'nothing'}`
                            : compared.read
                              ? `${compared.slug} has no row`
                              : compared.failed
                                ? `${compared.slug} was not read`
                                : `Reading ${compared.slug}`}
                        </span>
                      )}
                      {compared && inForce !== undefined && (
                        <span data-policy-in-force={row.class} className="min-w-0 break-words text-ink">
                          {inForce
                            ? `In force: ${inForce.answer}, from ${sourceWords(inForce.source)}`
                            : 'Unstated: nothing answers it'}
                        </span>
                      )}
                    </>
                  }
                >
                  {(ids) => (
                    <AnswerControl
                      ids={ids}
                      rowClass={row.class}
                      decisionKey={key}
                      words={DECISION_ANSWERS[key]}
                      owner={(OWNER_KEYS as readonly string[]).includes(key)}
                      value={answers[key] ?? ''}
                      onChange={(word) => write(key, word)}
                    />
                  )}
                </SettingRow>
              </div>
            );
          })
        )}
        <Origin pref="policy" row={setting.row} files={setting.files} />
      </div>

      {/* Tier 2's answers (phase 14): what the console answers to a question
          nobody else did — the Ambiguity row above says whether a question is
          relayed at all; these say what the relay answers. */}
      <RelayRulesEditor />
    </SettingsGroup>
  );
}

/**
 * One row's control: the key's closed words as a select (an owner's name typed
 * beside it for the two owner keys), or one line of text for a free-text key —
 * saved on leaving the field or on Enter, and cleared by emptying it.
 */
function AnswerControl({
  ids,
  rowClass,
  decisionKey,
  words,
  owner,
  value,
  onChange,
}: {
  ids: ControlIds;
  rowClass: string;
  decisionKey: string;
  words: readonly string[] | null;
  owner: boolean;
  value: string;
  onChange: (word: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  if (words === null) {
    const shown = draft ?? value;
    const commit = () => {
      const next = shown.trim();
      setDraft(null);
      if (next !== value) onChange(next);
    };
    return (
      <Input
        id={ids.id}
        aria-describedby={ids.describedBy}
        data-policy-control={rowClass}
        className="w-full sm:w-72"
        value={shown}
        maxLength={200}
        placeholder="No answer here"
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') setDraft(null);
        }}
      />
    );
  }

  // A stored owner's name is offered as itself; picking "An owner…" opens the
  // name field beside the select.
  const custom = owner && value && !words.includes(value) ? value : '';
  const chosen = draft !== null || custom ? OWNER_CHOICE : value;
  const named = draft?.trim() ?? '';
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <NativeSelect
        id={ids.id}
        aria-describedby={ids.describedBy}
        data-policy-control={rowClass}
        className="w-full sm:w-auto sm:max-w-56"
        value={chosen}
        onChange={(event) => {
          const word = event.target.value;
          if (word === OWNER_CHOICE) {
            setDraft(custom || '');
            return;
          }
          setDraft(null);
          onChange(word);
        }}
      >
        <option value="">The shipped default</option>
        {words.map((word) => (
          <option key={word} value={word}>
            {word}
          </option>
        ))}
        {owner && <option value={OWNER_CHOICE}>{custom ? `Owner ${custom}` : 'An owner…'}</option>}
      </NativeSelect>
      {owner && draft !== null && (
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            aria-label={`Who owns ${decisionKey}`}
            className="w-40 font-mono"
            value={draft}
            placeholder="A handle or an email"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            size="sm"
            disabled={!OWNER_RE.test(named)}
            onClick={() => {
              setDraft(null);
              onChange(named);
            }}
          >
            Set the owner
          </Button>
        </span>
      )}
    </span>
  );
}

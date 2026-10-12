/**
 * The relay's rule table — what this console answers to a question a session
 * raised when nobody else did (zero-touch phase 14, `shared/relay-model.js`;
 * 7.0's, quiet-console phase 21).
 *
 * ```
 * Relay rules
 * When a session asks a question and nobody answers within the window, …
 * colour:*  answers  Blue  on trusted runs                         Remove
 * Question key [colour:which-colour-*]  Answer [Blue]  On runs of [Any profile ▾]  Add rule
 * Set here   Reset
 * ```
 *
 * The console's answer order is fixed: a rule from this table, else the sole
 * option labelled `(Recommended)`, else the first option — never a model call.
 * This edits the first of the three. A rule matches a question by its KEY (the
 * question's header and the head of its text, as one slug — the inbox and the
 * journal show it), optionally only on runs of one profile, and names the
 * option to answer: its label, or the unique start of one. A rule whose answer
 * names no option of a question does not apply, and the order falls through.
 *
 * Read from the settings schema and saved through `POST /api/prefs` like every
 * key in Settings; the WHOLE list is written on every change, because an
 * operator who removed a rule meant it gone. A relayed answer in the inbox
 * offers to become a rule here in one press ("Remember as a relay rule").
 */

import { useId, useState } from 'react';
import { RELAY_RULE_DEFAULTS, sanitiseRelayRules, type RelayRule } from '@shared/relay-model.js';
import { PERMISSION_PROFILES, PROFILE_LABELS } from '@shared/run-settings.js';
import { Button, Input, Label, Mono } from '@/ui';
import { NativeSelect } from '@/ui/native-select';
import { Origin, useSetting } from './setting';

/** A profile's name, without the explanation its label carries after the dash. */
const profileName = (profile: string): string =>
  ((PROFILE_LABELS as Readonly<Record<string, string>>)[profile] ?? profile).split(' — ')[0]!.trim();

export function RelayRulesEditor() {
  const setting = useSetting<unknown>('relayRules');
  const rules = sanitiseRelayRules(setting.value);
  const [key, setKey] = useState('');
  const [answer, setAnswer] = useState('');
  const [profile, setProfile] = useState('*');
  const id = useId();

  const write = (next: RelayRule[]) => setting.save(next);
  const add = () => {
    // Through the coercer the server uses, so what is sent is what it stores —
    // a rule needs a key and an answer, and its id is derived from the rest.
    const [rule] = sanitiseRelayRules([{ key, answer, profile }]);
    if (!rule) return;
    write([...rules.filter((existing) => existing.id !== rule.id), rule]);
    setKey('');
    setAnswer('');
  };

  return (
    <div
      data-pref="relayRules"
      role="group"
      aria-labelledby={`${id}-name`}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id={`${id}-name`} className="text-body font-medium text-ink">
          Relay rules
        </h3>
        <p className="max-w-(--measure) text-meta text-ink-muted">
          When a session asks a question and nobody answers within the window, the console answers by a rule
          here, else the option marked (Recommended), else the first. It never answers a multi-select
          question, one with a destructive option, one the deny list touches, or the same question twice in a
          phase: those go to a person.
          {RELAY_RULE_DEFAULTS.length ? '' : ' No rules ship; these are all this console’s.'}
        </p>
      </div>

      {rules.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-2" aria-label="Relay rules">
          {rules.map((rule) => (
            <li
              key={rule.id}
              data-relay-rule={rule.id}
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
            >
              <Mono value={rule.key} className="min-w-0 wrap-anywhere" />
              <span className="text-meta text-ink-muted">answers</span>
              <span className="min-w-0 break-words text-body text-ink">{rule.answer}</span>
              {rule.profile !== '*' && (
                <span className="text-meta text-ink-muted">on {rule.profile} runs</span>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ms-auto"
                aria-label={`Remove the rule for ${rule.key}`}
                onClick={() => write(rules.filter((existing) => existing.id !== rule.id))}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
          <Label htmlFor={`${id}-key`}>Question key</Label>
          <Input
            id={`${id}-key`}
            aria-describedby={`${id}-how`}
            block
            className="font-mono"
            value={key}
            maxLength={120}
            placeholder="colour:which-colour-*"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setKey(event.target.value)}
          />
        </div>
        <div className="flex min-w-0 flex-1 basis-32 flex-col gap-1">
          <Label htmlFor={`${id}-answer`}>Answer</Label>
          <Input
            id={`${id}-answer`}
            aria-describedby={`${id}-how`}
            block
            value={answer}
            maxLength={120}
            placeholder="Blue"
            autoComplete="off"
            onChange={(event) => setAnswer(event.target.value)}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${id}-profile`}>On runs of</Label>
          <NativeSelect
            id={`${id}-profile`}
            className="w-40"
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            <option value="*">Any profile</option>
            {PERMISSION_PROFILES.map((name) => (
              <option key={name} value={name}>
                {profileName(name)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button size="sm" disabled={!key.trim() || !answer.trim()} onClick={add}>
          Add rule
        </Button>
      </div>
      <p id={`${id}-how`} className="max-w-(--measure) text-meta text-ink-faint">
        A key is the question’s header and the start of its text as one slug, the way the inbox and the
        journal show it; * matches anything. The answer is an option’s label, or the unique start of one.
      </p>
      <Origin pref="relayRules" row={setting.row} files={setting.files} />
    </div>
  );
}

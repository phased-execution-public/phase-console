/**
 * The relay's rule table — what this console answers to a question a session
 * raised when nobody else did (zero-touch phase 14; `shared/relay-model.js`).
 *
 * The console's answer order is fixed: a rule from this table, else the sole
 * option labelled `(Recommended)`, else the first option — never a model call.
 * This card edits the first of the three. A rule matches a question by its KEY
 * (the question's header and the head of its text, as one slug — the inbox and
 * the journal show it), optionally only on runs of one profile, and names the
 * option to answer: its label, or the unique start of one. A rule whose answer
 * names no option of a question does not apply, and the order falls through.
 *
 * Rendered from `/api/state` and saved through `POST /api/prefs` like the cards
 * beside it; the whole list is written on every change, because an operator who
 * removed a rule meant it gone. A relayed answer in the inbox offers to become a
 * rule here in one press ("Remember as a relay rule").
 */

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useConsoleState, useSavePrefs } from '@/lib/queries';
import { RELAY_RULE_DEFAULTS, sanitiseRelayRules, type RelayRule } from '@shared/relay-model.js';
import { PERMISSION_PROFILES } from '@shared/run-settings.js';
import { Button, field } from '@/components/ui';

export function RelayRulesEditor() {
  const { data: state } = useConsoleState();
  const save = useSavePrefs();
  const rules = sanitiseRelayRules(state?.prefs?.relayRules);
  const [key, setKey] = useState('');
  const [answer, setAnswer] = useState('');
  const [profile, setProfile] = useState('*');
  const busy = save.isPending;

  const write = (next: RelayRule[]) => save.mutate({ relayRules: next });
  const add = () => {
    const [rule] = sanitiseRelayRules([{ key, answer, profile }]);
    if (!rule) return;
    write([...rules.filter((existing) => existing.id !== rule.id), rule]);
    setKey('');
    setAnswer('');
  };

  return (
    <section className="flex flex-col gap-2 border-t border-rule pt-3" data-pref="relayRules">
      <h3 className="text-sm font-medium text-ink">Relay rules</h3>
      <p className="text-2xs text-ink-muted">
        When a session asks a question and nobody answers within the window, the console answers by a rule
        here, else the <code>(Recommended)</code> option, else the first. It never answers a multi-select
        question, one with a destructive option, one the deny list touches, or the same question twice in a
        phase — those go to a person.{' '}
        {RELAY_RULE_DEFAULTS.length ? '' : 'No rules ship; these are all this console’s.'}
      </p>

      {rules.length > 0 && (
        <ul className="flex list-none flex-col gap-1 p-0" aria-label="Relay rules">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-wrap items-center gap-2 text-2xs"
              data-relay-rule={rule.id}
            >
              <code className="break-all">{rule.key}</code>
              <span className="text-ink-faint">→</span>
              <span className="text-ink">{rule.answer}</span>
              {rule.profile !== '*' && <span className="text-ink-faint">({rule.profile} runs)</span>}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove the rule for ${rule.key}`}
                disabled={busy}
                onClick={() => write(rules.filter((existing) => existing.id !== rule.id))}
              >
                <Trash2 aria-hidden className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-48 flex-1 flex-col gap-1">
          <span className="text-2xs text-ink-faint">Question key (* matches anything)</span>
          <input
            type="text"
            aria-label="Relay rule question key"
            className={cn(field, 'w-full font-mono')}
            value={key}
            maxLength={120}
            placeholder="colour:which-colour-*"
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <label className="flex min-w-32 flex-1 flex-col gap-1">
          <span className="text-2xs text-ink-faint">Answer (an option label)</span>
          <input
            type="text"
            aria-label="Relay rule answer"
            className={cn(field, 'w-full')}
            value={answer}
            maxLength={120}
            placeholder="Blue"
            disabled={busy}
            onChange={(event) => setAnswer(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-ink-faint">On runs of</span>
          <select
            aria-label="Relay rule profile"
            className={cn(field, 'max-w-32')}
            value={profile}
            disabled={busy}
            onChange={(event) => setProfile(event.target.value)}
          >
            <option value="*">any profile</option>
            {PERMISSION_PROFILES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" disabled={busy || !key.trim() || !answer.trim()} onClick={add}>
          Add rule
        </Button>
      </div>
    </section>
  );
}

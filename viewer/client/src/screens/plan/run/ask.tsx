/**
 * Talking to a session that is already running (7.0, quiet-console phase 12;
 * the 6.x ask box before it).
 *
 * A phase's stdin is held open, so a message is one more turn in the same
 * conversation — the context intact, the cache warm, the phase carrying on
 * after. Two acts, because they are different: **Ask** is framed as inert (a
 * question that must not change what the phase is doing), so "why did you skip
 * the cache?" is never read as an order to go back; **Steer** is the honest
 * version of wanting to say so — framed as an instruction and journalled under
 * its own name. A typed `/btw` or `/steer` is what people reach for, and is
 * stripped.
 *
 * The message names its PHASE. The server addresses a named lane and falls back
 * to the lowest-numbered live one when none is named, so with two lanes up a
 * correction typed under the higher phase would reach the lower one's session.
 */

import { useRef, useState } from 'react';
import { api } from '@/data/api';
import { Button, Input, toast } from '@/ui';
import { NativeSelect } from '@/ui/native-select';

export function AskBox({
  slug,
  enabled,
  allowRun,
  phase,
}: {
  slug: string;
  enabled: boolean;
  allowRun: boolean;
  phase?: number | null;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'ask' | 'steer'>('ask');
  const [sending, setSending] = useState(false);
  // A ref, not the `sending` state: a click and an Enter landing in one tick
  // both read the state of the last render — false — so the guard passed twice
  // and the question went to the model twice. A ref is written and read in the
  // same tick, so the second caller sees the first.
  const inFlight = useRef(false);
  const steering = mode === 'steer';

  const send = async () => {
    const body = text.replace(/^\/(btw|steer)\s*/i, '').trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    // The key survives a retry the browser makes on its own, which no guard
    // on this side can see.
    const key = `${mode}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      // `undefined`, never `null`: the fetcher then omits the phase, which is
      // how the protocol says "not stated".
      const target = phase ?? undefined;
      const sent = steering
        ? await api.runSteer(slug, body, key, target)
        : await api.runAsk(slug, body, key, target);
      setText('');
      // Nothing is pushed into the console here: the server prints the line
      // the instant it writes to stdin, and the CLI's echo folds into it as the
      // delivery tick.
      if (sent?.repeated) toast('Already sent: this one was a duplicate', 'ok');
    } catch (error) {
      // The server tells "nothing is listening" (409) from a bad request, so
      // its words are worth showing as they are.
      toast((error as Error).message, 'warn');
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="ask-box" data-mode={mode}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <NativeSelect
          aria-label="What this message is"
          value={mode}
          disabled={!enabled || sending}
          title={
            steering
              ? 'An instruction the phase should act on'
              : 'A question that must not change what the phase is doing'
          }
          className="w-auto shrink-0"
          onChange={(event) => setMode(event.currentTarget.value as 'ask' | 'steer')}
        >
          <option value="ask">Ask</option>
          <option value="steer">Steer</option>
        </NativeSelect>
        <Input
          aria-label={steering ? 'What to do differently' : 'A question for the session'}
          value={text}
          disabled={!enabled || sending}
          placeholder={
            enabled
              ? steering
                ? `Tell the session running phase ${phase} to do something differently`
                : `/btw ask the session running phase ${phase}`
              : allowRun
                ? 'Nothing is running to ask'
                : 'Asking needs --allow-run'
          }
          className="min-w-40 flex-1"
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void send();
          }}
        />
        <Button disabled={!enabled || sending || !text.trim()} onClick={() => void send()}>
          {sending ? 'Sending…' : steering ? 'Steer' : 'Ask'}
        </Button>
      </div>
      {/* Read before sending, so muted ink, not faint. */}
      <p className="text-meta text-ink-muted">
        {!enabled
          ? 'Available while a phase is running'
          : steering
            ? 'Folded into the work; the plan’s verification still decides whether the phase passes'
            : 'Answered in the same session, then it carries on'}
      </p>
    </div>
  );
}

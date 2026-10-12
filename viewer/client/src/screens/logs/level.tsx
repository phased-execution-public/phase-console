/**
 * How loud this console's own log is — and turning it up for a while.
 *
 * ```
 * Log level  Info, as configured.
 * › Change the level
 *     Level [debug ▾]  Debug channels [git, runner     ]  For [30 minutes ▾]  [Change the level]
 *     A channel writes its debug lines whatever the level: an event's first word (git for git.command), or * for all.
 * ```
 *
 * The level is the floor; a debug CHANNEL outranks it, so "show me every git
 * command" does not flood the log with everything else at the same moment.
 * Every change reverts by itself at its deadline (`POST /api/debug/level`, at
 * most a day) — the point is to catch one misbehaving run, not to leave a
 * console writing debug lines until somebody remembers — and Revert now drops
 * it at once (`DELETE`). The card says what the SERVER answered, never what
 * was asked.
 */

import { useId, useState } from 'react';
import type { DebugLevelState } from '@/data/api';
import { useDebugLevel, useLogLevelWrite } from '@/data/logs';
import { Banner, Button, Input, Label } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { NativeSelect } from '@/ui/native-select';

/** How long a change may stand — the server refuses anything past a day. */
export const LEVEL_TTLS: readonly { ms: number; label: string }[] = [
  { ms: 15 * 60_000, label: '15 minutes' },
  { ms: 30 * 60_000, label: '30 minutes' },
  { ms: 2 * 60 * 60_000, label: '2 hours' },
  { ms: 8 * 60 * 60_000, label: '8 hours' },
  { ms: 24 * 60 * 60_000, label: '24 hours' },
];

const DEFAULT_TTL = LEVEL_TTLS[1]!.ms;

/** A level's word, in sentence case. */
const levelWord = (level: string): string => level.charAt(0).toUpperCase() + level.slice(1);

/** The channels a csv names, said — `*` is every one. */
export function channelsWords(spec: string | null | undefined): string | null {
  const names = (spec ?? '')
    .split(/[\s,]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (!names.length) return null;
  if (names.includes('*')) return 'every debug channel on';
  return names.length === 1 ? `the ${names[0]} channel on` : `the ${names.join(', ')} channels on`;
}

/** The state in one sentence: the floor, the channels, and whose it is. */
export function levelSentence(state: DebugLevelState): string {
  const channels = channelsWords(state.debug);
  const until =
    state.source === 'override' && state.until
      ? `, changed here; it reverts at ${new Date(state.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : ', as configured';
  return `${levelWord(state.level)}${channels ? `, with ${channels}` : ''}${until}.`;
}

export function LevelCard() {
  const { data: state, error: readError } = useDebugLevel();
  const write = useLogLevelWrite();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<string | null>(null);
  const [channels, setChannels] = useState<string | null>(null);
  const [ttlMs, setTtlMs] = useState(DEFAULT_TTL);

  if (readError) {
    return (
      <p className="text-meta text-ink-muted" data-testid="log-level">
        The log level could not be read: {readError.message}
      </p>
    );
  }
  if (!state) return null;

  // The form starts from what the server says now, until a person changes it.
  const chosen = level ?? state.level;
  const named = channels ?? state.debug ?? '';
  const override = state.source === 'override';

  const apply = async () => {
    try {
      await write.setLevel({ level: chosen, debug: named.trim(), ttlMs });
      setOpen(false);
      setLevel(null);
      setChannels(null);
    } catch {
      // The answer's words are on the card (`write.error`).
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex min-w-0 flex-col gap-1" data-testid="log-level">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span id={`${id}-title`} className="text-meta text-ink-muted">
          Log level
        </span>
        <span className="text-body text-ink" data-testid="log-level-state">
          {levelSentence(state)}
        </span>
        {override && (
          <Button
            size="sm"
            variant="ghost"
            disabled={write.pending}
            onClick={() => void write.revertLevel().catch(() => undefined)}
          >
            Revert now
          </Button>
        )}
      </p>
      <Disclosure label="Change the level" openLabel="Keep it as it is" open={open} onOpenChange={setOpen}>
        <form
          className="mt-2 flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void apply();
          }}
        >
          <div className="flex min-w-0 flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-level`}>Level</Label>
              <NativeSelect
                id={`${id}-level`}
                value={chosen}
                onChange={(event) => setLevel(event.target.value)}
                className="w-32"
              >
                {state.levels.map((word) => (
                  <option key={word} value={word}>
                    {levelWord(word)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
              <Label htmlFor={`${id}-channels`}>Debug channels</Label>
              <Input
                id={`${id}-channels`}
                value={named}
                placeholder="git, runner — or * for every channel"
                onChange={(event) => setChannels(event.target.value)}
                block
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-ttl`}>For</Label>
              <NativeSelect
                id={`${id}-ttl`}
                value={String(ttlMs)}
                onChange={(event) => setTtlMs(Number(event.target.value))}
                className="w-36"
              >
                {LEVEL_TTLS.map((ttl) => (
                  <option key={ttl.ms} value={ttl.ms}>
                    {ttl.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" size="sm" disabled={write.pending}>
              {write.pending ? 'Changing…' : 'Change the level'}
            </Button>
          </div>
          <p className="max-w-(--measure) text-meta text-ink-muted">
            A channel writes its debug lines whatever the level: name an event’s first word (git for
            git.command), or * for every channel. The change reverts by itself when its time is up.
          </p>
        </form>
      </Disclosure>
      {write.error && <Banner severity="error">The level did not change: {write.error.message}</Banner>}
    </section>
  );
}

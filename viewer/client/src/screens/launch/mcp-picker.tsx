/**
 * Which MCP servers a run — or one phase of it — attaches.
 *
 * The same shape as `SkillPicker`, and for the same reasons: a fold, so it
 * costs nothing when nobody is choosing, chosen items first, and what the PLAN
 * already asked for shown as a fact rather than as a checkbox. A plan's
 * `**MCP servers (every session):**` line and a phase's `**MCP:**` bullet are
 * versioned statements about what the work needs; unticking one here would be
 * the console overruling the repository, which is not a thing this console
 * does anywhere else.
 *
 * What it adds over the skill picker is honesty about state. A server that is
 * signed out or switched off cannot be attached, and finding that out at
 * boarding — after the queue, the lock and the gate — is exactly the failure
 * the preflight exists to prevent. So an unusable server is shown, disabled,
 * with the reason next to it.
 */

import { useMemo } from 'react';

import type { McpServerView } from '@/data/api';
import { Mono } from '@/ui';
import { Checkbox } from '@/ui/checkbox';
import { Disclosure } from '@/ui/disclosure';
import { cn } from '@/lib/cn';

/** Past this, the context cost stops being noise. Same number the MCP page uses. */
const COMFORTABLE = 6;

export function McpPicker({
  servers,
  chosen,
  planServers = [],
  onChange,
  label = 'MCP servers for this run',
  note,
}: {
  servers: McpServerView[];
  chosen: string[];
  /** What the plan already names — shown, never unticked from here. */
  planServers?: string[];
  onChange: (next: string[]) => void;
  label?: string;
  note?: string;
}) {
  // Chosen first, then everything usable, then what cannot be attached — so the
  // list reads as "what you picked / what you could pick / what is broken".
  const ordered = useMemo(() => {
    const rank = (server: McpServerView) => {
      if (chosen.includes(server.id)) return 0;
      return usable(server) ? 1 : 2;
    };
    return [...servers].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  }, [servers, chosen]);

  const total = new Set([...planServers, ...chosen]).size;

  if (!servers.length) return null;

  const toggle = (id: string) => {
    onChange(chosen.includes(id) ? chosen.filter((held) => held !== id) : [...chosen, id]);
  };

  // The fold's own line, drawn open and folded alike.
  const summary = (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-start">
      <span className="text-body font-medium text-ink">{label}</span>
      {total > 0 && <span className="tnum">{total} attached</span>}
    </span>
  );

  return (
    <Disclosure
      className="min-w-0"
      label={summary}
      openLabel={summary}
      bodyClassName="flex min-w-0 flex-col gap-2 pt-2 ps-4"
    >
      {note && <p className="max-w-(--measure) text-meta text-ink-muted">{note}</p>}

      {planServers.length > 0 && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          The plan already attaches{' '}
          {planServers.map((id) => (
            <Mono key={id} value={id} className="me-1 wrap-anywhere" />
          ))}
          — every phase gets those whatever is ticked here.
        </p>
      )}

      {/* Ink, never amber: too many servers costs context, and holds nothing. */}
      {total > COMFORTABLE && (
        <p className="max-w-(--measure) text-meta text-ink">
          <span className="tnum">{total}</span> servers is more than most runs want. Each one costs context on
          every turn.
        </p>
      )}

      <div className="flex min-w-0 flex-col">
        {ordered.map((server) => {
          const ok = usable(server);
          const fromPlan = planServers.includes(server.id);
          return (
            <label
              key={server.id}
              // `tap-row`: a row in a stack of rows takes the thumb floor as
              // its box — the checkbox's own overlay would reach into its
              // neighbours (`docs/design.md` §6).
              className={cn(
                'tap-row flex min-w-0 items-start gap-2 py-1 text-body',
                !(ok || fromPlan) && 'opacity-60',
              )}
            >
              <Checkbox
                className="mt-1"
                checked={fromPlan || chosen.includes(server.id)}
                // A broken server may never be newly ticked — but one already
                // ON the run must stay untickable-OFF: ticked and greyed, it
                // could be neither kept nor dropped, and a run holding it could
                // not be continued either way.
                disabled={fromPlan || (!ok && !chosen.includes(server.id))}
                onCheckedChange={() => toggle(server.id)}
              />
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="min-w-0 break-words text-ink">{server.label}</span>
                <Mono value={server.id} className="min-w-0 wrap-anywhere" />
                {fromPlan && <span className="text-meta text-ink-muted">from the plan</span>}
                {/* The reason it cannot be ticked, in ink: it explains, it does not summon. */}
                {!ok && <span className="text-meta text-ink">{whyNot(server)}</span>}
                {/* Tickable, but do not let it read as verified: nobody has
                    asked this one whether it works. */}
                {ok && unchecked(server) && <span className="text-meta text-ink-muted">not checked yet</span>}
                {server.toolCount ? (
                  <span className="tnum text-meta text-ink-muted">{server.toolCount} tools</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>

      {ordered.some(unchecked) && (
        <p className="max-w-(--measure) text-meta text-ink-muted">
          A server nobody has probed can still be ticked — its status simply is not known yet. Check them from
          the MCP page if it matters; a phase that boards with one it cannot reach runs without it and says
          so, unless the plan requires it.
        </p>
      )}
    </Disclosure>
  );
}

/**
 * Could a phase actually board with this? `pending` can — it connects on first
 * use — and a server nobody has probed yet might, so neither is refused here.
 *
 * A registration nobody finished is refused: an unfilled `${VAR}` in the
 * command will never connect, however many times it is probed, so offering it
 * as a choice is offering something that cannot work.
 */
function usable(server: McpServerView): boolean {
  return (
    server.enabled &&
    !server.needsConfig?.length &&
    server.status !== 'needs-auth' &&
    server.status !== 'failed'
  );
}

/**
 * Has anybody actually asked this server whether it works?
 *
 * `unknown` is what a server reports before its first probe. It stays
 * tickable — it genuinely might work — but it may not read as verified: six
 * ordinary-looking rows that turn out to be walls are found at boarding, after
 * the queue and the lock, which is exactly the failure this picker exists to
 * prevent.
 */
function unchecked(server: McpServerView): boolean {
  return server.enabled && !server.needsConfig?.length && server.status === 'unknown';
}

function whyNot(server: McpServerView): string {
  if (!server.enabled) return 'switched off';
  if (server.needsConfig?.length) return `needs ${server.needsConfig.join(', ')}`;
  if (server.status === 'needs-auth') return 'needs signing in';
  return 'will not connect';
}

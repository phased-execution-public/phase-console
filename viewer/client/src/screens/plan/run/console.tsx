/**
 * A session's console — what a phase is saying, as it says it (7.0,
 * quiet-console phase 12; the 6.x live console before it).
 *
 * ```
 * ● Running  Phase 6 console  opus, worked 12m 03s, expected ~40 min of work   [Freeze|Stop]
 * ┌──────────────────────────────────────────────────────────────────────────────────┐
 * │ 312 lines                                   Search  Show detail (40)  Following  │
 * │ 14:07:52     tool  Bash  npm test                                                │
 * │ 14:08:10     says  The suite is green; writing the handoff.                      │
 * ├──────────────────────────────────────────────────────────────────────────────────┤
 * │ [Ask ▾] [/btw ask the session running phase 6…                       ]  [Ask]    │
 * └──────────────────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * A phase is a `claude -p` process nobody can see; this is the window into it —
 * the tool calls, the files touched, the retries absorbed, and the verification
 * the runner runs afterwards. It reads like a terminal and is not one: there is
 * no input, and a session that needs a decision raises an item instead.
 *
 * The box is the pane's one card, because it is acted on as a unit: searched,
 * filtered, followed, cleared, written into. Its head line sits above it — the
 * session's status mark, its name, its vitals in words and its own controls.
 *
 * The stream does not go through the cache. `run:stream` arrives many times a
 * second while a phase talks, so it is `streamOnly` in `data/live.ts` and read
 * here directly; and the server sends a run's partials only to a connection
 * that asked for that run, so a pane that draws them HOLDS the run's stream
 * (`useRunStream`) for as long as it is mounted, and lets it go when it leaves.
 *
 * Every line has an address while the pane holds it — `?line=<id>`, the fold's
 * own counter — copied from the kind label, marked on arrival. It is a live
 * buffer, bounded, so the promise is no longer than the buffer; the journal's
 * `?j=<seq>` is the address that lasts.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TranscriptEntry } from '@/data/api';
import { onSse } from '@/data/live';
import { useRunStream } from '@/data/live-share';
import { cn } from '@/lib/cn';
import { clockTime } from '@/lib/format';
import { scrollIntoScroller } from '@/lib/scroll';
import { Button, Input, copy } from '@/ui';
import { useRoute } from '@/shell/router';
import { parseHash, withQuery, type Route } from '@/shell/routes';
import {
  CONSOLE_MAX_LINES,
  LINE_KIND_LABEL,
  NO_SESSION_ACTIVITY,
  QUIET_KINDS,
  foldActivity,
  foldLine,
  toConsoleLine,
  type ConsoleLine,
  type SessionActivity,
  type SessionTodo,
} from './console-model';

/* ------------------------------------------------------------------ *
 * One stream, two readings
 * ------------------------------------------------------------------ */

/**
 * A pane's buffer: the lines the console draws and the activity the panels draw,
 * both folded from the same events. Callers hand over what the server sent and
 * never a line of their own making — a task list is an array, not a sentence.
 */
export function useLiveLines() {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [panels, setPanels] = useState<SessionActivity>(NO_SESSION_ACTIVITY);
  const seq = useRef(0);
  const hydrated = useRef(false);
  const seeded = useRef(false);

  const record = useCallback((event: string, data: Record<string, unknown>) => {
    const line = toConsoleLine(event, data);
    if (line?.text) setLines((current) => foldLine(current, line, ++seq.current));
    // The fold returns the SAME state when an event changes nothing, and
    // handing that reference straight to the setter is what lets React skip
    // the render — never spread it.
    setPanels((current) => foldActivity(current, event, data));
  }, []);

  /**
   * The recorded events, replayed once in front of whatever arrives live, so a
   * finished run reads as it ran rather than as an empty box. Folded through
   * the same model the stream is, so a replay and a watch cannot drift apart.
   */
  const hydrate = useCallback((entries: readonly TranscriptEntry[] | undefined) => {
    if (hydrated.current || !entries?.length) return;
    hydrated.current = true;
    let replayed: ConsoleLine[] = [];
    let state = NO_SESSION_ACTIVITY;
    for (const entry of entries) {
      const at = Date.parse(entry.at) || Date.now();
      const data = entry.data ?? {};
      const line = toConsoleLine(entry.event, data);
      if (line?.text) replayed = foldLine(replayed, { ...line, replayed: true }, ++seq.current, at);
      state = foldActivity(state, entry.event, data, at);
    }
    if (state !== NO_SESSION_ACTIVITY) setPanels(state);
    if (!replayed.length) return;
    setLines((current) => [...replayed, ...current].slice(-CONSOLE_MAX_LINES));
  }, []);

  /**
   * The task list from the RUN RECORD, once. The replay is a bounded tail that
   * can hold none of a long phase's task creates; the server's fold saw every
   * line, so the record is the complete list. It is applied only when it holds
   * more rows than the panel — once the live stream has carried the panel
   * further, the panel is the newer of the two. `todosAt` is left alone: the
   * record carries the rows and not the moment they were written, so the panel
   * says no time rather than the moment the page opened.
   */
  const seedTasks = useCallback((tasks: readonly SessionTodo[] | undefined) => {
    if (seeded.current || !tasks?.length) return;
    seeded.current = true;
    setPanels((current) =>
      tasks.length > current.todos.length ? { ...current, todos: [...tasks] } : current,
    );
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    setPanels(NO_SESSION_ACTIVITY);
  }, []);

  return { lines, activity: panels, record, clear, hydrate, seedTasks };
}

/** Which session's events a pane wants: one run, optionally one of its lanes. */
export interface SessionStreamFilter {
  runId: string;
  /** Absent on a pane that reads the whole run. */
  phase?: number | undefined;
  /**
   * The run's own pane: the runner's narration (`run:phase`, `run:verify`) and
   * not the sessions' text. Two lanes' sentences spliced into one paragraph is
   * what an unfiltered stream reads as the moment a second lane opens — the
   * lanes own their text. A pane that never draws the text never holds it.
   */
  omitStream?: boolean | undefined;
}

/**
 * The three event kinds a console draws, narrowed to ONE session.
 *
 * Every payload carries `{runId, slug}` and these three carry `phase`, so
 * narrowing is a predicate over fields that were always there. The phase filter
 * also keeps the panels honest: the activity fold clears the task list when a
 * phase starts running, and only this pane's own phase may fire that reset — a
 * lane starting next door must not wipe a list that is still being worked.
 */
export function useSessionStream(
  record: (event: string, data: Record<string, unknown>) => void,
  enabled: boolean,
  filter: SessionStreamFilter,
): void {
  const { runId, phase, omitStream } = filter;
  useRunStream(enabled && runId && !omitStream ? runId : null);
  useEffect(() => {
    if (!enabled || !runId) return undefined;
    const as = (name: 'stream' | 'phase' | 'verify') => (data: unknown) => {
      if (!data || typeof data !== 'object') return;
      const payload = data as Record<string, unknown>;
      if (payload.runId !== runId) return;
      // `!= null`, not truthy: phase 0 is a phase, and a payload with no
      // phase is not another lane's.
      if (phase != null && payload.phase !== phase) return;
      record(name, payload);
    };
    const offs = [
      ...(omitStream ? [] : [onSse('run:stream', as('stream'))]),
      onSse('run:phase', as('phase')),
      onSse('run:verify', as('verify')),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [record, enabled, runId, phase, omitStream]);
}

/**
 * A replay narrowed to one lane. A replay written before the server kept one
 * per phase holds every lane in one file; the lines with no phase at all — the
 * run's narration — belong to every pane, or a lane's replay starts mid-sentence.
 */
export function linesForPhase(
  entries: TranscriptEntry[] | undefined,
  phase: number | undefined,
): TranscriptEntry[] | undefined {
  if (!entries || phase == null) return entries;
  return entries.filter((entry) => {
    const at = entry.data?.phase;
    return at == null || at === phase;
  });
}

/* ------------------------------------------------------------------ *
 * A line's address, and the search
 * ------------------------------------------------------------------ */

/** The query key a line permalink rides on. */
export const LINE_PARAM = 'line';

/** A line id as an address carries it: a whole number, or none. */
function idOf(raw: string | null | undefined): number | null {
  return raw != null && /^\d+$/.test(raw) ? Number(raw) : null;
}

/** The same route with `?line=<id>` on it, everything else it carried kept. */
function hrefFor(route: Route, id: number): string {
  return withQuery(route, { ...route.query, [LINE_PARAM]: id });
}

/** The line an address names, or null. */
export function linkedLine(hash: string = window.location.hash): number | null {
  return idOf((parseHash(hash) as Route).query[LINE_PARAM]);
}

/** The same address with `?line=<id>` on it — copied, never navigated to. */
export function lineHref(id: number, hash: string = window.location.hash): string {
  return hrefFor(parseHash(hash) as Route, id);
}

/**
 * Case-insensitive substring over the line's text, its kind's word and its tool
 * id. A substring, not a pattern: what people type here is a file name or an
 * error fragment, and `.` and `(` are in almost all of them.
 */
export function lineMatches(line: ConsoleLine, needle: string): boolean {
  if (!needle) return true;
  const q = needle.toLowerCase();
  return (
    line.text.toLowerCase().includes(q) ||
    (LINE_KIND_LABEL[line.kind] ?? line.kind).toLowerCase().includes(q) ||
    Boolean(line.tool && line.tool.toLowerCase().includes(q))
  );
}

/* ------------------------------------------------------------------ *
 * The console
 * ------------------------------------------------------------------ */

/** How close to the bottom still counts as following the tail. */
const FOLLOW_SLACK = 40;

export function RunConsole({
  lines,
  onClear,
  title = 'Session console',
  subtitle,
  footer,
  actions,
  status,
}: {
  lines: readonly ConsoleLine[];
  onClear?: () => void;
  title?: string;
  /** The session's vitals, in words. */
  subtitle?: string;
  /** Inside the box, under the log — the ask box. */
  footer?: ReactNode;
  /** The session's own controls, at the end of the head line. */
  actions?: ReactNode;
  /** The session's status mark, leading the head line — a member of `@/ui/status`. */
  status?: ReactNode;
}) {
  const route = useRoute();
  const routed = idOf(route.query[LINE_PARAM]);
  // A line pressed here is marked without moving the address; an address that
  // changes afterwards (a link followed) wins over the press.
  const [pressed, setPressed] = useState<{ id: number; over: number | null } | null>(null);
  const linked = pressed && pressed.over === routed ? pressed.id : routed;
  const [follow, setFollow] = useState(true);
  const [verbose, setVerbose] = useState(false);
  const [needle, setNeedle] = useState('');
  const [searching, setSearching] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const revealed = useRef<number | null>(null);

  const kept = useMemo(
    () => (verbose ? lines : lines.filter((line) => !QUIET_KINDS.has(line.kind))),
    [lines, verbose],
  );
  const shown = useMemo(
    () => (needle ? kept.filter((line) => lineMatches(line, needle)) : kept),
    [kept, needle],
  );
  const hidden = lines.length - kept.length;
  // A search stops the tail: a filtered view that scrolls to a bottom the
  // reader is not looking at is the console jumping away mid-read.
  const following = follow && !needle;

  useEffect(() => {
    if (following && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, following]);

  // The line an address names is brought into view once, when it is first in
  // the buffer — never again on each append, or a live console could not be
  // read around it — and only in a pane on screen: the hidden panes beside it
  // hold lines with the same ids.
  useEffect(() => {
    const at = box.current;
    if (routed == null || revealed.current === routed || !at || at.closest('[hidden]')) return;
    const line = at.querySelector(`[data-line="${routed}"]`);
    if (!line) return;
    revealed.current = routed;
    setFollow(false);
    scrollIntoScroller(line);
  }, [routed, shown]);

  const copyLink = useCallback(
    (id: number) => {
      setPressed({ id, over: routed });
      setFollow(false);
      void copy(new URL(hrefFor(route, id), window.location.href).toString(), 'Link copied');
    },
    [route, routed],
  );
  const stopSearching = () => {
    setNeedle('');
    setSearching(false);
    setFollow(true);
  };

  const capped = lines.length >= CONSOLE_MAX_LINES ? '+' : '';
  const count = needle
    ? `${shown.length} of ${kept.length}${capped} lines`
    : `${kept.length}${capped} ${kept.length === 1 ? 'line' : 'lines'}`;

  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="run-console">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        {status}
        {/* A floor and leave to shrink: the name keeps its width. The vitals keep a
            floor of their own, so on a phone they wrap to a line of their own
            rather than standing beside the name one word a line. */}
        <h3 className="min-w-24 truncate text-body font-semibold text-ink">{title}</h3>
        {subtitle && (
          <p className="min-w-[min(16rem,100%)] flex-1 break-words text-meta text-ink-muted">{subtitle}</p>
        )}
        {actions && <div className="ms-auto flex min-w-0 items-center">{actions}</div>}
      </div>

      <div className="min-w-0 rounded border border-rule bg-surface">
        {/* `flex-wrap` and no `shrink-0`: the row grows with the session — a
            search field opens, a count gains a digit, Detail carries a number —
            and a row that may not shrink pushes the page sideways instead. */}
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 border-b border-rule px-3 py-1.5">
          <span data-testid="console-count" className="me-auto text-meta text-ink-muted tnum">
            {count}
          </span>
          {searching ? (
            <Input
              type="search"
              autoFocus
              value={needle}
              aria-label="Search the console"
              placeholder="Search these lines"
              title="Escape clears the search and follows the tail again"
              className="h-7 w-full sm:w-48"
              onChange={(event) => setNeedle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') stopSearching();
              }}
            />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              title="Filter these lines; Escape clears it and follows the tail again"
              onClick={() => setSearching(true)}
            >
              Search
            </Button>
          )}
          {(hidden > 0 || verbose) && (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={verbose}
              title="The model's working and every hook call: useful when something is wrong, noise when it is not"
              onClick={() => setVerbose(!verbose)}
            >
              {verbose ? 'Hide detail' : `Show detail (${hidden})`}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={following}
            title={
              needle
                ? 'Filtered: clear the search to follow the tail again'
                : following
                  ? 'Following the tail; scroll up to stop'
                  : 'Jump back to the newest line'
            }
            onClick={() => {
              stopSearching();
              if (box.current) box.current.scrollTop = box.current.scrollHeight;
            }}
          >
            {following ? 'Following' : 'Follow'}
          </Button>
          {onClear && (
            <Button
              size="sm"
              variant="ghost"
              title="Empty this pane; the journal keeps the run"
              onClick={onClear}
            >
              Clear
            </Button>
          )}
        </div>

        <div
          ref={box}
          role="log"
          aria-live="polite"
          aria-label={title}
          // Never `dvh`: on iOS the dynamic unit re-measures as the address bar
          // collapses, so a box sized in it resizes under a scrolling thumb.
          // `--app-height` is the shell's own measured height and holds still.
          className="live-body h-[min(380px,calc(var(--app-height,100%)*0.5))] overflow-y-auto px-3 py-2 font-mono text-meta leading-relaxed"
          onScroll={(event) => {
            if (needle) return;
            const el = event.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK);
          }}
        >
          {shown.length ? (
            shown.map((line) => (
              <LogLine key={line.id} line={line} linked={linked === line.id} onCopy={copyLink} />
            ))
          ) : needle ? (
            <div
              data-testid="console-no-match"
              className="flex flex-wrap items-center gap-x-3 font-sans text-body text-ink-muted"
            >
              <p title={`A pane holds its last ${CONSOLE_MAX_LINES} lines; the journal keeps the whole run.`}>
                No line here matches “{needle}”.
              </p>
              <Button size="sm" variant="ghost" onClick={stopSearching}>
                Clear the search
              </Button>
            </div>
          ) : (
            <p data-testid="console-empty" className="font-sans text-body text-ink-muted">
              Nothing yet — this session’s lines appear here as it works.
            </p>
          )}
        </div>

        {footer && <div className="border-t border-rule px-3 py-2">{footer}</div>}
      </div>
    </section>
  );
}

/**
 * One line: when, what kind (the kind's word copies the line's address), the
 * words, a delivery tick. Memoised: the fold holds the same object for a line
 * until the line changes, and a busy pane redraws hundreds of them a second.
 */
const LogLine = memo(function LogLine({
  line,
  linked,
  onCopy,
}: {
  line: ConsoleLine;
  linked: boolean;
  onCopy: (id: number) => void;
}) {
  const at = Number.isFinite(line.at) ? new Date(line.at) : null;
  return (
    <div
      data-line={line.id}
      className={cn(
        'live-line group',
        `k-${line.kind}`,
        line.replayed && 'is-replayed',
        linked && 'is-linked',
      )}
    >
      {/* The wall clock: two lines' order is visible anyway, the gap between them is not. */}
      <time className="live-time" dateTime={at?.toISOString()} title={at?.toLocaleString()}>
        {clockTime(line.at)}
      </time>
      {/* No variant: the kind's colour is console.css's, and a variant's colour
          utility would outrank it. A button rather than a link: following it
          would scroll to a line already on screen, and what anyone wants is the
          address on the clipboard, for a handoff or a message. */}
      <Button
        variant={null}
        size="sm"
        className="live-k h-auto items-start justify-end rounded-sm px-0 font-normal leading-relaxed hover:underline"
        title="Copy a link to this line"
        onClick={() => onCopy(line.id)}
      >
        <span className="truncate">{LINE_KIND_LABEL[line.kind] ?? line.kind}</span>
      </Button>
      <span className="live-t">{line.text}</span>
      {/* The CLI's own echo coming back: until it does, the message has been
          written to a pipe and nothing more. */}
      {line.mark && (line.kind === 'injected' || line.kind === 'steer') && (
        <span
          className={cn('live-tick', line.delivered && 'is-delivered')}
          title={
            line.delivered
              ? 'The session echoed this back: it landed'
              : 'Written to the session; waiting for it to echo back'
          }
        >
          {line.delivered ? '✓' : '·'}
        </span>
      )}
    </div>
  );
});

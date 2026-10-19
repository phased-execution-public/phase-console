/**
 * Settings ▸ Essentials (7.0, quiet-console phase 21) — the front door.
 *
 * ```
 * Source                                                       [Change source]
 *   Directory  ~/code/repo          Plans  12 files in docs/plans   …
 * ───────────────────────────────────────────────────────────────────────────
 * What this console may do
 *   On   --allow-run                                         [Open Automation]
 *        Start unattended sessions that edit a repository for hours.
 *   Off  --allow-terminal
 *        Open a real shell in the browser.
 *   This console boards phases by itself: …
 * ───────────────────────────────────────────────────────────────────────────
 * Start command, then the file that runs it, then Engine, then Keyboard
 * ```
 *
 * Six answers, in the order somebody who has just opened Settings needs them:
 * what this console reads, what it is ALLOWED to do, the line that starts one
 * with everything, the launcher that runs that line, the engine behind every
 * status, and the keys. The place draws the section's title and its question
 * above them; this draws the groups.
 *
 * **Nothing here is a second control.** The flags are read-outs that only a
 * restart can change, each linking to the section that uses it; whether the
 * console runs work by itself links to Automation rather than repeating a
 * switch. Two controls for one preference disagree the day their fallbacks do.
 */

import { CAPABILITY_WORDS } from '@shared/capability-model.js';
import type { ConsoleState } from '@/data/api';
import { useConsoleState } from '@/data/console';
import { cn } from '@/lib/cn';
import { homePath, plural, weight } from '@/lib/format';
import { CAPABILITIES } from '@/lib/start-command';
import { KEYMAP } from '@/shell/keymap';
import { settingsHref, sourceHref } from '@/shell/routes';
import { Button, Kbd, KbdChord, KeyValue, Mono, Skeleton } from '@/ui';
import { Disclosure } from '@/ui/disclosure';
import { LauncherGroup } from './launcher';
import { sectionTitle } from './nav';
import { SettingsGroup } from './setting';
import { StartCommandGroup } from './start-command';

/** A link inside a sentence: its words, underlined, with the thumb's floor. */
const LINK = 'tap-line text-ink underline decoration-ink-faint underline-offset-2';

/* ---------------- what this console may do ---------------- */

type CapabilityField = (typeof CAPABILITIES)[number][0];

/**
 * What each switch unlocks beyond the shared line, and the section that uses
 * it. The line itself is `shared/capability-model.js`'s — the one list the
 * server, the launch unit and the verbs read — so a switch cannot be composed
 * into the start command and stay unexplained here.
 */
const BEYOND: Readonly<Partial<Record<CapabilityField, { note?: string; where?: string }>>> = {
  allowWrites: { note: 'Never commits or pushes.' },
  allowRun: { where: 'automation' },
  allowAccounts: { note: 'Reading the meters never needs it.', where: 'accounts' },
  allowMcp: { note: 'It holds their credentials too; reading the registry never needs it.', where: 'mcp' },
  allowWebhooks: { note: 'Reading the list of destinations never needs it.', where: 'notifications' },
};

/** The shared line for a switch, as a sentence. */
function actOf(field: string): string {
  const act = CAPABILITY_WORDS.find((row) => row.field === field)?.act ?? '';
  return act ? `${act.charAt(0).toUpperCase()}${act.slice(1)}.` : '';
}

function CapabilityLine({
  state,
  field,
  flag,
}: {
  state: ConsoleState;
  field: CapabilityField;
  flag: string;
}) {
  const on = state[field] === true;
  const beyond = BEYOND[field];
  const words = [actOf(field), beyond?.note].filter(Boolean).join(' ');
  return (
    <li
      data-capability={flag}
      data-on={on ? 'true' : 'false'}
      className="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5"
    >
      {/* The word, not a colour: "On" survives a greyscale screenshot, a
          colour-blind reader and a phone in daylight. Off is the calm state —
          most switches off is the safe shipping default. */}
      <span className={cn('text-body font-medium', on ? 'text-ink' : 'text-ink-muted')}>
        {on ? 'On' : 'Off'}
      </span>
      <Mono value={flag} className="min-w-0 break-words text-ink" />
      {beyond?.where ? (
        <Button asChild size="sm" variant="ghost">
          <a href={settingsHref(beyond.where)}>Open {sectionTitle(beyond.where)}</a>
        </Button>
      ) : (
        <span />
      )}
      {words ? <p className="col-span-2 col-start-2 min-w-0 text-meta text-ink-muted">{words}</p> : null}
    </li>
  );
}

/**
 * Whether this console runs work by itself: only when BOTH are true — the flag
 * that permits spawning, and a convergence loop nobody switched off. Saying so
 * for `--allow-run` alone would claim a `--no-converge` console boards phases
 * by itself, which it does not.
 */
function RunsByItself({ state }: { state: ConsoleState }) {
  const automation = (
    <a href={settingsHref('automation')} className={LINK}>
      {sectionTitle('automation')}
    </a>
  );
  if (state.allowRun === true && state.autopilot !== false) {
    return (
      <p className="max-w-(--measure) text-body text-ink" data-testid="runs-by-itself">
        This console boards phases by itself: the convergence loop retries what stops, and the ladder decides
        how far. {automation} holds every budget and threshold it obeys.
      </p>
    );
  }
  if (state.allowRun === true) {
    return (
      <p className="max-w-(--measure) text-body text-ink" data-testid="runs-by-itself">
        Sessions may be spawned, but the convergence loop is off (<Mono value="--no-converge" />
        ), so nothing boards without a press. {automation} still holds what a press then obeys.
      </p>
    );
  }
  return (
    <p className="max-w-(--measure) text-body text-ink" data-testid="runs-by-itself">
      This console runs nothing by itself. {automation} holds what it would obey with{' '}
      <Mono value="--allow-run" />.
    </p>
  );
}

function CapabilitiesGroup({ state }: { state: ConsoleState }) {
  return (
    <SettingsGroup id="capabilities" title="What this console may do" lead="Decided at launch.">
      <ul className="flex min-w-0 flex-col gap-3" aria-label="Capability switches">
        {CAPABILITIES.map(([field, flag]) => (
          <CapabilityLine key={field} state={state} field={field} flag={flag} />
        ))}
      </ul>
      <RunsByItself state={state} />
      <p className="max-w-(--measure) text-meta text-ink-muted">
        A switch changes nothing until the console restarts with it. The start command below carries every
        one.
      </p>
    </SettingsGroup>
  );
}

/* ---------------- the source ---------------- */

/** How many uncommitted files the glance names before the rest fold. */
const DIRTY_SHOWN = 6;

function FileList({ files, className }: { files: readonly string[]; className?: string }) {
  return (
    <ul className={cn('flex min-w-0 flex-wrap gap-x-3 gap-y-0.5', className)}>
      {files.map((file) => (
        <li key={file} className="min-w-0">
          <Mono value={file} className="wrap-anywhere" />
        </li>
      ))}
    </ul>
  );
}

function Uncommitted({ files }: { files: readonly string[] }) {
  const rest = files.slice(DIRTY_SHOWN);
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="uncommitted">
      <FileList files={files.slice(0, DIRTY_SHOWN)} />
      {rest.length > 0 && (
        <Disclosure label={plural(rest.length, 'more file')} openLabel="Show fewer">
          <FileList files={rest} className="mt-1" />
        </Disclosure>
      )}
    </div>
  );
}

/** The branch, then how far it is from its upstream, as words: "3 ahead, 1 behind". */
function Repository({ repo }: { repo: NonNullable<ConsoleState['repo']> }) {
  const drift = [repo.ahead ? `${repo.ahead} ahead` : '', repo.behind ? `${repo.behind} behind` : '']
    .filter(Boolean)
    .join(', ');
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3">
      {repo.branch ? (
        <Mono value={repo.branch} className="text-body text-ink" />
      ) : (
        <span>No branch checked out</span>
      )}
      {drift ? <span className="tnum">{drift}</span> : null}
    </span>
  );
}

/** A path from the server's home as `~/…`, the whole of it on hover. */
function HomePath({ path, home }: { path: string; home: string | undefined }) {
  return (
    <Mono value={homePath(path, home) ?? path} title={path} className="wrap-anywhere text-body text-ink" />
  );
}

function SourceGroup({ state }: { state: ConsoleState }) {
  const root = state.root;
  const repo = state.repo;
  const dirty = repo?.dirty ?? [];
  return (
    <SettingsGroup
      id="source"
      title="Source"
      aside={
        <Button asChild size="sm">
          <a href={sourceHref()}>Change source</a>
        </Button>
      }
    >
      <KeyValue
        items={[
          ['Directory', root?.path ? <HomePath path={root.path} home={state.home} /> : 'None open'],
          [
            'Plans',
            <span>
              {plural(root?.planCount ?? 0, 'file')} in <Mono value="docs/plans" />
            </span>,
          ],
          ['Handoff folders', <span className="tnum">{root?.handoffCount ?? 0}</span>],
          ['Repository', repo?.available ? <Repository repo={repo} /> : 'Not a git repository'],
          ['Uncommitted under docs/', dirty.length ? <Uncommitted files={dirty} /> : 'None'],
          ['Indexed sections', <span className="tnum">{state.searchDocs ?? 0}</span>],
        ]}
      />
    </SettingsGroup>
  );
}

/* ---------------- the engine and the keys ---------------- */

/** Named figures with a gap between them — never one string glued with dots. */
function Figures({ items }: { items: readonly (readonly [string, number | undefined])[] }) {
  return (
    <span className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5">
      {items.map(([name, tokens]) => (
        <span key={name}>
          {name} <span className="tnum">{weight(tokens)}</span>
        </span>
      ))}
    </span>
  );
}

function EngineGroup({ state }: { state: ConsoleState }) {
  const sizing = state.sizing;
  return (
    <SettingsGroup id="engine" title="Engine">
      <KeyValue
        items={[
          [
            'Scripts',
            state.scriptsDir ? <HomePath path={state.scriptsDir} home={state.home} /> : 'Not reported',
          ],
          [
            'Phase weights',
            sizing ? (
              <Figures
                items={[
                  ['S', sizing.S],
                  ['M', sizing.M],
                  ['L', sizing.L],
                ]}
              />
            ) : (
              'Not reported'
            ),
          ],
          [
            'Session budgets',
            sizing ? (
              <Figures
                items={[
                  ['1M-class', sizing.budgetBig],
                  ['200K-class', sizing.budgetHaiku],
                ]}
              />
            ) : (
              'Not reported'
            ),
          ],
        ]}
      />
      <p className="max-w-(--measure) text-meta text-ink-muted">
        Status, session batches, boot prompts and lint always come from these scripts. The console parses the
        markdown only for the parts they do not expose.
      </p>
    </SettingsGroup>
  );
}

/**
 * What the palette cannot document from inside itself — every key the shell
 * answers, drawn from the ONE table its hooks read (`shell/keymap.ts`, #334),
 * so this card cannot drift from the keys. The same keys are the help sheet's
 * Keyboard table (`content/guide/reference.md`). The 2.x single-letter jumps
 * stay gone: the palette replaced them with one chord that shows its own
 * contents.
 */
function KeyboardGroup() {
  return (
    <SettingsGroup id="keyboard" title="Keyboard">
      <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-6 gap-y-2">
        {KEYMAP.map(({ keys, does }) => (
          <div key={does} className="contents">
            <dt className="min-w-0">{keys.length > 1 ? <KbdChord keys={keys} /> : <Kbd>{keys[0]}</Kbd>}</dt>
            <dd className="min-w-0 text-body text-ink">{does}</dd>
          </div>
        ))}
      </dl>
    </SettingsGroup>
  );
}

/* ---------------- the section ---------------- */

export function EssentialsSection() {
  const { data: state, error } = useConsoleState();

  if (!state) {
    if (error) {
      return (
        <p className="max-w-(--measure) text-body text-ink-muted">
          This console’s state could not be read: {error.message}
        </p>
      );
    }
    return (
      <div aria-busy="true" data-testid="essentials-loading" className="flex min-w-0 flex-col gap-6">
        <Skeleton className="h-28" />
        <Skeleton className="h-48" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  return (
    <>
      <SourceGroup state={state} />
      <CapabilitiesGroup state={state} />
      {/* Directly under the list of what is off: the line that turns any of it on. */}
      <StartCommandGroup />
      <LauncherGroup />
      <EngineGroup state={state} />
      <KeyboardGroup />
    </>
  );
}

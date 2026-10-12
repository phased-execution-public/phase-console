import {
  Bot,
  CircleDot,
  FileDiff,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequestArrow,
  Hand,
  LifeBuoy,
  Moon,
  Plus,
  Power,
  Rows2,
  Rows3,
  SlidersHorizontal,
  Snowflake,
  Sun,
  SunMoon,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import { runStatusWord } from '@shared/status-vocab.js';
import type { ConsoleState, PlanSummary, SlimRun } from '@/data/api';
import type { Density, Theme } from '@/lib/prefs';
import { SURFACE, type SurfaceDoor } from '@/data/surface';
import { visibleNav } from '../nav';
import {
  helpHref,
  insightsHref,
  phaseHref,
  planHref,
  plansHref,
  repoHref,
  runHref,
  runsHref,
  sessionsNewHref,
  settingsHref,
  sourceHref,
  turnHref,
  type Route,
} from '../routes';
import {
  RECORD_KINDS,
  verbArgsOf,
  verbDoorHref,
  verbOffers,
  type Capabilities,
  type VerbOffer,
} from '../panel/verbs';

/**
 * The palette's command registry — go · find · do.
 *
 * An action is a plain object with an `id`, a `group`, a `label` and a
 * `run(context)`. `keywords` widens what cmdk will match it on, `hint` is the
 * muted right-hand column. A *builder* is a pure function from
 * `CommandContext` to `CommandAction[]`, and `paletteActions` is the ordered
 * concatenation of them, so a builder can be unit-tested by calling it.
 *
 * **Go** is every place the nav can send you, plus the heads it lights.
 * **Find** is the plans, the phases that could start, the runs and the
 * settings sections (by what is INSIDE each, from the registry's keys), and —
 * in `results.tsx` — the documents. **Do** is every act the registry knows,
 * from anywhere (§Architecture 5): pressed where the address names its record,
 * opened where it is drawn when it takes more than a press, and — where the
 * address cannot name its record — its terminal line to copy, or its door. The
 * acts only a terminal can do follow, as their lines. A verb the console cannot
 * press says which flag it lacks rather than vanishing.
 */

export interface CommandContext {
  state: ConsoleState | undefined;
  /** Where the palette was opened from — context verbs read this. */
  route: Route;
  plans: PlanSummary[] | undefined;
  runs: SlimRun[] | undefined;
  /** Go somewhere. The palette closes itself around this. */
  go: (path: string) => void;
  setTheme: (theme: Theme) => void;
  setDensity: (density: Density) => void;
  /** Press a registry verb — the act, its route's arguments, and the body its identity rides in. */
  pressVerb?: (
    name: string,
    args: Readonly<Record<string, string | number | undefined>>,
    body: Readonly<Record<string, string | number>>,
  ) => void;
  /** Put a terminal line on the clipboard, and say so. */
  copyLine?: (line: string) => void;
}

export interface CommandAction {
  id: string;
  group: string;
  label: string;
  /** Muted, right of the label — a path, a status, a plan's slug, the flag a verb lacks. */
  hint?: string;
  icon?: LucideIcon;
  /** Extra terms cmdk may match on, beyond the rendered text. */
  keywords?: string;
  /** Keycaps, right-aligned. */
  shortcut?: string[];
  /** Offered but not pressable here, and the hint says why. */
  disabled?: boolean;
  /** An act on a run: pressed twice, the second time to confirm. */
  confirm?: boolean;
  /** The label is a machine value — a verb's name, a terminal line — and is drawn as one. */
  mono?: boolean;
  run: (context: CommandContext) => void;
}

export const GROUPS = {
  go: 'Go to',
  plans: 'Plans',
  runs: 'Runs',
  settings: 'Settings',
  do: 'Do',
} as const;

/** Every place: the seven, the heads a person reaches for by name, and Help. */
export function navigationActions(context: CommandContext): CommandAction[] {
  const { state } = context;
  const items = visibleNav(state).map<CommandAction>((item) => ({
    id: `go:${item.id}`,
    group: GROUPS.go,
    label: item.label,
    hint: item.note,
    icon: item.icon,
    keywords: item.note,
    run: (ctx) => ctx.go(item.id),
  }));
  items.push({
    id: 'go:turn',
    group: GROUPS.go,
    label: 'Your turn',
    icon: Hand,
    hint: 'Everything only you can do, each with its guide',
    keywords: 'needs me needs you approve answer person human step task todo guide check',
    run: (ctx) => ctx.go(turnHref()),
  });
  items.push({
    id: 'go:help',
    group: GROUPS.go,
    label: 'Help',
    hint: 'The guide, over this page',
    icon: LifeBuoy,
    keywords: 'guide docs manual how',
    run: (ctx) => ctx.go(helpHref(undefined, undefined, ctx.route)),
  });
  return items;
}

/** Every plan by name, and the phases that could start. */
export function planActions(context: CommandContext): CommandAction[] {
  const out: CommandAction[] = [];
  for (const plan of context.plans ?? []) {
    if (plan.kind !== 'plan') continue;
    const title = typeof plan.title === 'string' && plan.title ? plan.title : plan.slug;
    const ready = (plan.ready ?? []).filter((n): n is number => typeof n === 'number');
    out.push({
      id: `plan:${plan.slug}`,
      group: GROUPS.plans,
      label: title,
      hint:
        title === plan.slug
          ? ready.length
            ? `${ready.length} ready`
            : undefined
          : ready.length
            ? `${plan.slug}, ${ready.length} ready`
            : plan.slug,
      keywords: plan.slug,
      run: (ctx) => ctx.go(planHref(plan.slug)),
    });
    for (const phase of ready) {
      out.push({
        id: `phase:${plan.slug}:${phase}`,
        group: GROUPS.plans,
        label: `Phase ${phase}`,
        hint: `${plan.slug}, ready`,
        keywords: `${plan.slug} ready next up`,
        run: (ctx) => ctx.go(phaseHref(plan.slug, phase)),
      });
    }
  }
  return out;
}

/** Every run, by the plan it is driving, with what it is doing right now — its own word. */
export function runActions(context: CommandContext): CommandAction[] {
  return (context.runs ?? []).map<CommandAction>((run) => {
    const word = runStatusWord(run);
    return {
      id: `run:${run.slug}`,
      group: GROUPS.runs,
      label: run.slug,
      hint: run.activePhase ? `${word}, phase ${run.activePhase}` : word,
      keywords: `${run.status} run autopilot`,
      run: (ctx) => ctx.go(runHref(run.slug)),
    };
  });
}

/** The settings sections' names, by id — the words Settings draws over each. */
const SETTINGS_LABELS: Readonly<Record<string, string>> = {
  essentials: 'Essentials',
  appearance: 'Appearance',
  automation: 'Automation',
  notifications: 'Notifications',
  accounts: 'Accounts',
  mcp: 'MCP servers',
  permissions: 'Permissions',
  instance: 'This instance',
  everything: 'Everything',
};

/**
 * A registry row's name as plain words: `/api/push/quiet` → `push quiet`,
 * `schedulingPolicy` → `scheduling policy`, `flag --allow-publish` →
 * `allow publish`. The `api` prefix and a path's `:param` say nothing a person
 * would type.
 */
function plainWords(name: string): string[] {
  return name
    .replace(/:[a-zA-Z]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word && word !== 'api');
}

/**
 * Every settings section, searchable by what is inside it: the registry names
 * every key, route, event and verb a section holds, so the thing you type is
 * the control's own name and what you get is the page it lives on.
 */
export function settingsActions(): CommandAction[] {
  const wordsBySection = new Map<string, Set<string>>();
  for (const row of SURFACE) {
    if (row.door?.place !== 'Settings' || !row.door.section) continue;
    const words = wordsBySection.get(row.door.section) ?? new Set<string>();
    for (const name of [row.key, row.path, row.event, row.verb, row.flag]) {
      if (name) for (const word of plainWords(name)) words.add(word);
    }
    wordsBySection.set(row.door.section, words);
  }
  return Object.entries(SETTINGS_LABELS).map(([id, title]) => ({
    id: `settings:${id}`,
    group: GROUPS.settings,
    label: title,
    hint: 'Settings',
    icon: SlidersHorizontal,
    keywords: `settings ${[...(wordsBySection.get(id) ?? [])].join(' ')}`,
    run: (ctx) => ctx.go(settingsHref(id)),
  }));
}

/**
 * The verbs — what this console may do from wherever you are: the four
 * questions a person opens the palette with, the appearance, and every verb
 * the registry knows for this address, each saying when a flag disables it.
 */
export function verbActions(context: CommandContext): CommandAction[] {
  const { state } = context;
  const out: CommandAction[] = [];

  if (state?.allowWrites) {
    out.push({
      id: 'do:new-plan',
      group: GROUPS.do,
      label: 'New plan…',
      hint: 'On Plans',
      icon: Plus,
      keywords: 'create scaffold add',
      run: (ctx) => ctx.go(plansHref()),
    });
  }
  if (state?.allowAgent) {
    out.push({
      id: 'do:agent',
      group: GROUPS.do,
      label: 'Open an agent session',
      hint: 'Interactive Claude, in a terminal',
      icon: Bot,
      keywords: 'claude session interactive launch',
      run: (ctx) => ctx.go(sessionsNewHref('agent')),
    });
  }
  if (state?.allowTerminal) {
    out.push({
      id: 'do:terminal',
      group: GROUPS.do,
      label: 'Open a terminal',
      hint: 'A shell on this machine',
      icon: SquareTerminal,
      keywords: 'shell console bash zsh',
      run: (ctx) => ctx.go(sessionsNewHref('shell')),
    });
  }

  out.push(
    {
      id: 'do:insights',
      group: GROUPS.do,
      label: 'Spend and velocity',
      hint: 'Cost over time against the caps',
      keywords: 'money cost usd budget throughput eta',
      run: (ctx) => ctx.go(insightsHref()),
    },
    {
      id: 'do:repo-branches',
      group: GROUPS.do,
      label: 'Branches and what claims them',
      hint: 'Divergence, run branches, which trees hold them',
      icon: GitBranch,
      keywords: 'repo git branch upstream ahead behind pe lane trunk',
      run: (ctx) => ctx.go(repoHref('branches')),
    },
    {
      id: 'do:repo-trees',
      group: GROUPS.do,
      label: 'Working trees and leftovers',
      hint: 'Where the parallel work is, and what no run claims any more',
      icon: FolderGit2,
      keywords: 'repo git worktree checkout debris orphan prune reclaim lane staging',
      run: (ctx) => ctx.go(repoHref('trees')),
    },
    {
      id: 'do:repo-diff',
      group: GROUPS.do,
      label: 'What changed in the tree',
      hint: 'The working tree against HEAD, or any range',
      icon: FileDiff,
      keywords: 'repo git diff patch changes uncommitted range base tip',
      run: (ctx) => ctx.go(repoHref('changes')),
    },
    {
      id: 'do:repo-settles',
      group: GROUPS.do,
      label: 'Did it land?',
      hint: 'Every run’s settle, and why one did not',
      icon: GitPullRequestArrow,
      keywords: 'repo git settle land merge pr strategy failed pending',
      run: (ctx) => ctx.go(repoHref('settles')),
    },
    {
      id: 'do:repo-issues',
      group: GROUPS.do,
      label: 'The Issues desk',
      hint: 'A repository’s whole issue list — category, severity, plan status — and one click from a set of it to a plan',
      icon: CircleDot,
      keywords:
        'issue issues desk github backlog bug enhancement category severity triage estate plan from issues plan status author label assignee',
      run: (ctx) => ctx.go(repoHref('issues')),
    },
    {
      id: 'do:source',
      group: GROUPS.do,
      label: 'Open a different project…',
      icon: FolderOpen,
      keywords: 'switch root directory repository',
      run: (ctx) => ctx.go(sourceHref()),
    },
    {
      id: 'do:theme-dark',
      group: GROUPS.do,
      label: 'Theme: Night',
      icon: Moon,
      keywords: 'dark appearance colour color',
      run: (ctx) => ctx.setTheme('dark'),
    },
    {
      id: 'do:theme-light',
      group: GROUPS.do,
      label: 'Theme: Paper',
      icon: Sun,
      keywords: 'light appearance colour color',
      run: (ctx) => ctx.setTheme('light'),
    },
    {
      id: 'do:theme-system',
      group: GROUPS.do,
      label: 'Theme: Auto',
      icon: SunMoon,
      keywords: 'system appearance colour color',
      run: (ctx) => ctx.setTheme('system'),
    },
    {
      id: 'do:density-compact',
      group: GROUPS.do,
      label: 'Density: Compact',
      hint: 'Tighter rows, more on screen',
      icon: Rows3,
      keywords: 'dense tight compact spacing padding appearance',
      run: (ctx) => ctx.setDensity('compact'),
    },
    {
      id: 'do:density-comfortable',
      group: GROUPS.do,
      label: 'Density: Comfortable',
      hint: 'Roomier rows, easier to scan',
      icon: Rows2,
      keywords: 'roomy loose comfortable spacing padding appearance',
      run: (ctx) => ctx.setDensity('comfortable'),
    },
  );

  // Freeze all stops every session on the machine mid-token: the palette
  // NAVIGATES to where the button and its confirm live, and fires nothing.
  if (state?.allowRun) {
    out.push({
      id: 'do:freeze-all',
      group: GROUPS.do,
      label: 'Freeze the whole console…',
      hint: 'On Runs',
      icon: Snowflake,
      keywords: 'panic halt stop everything pause console thaw',
      run: (ctx) => ctx.go(runsHref('groups')),
    });
  }

  out.push({
    id: 'do:shutdown',
    group: GROUPS.do,
    label: 'Shut this console down…',
    hint: 'Settings ▸ This instance',
    icon: Power,
    keywords: 'stop quit exit kill restart',
    run: (ctx) => ctx.go(settingsHref('instance')),
  });

  return out;
}

/** Where a door is, in a hint's words: "On the plan’s run", "Settings ▸ Accounts". */
function doorWords(door: SurfaceDoor): string {
  if (door.place === 'Shell') return door.section === 'bell' ? 'In the bell' : 'Here';
  if (door.place === 'Settings') return `Settings ▸ ${SETTINGS_LABELS[door.section ?? ''] ?? 'Settings'}`;
  if (door.head === 'plan') return door.section === 'phases' ? 'On the plan’s phases' : 'On the plan’s run';
  return door.head === 'queue' ? 'On the queue' : `On ${door.place}`;
}

/** The record a press names, in a hint's words: "demo, phase 3". */
function identityWords(identity: VerbOffer['identity']): string {
  const { slug, phase, id, runId } = identity;
  return [slug, phase != null && `phase ${phase}`, id, runId != null && `run ${runId}`]
    .filter((word) => word != null && word !== false && word !== '')
    .join(', ');
}

/**
 * One verb's row. An act the address names the record of is pressed, after a
 * second press to confirm — or, taking more than a press, opened where it is
 * drawn; a read goes where it is drawn. One whose record the address cannot
 * name is its terminal line to copy where this tree's CLI presses it, else its
 * door; a read with neither is left to the page that names its record. A read
 * only a script waits on (`wait`) is only ever its line.
 */
function verbAction(offer: VerbOffer, route: Route): CommandAction | null {
  const needs = offer.needs ? `Needs ${offer.needs}` : undefined;
  const row = {
    id: `verb:${offer.name}`,
    group: GROUPS.do,
    mono: true,
    keywords: `verb ${offer.kind} ${offer.summary}`,
    disabled: Boolean(offer.needs),
  };
  const copy = (line: string): CommandAction => ({
    ...row,
    label: line,
    hint: needs ?? offer.summary,
    keywords: `${row.keywords} copy terminal command line`,
    run: (ctx) => ctx.copyLine?.(line),
  });
  const go = (door: SurfaceDoor, hint: string): CommandAction => ({
    ...row,
    label: offer.name,
    hint: needs ?? hint,
    run: (ctx) => ctx.go(verbDoorHref(door, offer.identity, { name: offer.name, base: route })),
  });
  const { door, line } = offer;
  // A read the registry gives no door — `wait`, a script's long poll — is only ever its line.
  if (offer.kind === 'read' && !door) return line ? copy(line) : null;

  if (!offer.missing.length) {
    const where = identityWords(offer.identity);
    const said = where ? (offer.summary ? `${offer.summary} (${where})` : where) : offer.summary;
    if (offer.mode === 'press') {
      return {
        ...row,
        label: offer.name,
        hint: needs ?? said,
        confirm: true,
        run: (ctx) => ctx.pressVerb?.(offer.name, offer.args, offer.body),
      };
    }
    if (!door) return null;
    return go(door, offer.takes ? `${doorWords(door)} — it takes ${offer.takes}` : said);
  }
  if (line) return copy(line);
  if (offer.kind === 'read' || !door) return null;
  return go(door, offer.summary ? `${doorWords(door)}: ${offer.summary}` : doorWords(door));
}

/** Every operator verb, from wherever the palette was opened — the panel's Actions tab for the record the address names. */
export function registryActions(context: CommandContext): CommandAction[] {
  const capabilities = context.state as Capabilities | undefined;
  return verbOffers(RECORD_KINDS, verbArgsOf(context.route), capabilities).flatMap((offer) => {
    const action = verbAction(offer, context.route);
    return action ? [action] : [];
  });
}

/** A line a terminal runs: what it does, the words it is found by, and the line itself. */
interface TerminalLine {
  id: string;
  line: string;
  hint: string;
  keywords: string;
}

const lineAction = (row: TerminalLine): CommandAction => ({
  id: `line:${row.id}`,
  group: GROUPS.do,
  label: row.line,
  mono: true,
  hint: row.hint,
  keywords: `copy terminal command line ${row.keywords}`,
  run: (ctx) => ctx.copyLine?.(row.line),
});

/**
 * The acts no route answers — only a terminal can do them — as their lines to
 * copy: the console has no door to them, so the palette hands over the words.
 */
export function terminalActions(): CommandAction[] {
  return [
    lineAction({
      id: 'stop-strays',
      line: 'phase-console doctor --stop-strays',
      hint: 'Stop the stray consoles — servers whose own package is gone',
      keywords: 'doctor stray strays orphan process kill stop',
    }),
  ];
}


/** Everything, in the order the groups are meant to be read. */
export function paletteActions(context: CommandContext): CommandAction[] {
  return [
    ...navigationActions(context),
    ...planActions(context),
    ...runActions(context),
    ...settingsActions(),
    ...verbActions(context),
    ...registryActions(context),
    ...terminalActions(),
  ];
}

/** Grouped for rendering, preserving both the group order and the item order. */
export function byGroup(actions: CommandAction[]): [string, CommandAction[]][] {
  const out = new Map<string, CommandAction[]>();
  for (const action of actions) {
    const bucket = out.get(action.group);
    if (bucket) bucket.push(action);
    else out.set(action.group, [action]);
  }
  return [...out.entries()];
}

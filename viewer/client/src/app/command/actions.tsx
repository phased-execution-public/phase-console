import {
  Bot,
  CircleDot,
  FileDiff,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequestArrow,
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
  TerminalSquare,
  type LucideIcon,
} from 'lucide-react';
import { visibleNav } from '@/app/shell/nav';
import { SECTION_SEARCH_TERMS, SETTINGS_SECTIONS } from '@/features/settings/nav';
import { repoHref } from '@/features/repo/routes';
import {
  helpHref,
  insightsHref,
  phaseHref,
  planHref,
  runHref,
  runsHref,
  settingsHref,
  type Route,
} from '@/app/routes';
import type { ConsoleState, PlanSummary, RunState } from '@/lib/api';
import { STATE_META, runUiState } from '@/lib/status-vocab';

/**
 * The palette's command registry.
 *
 * **The API, in one paragraph.** An action is a plain object with an `id`, a
 * `group`, a `label` and a `run(context)`. `keywords` widens what cmdk will
 * match it on (cmdk scores against the rendered text plus this string, so
 * "money" can find Insights). `hint` is the muted right-hand column, `shortcut`
 * the keycap one. A *builder* is a pure function from `CommandContext` to
 * `CommandAction[]`, and `paletteActions` is the ordered concatenation of them.
 * Adding a command means adding it to a builder; adding a KIND of command means
 * adding a builder to that list. Nothing here renders — `palette.tsx` does — so
 * a builder can be unit-tested by calling it.
 *
 * **Gating is a builder's job, not the palette's.** `verbActions` returns
 * nothing for a capability this console does not have, rather than returning a
 * disabled row: a palette is a list of things you can do, and a list padded with
 * things you cannot is a list people stop reading. The one exception is a verb
 * whose absence would be mystifying, which gets a `hint` saying which flag.
 */

export interface CommandContext {
  state: ConsoleState | undefined;
  /** Where the palette was opened from — context verbs read this. */
  route: Route;
  plans: PlanSummary[] | undefined;
  runs: RunState[] | undefined;
  /** Go somewhere. The palette closes itself around this. */
  go: (path: string) => void;
  setTheme: (theme: 'system' | 'dark' | 'light') => void;
  /**
   * The other half of `prefs`' two appearance levers.
   *
   * Theme has been reachable from here since 3.0 and density has not, which
   * made the palette's claim to reach everything false for exactly one
   * preference — and the one an operator changes while looking at a table too
   * loose to scan, which is to say while their hands are already on the
   * keyboard. Settings ▸ Appearance keeps the canonical control; this is the
   * way there without leaving the page.
   */
  setDensity: (density: 'comfortable' | 'compact') => void;
}

export interface CommandAction {
  id: string;
  group: string;
  label: string;
  /** Muted, right of the label — a path, a status, a plan's slug. */
  hint?: string;
  icon?: LucideIcon;
  /** Extra terms cmdk may match on, beyond the rendered text. */
  keywords?: string;
  /** Keycaps, right-aligned. */
  shortcut?: string[];
  run: (context: CommandContext) => void;
}

const GROUPS = {
  go: 'Go to',
  plans: 'Plans',
  runs: 'Runs',
  settings: 'Settings',
  do: 'Do',
} as const;

/**
 * Every settings section, searchable by what is inside it.
 *
 * Phase 11 gave each section an address and Phase 7 made it findable. Until
 * now the palette indexed the eight DESTINATIONS, of which Settings was one
 * row: `⌘K quiet hours` found nothing, and the only route to a setting was to
 * guess which of eight nouns held it. Each row here carries that section's
 * contents as match terms (`SECTION_SEARCH_TERMS`), so the thing you type is
 * the control's own name and what you get is the page it lives on.
 *
 * A row per section rather than per control on purpose: a control has no
 * address, so a row for one could only navigate to its section anyway — and
 * sixteen rows that all go to the same page is a palette that answers every
 * query with a wall.
 */
export function settingsActions(): CommandAction[] {
  return SETTINGS_SECTIONS.map((section) => ({
    id: `settings:${section.id}`,
    group: GROUPS.settings,
    label: section.title,
    hint: section.blurb,
    icon: SlidersHorizontal,
    keywords: `settings ${SECTION_SEARCH_TERMS[section.id] ?? ''}`,
    run: (ctx) => ctx.go(settingsHref(section.id)),
  }));
}

/** The eight destinations, plus Help — everywhere the nav can send you. */
export function navigationActions(context: CommandContext): CommandAction[] {
  const { state } = context;
  // The nav's own filter, so a destination this console cannot offer is not a command either.
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

/**
 * Every plan by name, and the phases that could start.
 *
 * A plan's own row goes to its route map — the page that answers "where is
 * this?" — and a ready phase gets its own row because "start the thing that can
 * start" is the single most common reason to open this palette at all.
 */
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
      // A slug that IS the title says nothing twice.
      hint:
        title === plan.slug
          ? ready.length
            ? `${ready.length} ready`
            : undefined
          : ready.length
            ? `${plan.slug} · ${ready.length} ready`
            : plan.slug,
      keywords: plan.slug,
      run: (ctx) => ctx.go(planHref(plan.slug, 'route')),
    });
    // `/api/plans` sends the queue as bare NUMBERS — the titles live in the
    // plan detail, which the palette does not fetch. A row that says "phase 4"
    // under its plan's name is still the fastest way to reach the thing that
    // could start; the title arrives when Phase 9 puts the detail behind this.
    for (const phase of ready) {
      out.push({
        id: `phase:${plan.slug}:${phase}`,
        group: GROUPS.plans,
        label: `Phase ${phase}`,
        // The slug, not the title: these rows sit under their plan's own row,
        // and a slug is what stays readable at half a palette's width.
        hint: `${plan.slug} · ready`,
        keywords: `${plan.slug} ready next up`,
        run: (ctx) => ctx.go(phaseHref(plan.slug, phase)),
      });
    }
  }
  return out;
}

/** Every run, by the plan it is driving, with what it is doing right now. */
export function runActions(context: CommandContext): CommandAction[] {
  return (context.runs ?? []).map<CommandAction>((run) => {
    const meta = STATE_META[runUiState(run.status)];
    return {
      id: `run:${run.slug}`,
      group: GROUPS.runs,
      label: run.slug,
      hint: run.activePhase ? `${meta.label} · phase ${run.activePhase}` : meta.label,
      keywords: `${run.status} ${run.model} run autopilot`,
      run: (ctx) => ctx.go(runHref(run.slug)),
    };
  });
}

/**
 * The verbs — what this console may actually do, from wherever you are.
 *
 * Every one is gated on the flag that governs it, so the list is a truthful
 * account of this console's capability rather than a menu of disappointments.
 */
export function verbActions(context: CommandContext): CommandAction[] {
  const { state } = context;
  const out: CommandAction[] = [];

  if (state?.allowWrites) {
    out.push({
      id: 'do:new-plan',
      group: GROUPS.do,
      label: 'New plan…',
      hint: 'The scaffold card, on Now',
      icon: Plus,
      keywords: 'create scaffold add',
      run: (ctx) => ctx.go('now'),
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
      run: (ctx) => ctx.go('sessions?new=agent'),
    });
  }
  if (state?.allowTerminal) {
    out.push({
      id: 'do:terminal',
      group: GROUPS.do,
      label: 'Open a terminal',
      hint: 'A shell on this machine',
      icon: TerminalSquare,
      keywords: 'shell console bash zsh',
      run: (ctx) => ctx.go('sessions?new=shell'),
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
    // The four Repo sections a person arrives at the palette wanting, by the
    // question rather than the noun: the destination itself is one keystroke
    // away in the rail, so a palette entry called "Repo" would buy nothing.
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
      hint: 'Where the parallel work is — and what no run claims any more',
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
      run: (ctx) => ctx.go(repoHref('diff')),
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
      label: 'Issues across every repository',
      hint: 'The estate’s open work — and one click from a set of it to a plan',
      icon: CircleDot,
      keywords: 'issue issues github backlog bug estate plan from issues author label assignee',
      run: (ctx) => ctx.go(repoHref('issues')),
    },
    {
      id: 'do:source',
      group: GROUPS.do,
      label: 'Open a different project…',
      icon: FolderOpen,
      keywords: 'switch root directory repository',
      run: (ctx) => ctx.go('source'),
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
    // Density buys space out of padding and never out of ink (design.md §4), so
    // both rows say what they DO rather than naming a setting: "tighter" and
    // "roomier" are the change, and a person choosing one is choosing how much
    // of a table they can see at once.
    {
      id: 'do:density-compact',
      group: GROUPS.do,
      label: 'Density: Compact',
      hint: 'Tighter rows — more on screen',
      icon: Rows3,
      keywords: 'dense tight compact spacing padding appearance',
      run: (ctx) => ctx.setDensity('compact'),
    },
    {
      id: 'do:density-comfortable',
      group: GROUPS.do,
      label: 'Density: Comfortable',
      hint: 'Roomier rows — easier to scan',
      icon: Rows2,
      keywords: 'roomy loose comfortable spacing padding appearance',
      run: (ctx) => ctx.setDensity('comfortable'),
    },
  );

  // Freeze all stops every session on the machine mid-token. It is exactly the
  // `do:shutdown` case — a real act, one fuzzy match away from `f`, `r`, `z` —
  // so the palette NAVIGATES to the board where the button and its confirm
  // live, and fires nothing. `?view=board` because the fleet's shape is a
  // persisted preference, and landing on the table would land beside no control
  // at all.
  if (state?.allowRun) {
    out.push({
      id: 'do:freeze-all',
      group: GROUPS.do,
      label: 'Freeze the whole console…',
      hint: 'The board on Runs',
      icon: Snowflake,
      keywords: 'panic halt stop everything pause console thaw',
      run: (ctx) => ctx.go(runsHref('board')),
    });
  }

  // Shutting the console down is deliberately NOT behind a flag — but it is
  // also not something to hand someone who typed three letters, so it lives on
  // its own page and this only takes them there.
  out.push({
    id: 'do:shutdown',
    group: GROUPS.do,
    label: 'Shut this console down…',
    hint: 'Settings',
    icon: Power,
    keywords: 'stop quit exit kill',
    run: (ctx) => ctx.go('settings'),
  });

  return out;
}

/** Everything, in the order the groups are meant to be read. */
export function paletteActions(context: CommandContext): CommandAction[] {
  return [
    ...navigationActions(context),
    ...planActions(context),
    ...runActions(context),
    ...settingsActions(),
    ...verbActions(context),
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

/**
 * Creating the desktop launcher — one click instead of a copy-and-edit ritual.
 *
 * because a file on a Desktop must carry nobody's machine layout — no root, no
 * port, no allowlisted login — or it goes stale the first time one of them
 * changes, once per copy. What a program still does better than a person
 * copying a file and hunting for line 58 is the rest: every capability switch
 * on, and the console copy to start named.
 *
 * Per platform, honestly:
 *   darwin  the shipped `.command`, CONSOLE_HOME patched, executable — double-click.
 *   linux   an XDG `.desktop` entry running the start command for one console
 *           (`--instance <id>`) in a terminal. Exec lines expand no environment
 *           variables, so the paths are baked absolute; GNOME additionally wants
 *           a right-click → Allow Launching the first time, which the answer
 *           says rather than hides.
 *   win32   not supported natively — the console itself only runs on
 *           darwin/linux (package.json `os`), so Windows means WSL, and a
 *           `.lnk` pointing into a WSL filesystem is a lie waiting to break.
 *
 * Remote access is in neither artifact: every console reads the machine
 * profile (`~/.config/phase-console/fleet.json`) at boot.
 *
 * Everything filesystem-shaped is parameterised (home, platform, source) so
 * the tests never touch a real Desktop.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SKILL_DIR, VIEWER_DIR } from './config.ts';

/**
 * The capability switches, the full set the launcher turns on — and the list
 * the shipped `.command` template derives its own from, so a flag can never be
 * composed by one start path and unknown to another (see LAUNCHER_REV 9; rev 10
 * added --allow-webhooks as a knob plus one FULL_FLAGS record, which is the
 * whole change that derivation bought).
 */
export const FULL_FLAGS = [
  '--allow-writes', '--allow-run', '--allow-terminal', '--allow-agent', '--allow-accounts',
  '--allow-mcp', '--allow-webhooks',
] as const;

export type LauncherPlan = {
  platform: NodeJS.Platform;
  supported: boolean;
  /** Where the artifact would be written. Absent when unsupported. */
  path?: string;
  kind?: 'command' | 'desktop-entry';
  /** What to tell the operator — the WSL story on win32, Allow Launching on linux. */
  note: string;
};

export type LauncherOptions = {
  /**
   * The console the artifact is written for. The `.command` carries nothing of
   * it but its file name (rev 12 — the file picks its console when it runs);
   * the Linux entry starts exactly this one, by id.
   */
  instanceId: string;
  /** Names the file and the entry — `Phase Console — <name>`. */
  instanceName?: string;
  isDefault?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
  /** The shipped template — injectable so tests patch a fixture, not the repo. */
  source?: string;
  skillDir?: string;
  /**
   * The console copy the launcher should start — its package root. Defaults to
   * THIS package, so a launcher written by a hub's own copy starts that copy
   * (rev 11); the knob replaces the discovery walk that assumed a clone under
   * a Claude home.
   */
  consoleHome?: string;
};

/** `$HOME`-relative when possible: the file stays honest if the user renames nothing but their disk. */
function homeRelative(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`)
    ? `$HOME${path.slice(home.length)}`
    : path;
}

/** The platforms Pro can write a launcher for — the two returns inside `launcherPlan`. */
const PRO_LAUNCHER_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux'];

export function launcherPlan(opts: {
  platform?: NodeJS.Platform; home?: string; instanceName?: string; isDefault?: boolean;
} = {}): LauncherPlan {
  const platform = opts.platform ?? process.platform;
  // Reached on win32 here, and on EVERY platform in the free tree, where the
  // two branches above are stripped with the `deploy/` directory they read
  // their template from. So the note has to answer both questions honestly:
  // free says what to do instead, Pro says why Windows is not a platform.
  //
  // A membership test rather than `platform === 'darwin' || …`: in THIS tree the
  // returns above have narrowed `platform` so that those comparisons are
  // provably false, and `tsc` rejects them (TS2367) — while in the free tree,
  // with the region stripped, they are exactly the question being asked. One
  // expression has to typecheck in both, and `includes` does.
  return {
    platform,
    supported: false,
    note: PRO_LAUNCHER_PLATFORMS.includes(platform)
      ? 'The desktop launcher is part of Phase Console Pro. Start this console from a shell '
        + 'with `./start`, or keep a terminal tab on it.'
      : 'Phase Console runs on macOS and Linux. On Windows, install it inside WSL and run the '
        + 'start command in your WSL shell — a Windows shortcut into a WSL filesystem breaks on the '
        + 'first path it touches.',
  };
}

/**
 * The shipped template, ready for a Desktop. Exported for tests.
 *
 * Only CONSOLE_HOME is patched — the copy to start, `$HOME`-relative, empty when
 * the caller wants discovery. Nothing about an instance goes in (rev 12): the
 * file picks its console when it runs, so two consoles rendering it from one
 * copy write byte-identical files, and no copy carries a root, a port or an
 * allowlisted login to go stale.
 */
export function renderCommandFile(source: string, opts: { home: string; consoleHome?: string }): string {
  if (!/^LAUNCHER_REV=\d+$/m.test(source)) {
    throw new Error('the launcher template has no LAUNCHER_REV — refusing to write a copy that cannot detect staleness');
  }
  // The rev-12 knobs must exist before a copy is written: a template old enough
  // to lack INSTANCE is a launcher for ONE root and port, and writing it would
  // bake in exactly what rev 12 took out.
  for (const knob of ['INSTANCE=', 'MAX_SESSIONS=', 'DEFAULT_SKILLS=', 'CONSOLE_HOME=']) {
    if (!new RegExp(`^${knob}`, 'm').test(source)) {
      throw new Error(`the launcher template is missing its ${knob.slice(0, -1)} knob — update the template first`);
    }
  }
  const patched = source.replace(/^CONSOLE_HOME=.*$/m,
    `CONSOLE_HOME="${opts.consoleHome ? homeRelative(opts.consoleHome, opts.home) : ''}"`);
  for (const line of ['WRITES="--allow-writes"', 'RUNS="--allow-run"', 'TERM_FLAG="--allow-terminal"',
    'AGENT="--allow-agent"', 'ACCOUNTS="--allow-accounts"', 'MCP="--allow-mcp"',
    'WEBHOOKS="--allow-webhooks"']) {
    if (!patched.includes(line)) {
      throw new Error(`the launcher template is missing its ${line.split('=')[0]} knob — update the template first`);
    }
  }
  return patched;
}

/**
 * The XDG entry. Exec expands no env vars, so every path is absolute — and the
 * console is named by id, never by root or port, so the registry stays the one
 * place those live (rev 12's rule, on the platform that has no template).
 */
export function renderDesktopEntry(opts: {
  skillDir: string; instanceId: string; instanceName?: string;
}): string {
  const command = [
    `"${opts.skillDir}/start"`,
    `--instance "${opts.instanceId}"`,
    ...FULL_FLAGS,
  ].join(' ');
  // Exec quoting per the spec: the whole argument double-quoted, embedded
  // double quotes and backslashes escaped.
  const exec = `bash -lc ${quoteExecArg(command)}`;
  // Named like the filename (`launcherPlan`): two projects must not put two
  // identically-labelled icons on one desktop.
  const name = opts.instanceName ? `Phase Console — ${opts.instanceName}` : 'Phase Console';
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    'Comment=Local console for phased-execution plans — starts with every capability',
    `Exec=${exec}`,
    'Terminal=true',
    'Icon=utilities-terminal',
    'Categories=Development;',
    '',
  ].join('\n');
}

function quoteExecArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function installDesktopLauncher(opts: LauncherOptions): { ok: true; path: string; note: string } {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const plan = launcherPlan({
    platform, home, instanceName: opts.instanceName, isDefault: opts.isDefault,
  });
  if (!plan.supported || !plan.path) throw new Error(plan.note);

  const skillDir = opts.skillDir ?? SKILL_DIR;
  mkdirSync(join(plan.path, '..'), { recursive: true });
  // Executable either way: a `.command` needs it to run, and GNOME will not
  // even OFFER Allow Launching on a .desktop file without the bit.
  //
  // The `.command` arm is an early return rather than the `else` half of a
  // branch, because its template lives in `deploy/` — Pro — and a marker
  // deletes whole LINES: an `if`/`else` marked here would leave the free tree
  // holding an orphaned brace. `launcherPlan` already reports the launcher
  // unsupported on every platform in that tree, so nothing reaches this arm.
  // The entry starts its console by id. A caller that did not say which one
  // gets a refusal, not an entry whose Exec reads `--instance undefined`.
  if (!opts.instanceId) {
    throw new Error('a desktop entry starts one console by id — no instance id was given');
  }
  writeFileSync(plan.path, renderDesktopEntry({
    skillDir, instanceId: opts.instanceId, instanceName: opts.instanceName,
  }), 'utf8');
  chmodSync(plan.path, 0o755);
  return { ok: true, path: plan.path, note: plan.note };
}

/**
 * Settings ▸ Essentials ▸ Start command (7.0, quiet-console phase 21): the
 * line that starts this console with every capability.
 *
 * ```
 * Start command                                              [Copy the command]
 * The exact line for this console: its source directory, its port, …
 * On macOS, run it in a terminal; Ctrl C stops it.
 *   "$HOME/.claude/skills/phased-execution/start" "$HOME/code/repo" --port 4123 …
 * On Linux the same line works …       On Windows, Phase Console runs inside WSL …
 * This console runs without terminal, agent and mcp: the command changes nothing until …
 * ```
 *
 * The line is composed from the console's own facts by `lib/start-command.ts`
 * — the launch form and the Supervisor quote the same composer — never typed
 * from memory, and the switches it names are that file's `CAPABILITIES`, so a
 * flag cannot be composed and left unexplained here.
 *
 * Two rules shape the text. Paths render as `"$HOME/…"`: the line pastes on any
 * account, and a screenshot of this page carries no username. And the command
 * is stated per platform, because "it works" is a per-OS claim: macOS and
 * Linux run the same shell line, while Windows has no native console at all —
 * the honest Windows answer is the same line inside WSL, said as such.
 *
 * It also says which switches the RUNNING console lacks, because the command
 * changes nothing until a console restarts with it.
 */

import { useConsoleState } from '@/data/console';
import { CAPABILITIES, composeStartCommand } from '@/lib/start-command';
import { KbdChord, Mono } from '@/ui';
import { CopyButton } from '@/ui/copy-button';
import { SettingsGroup } from './setting';

/** A list as a sentence says it: `a`, `a and b`, `a, b and c`. */
function listWords(words: readonly string[]): string {
  if (words.length < 2) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The platform the server runs on, as a person names it. */
function platformName(platform: string | undefined): string {
  return platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : 'this machine';
}

export function StartCommandGroup() {
  const { data: state } = useConsoleState();

  const command = composeStartCommand(state ?? {});
  const composed = CAPABILITIES.map(([, , label]) => label);
  const missing = state
    ? CAPABILITIES.filter(([key]) => state[key] !== true).map(([, , label]) => label)
    : [];
  const otherUnix = state?.platform === 'darwin' ? 'Linux' : 'macOS';

  return (
    <SettingsGroup
      id="start-command"
      title="Start command"
      aside={<CopyButton text={command} label="Copy the command" copiedLabel="Copied the command" />}
    >
      <p className="max-w-(--measure) text-body text-ink-muted">
        The exact line for this console: its source directory, its port, every switch it composes (
        {listWords(composed)}) and every setting it was started with (remote access, the session ceiling,
        default skills). Paths are written from <Mono value="$HOME" />, so the line pastes on any account and
        a screenshot of it carries no username.
      </p>

      <div className="flex min-w-0 flex-col gap-1.5">
        <p className="text-meta text-ink-muted">
          On {platformName(state?.platform)}, run it in a terminal; <KbdChord keys={['Ctrl', 'C']} /> stops
          it.
        </p>
        <pre
          data-testid="start-command"
          dir="ltr"
          className="m-0 min-w-0 rounded bg-ground-deep p-3 font-mono text-meta leading-relaxed whitespace-pre-wrap wrap-anywhere text-ink"
        >
          {command}
        </pre>
      </div>

      <ul className="flex min-w-0 max-w-(--measure) flex-col gap-1 text-meta text-ink-muted">
        <li>
          On {otherUnix} the same line works: the paths in it are this machine’s install, so run it where the
          console is installed.
        </li>
        <li>
          On Windows, Phase Console runs inside WSL: install it there and run the line in your WSL shell (
          <Mono value="wsl" />, then paste it). There is no native <Mono value="cmd.exe" /> form.
        </li>
      </ul>

      {state ? (
        <p className="max-w-(--measure) text-body text-ink" data-testid="start-command-missing">
          {missing.length
            ? `This console runs without ${listWords(missing)}: the command changes nothing until the console restarts with it.`
            : 'This console already runs with every capability.'}
        </p>
      ) : null}

      <p className="max-w-(--measure) text-meta text-ink-muted" data-testid="start-command-left-out">
        These flags are deliberately not composed: <Mono value="--host" /> (the console binds localhost,
        always), <Mono value="--scripts" /> and <Mono value="--log-file" />
        {/* A FRAGMENT, not a bare tail: prettier pulls loose JSX text up onto
            the marker line above, which is how the 6.x card lost this whole
            sentence in the free tree once. An element is a node prettier keeps put. */}
        <>; the guide’s reference table covers them.</>
      </p>
    </SettingsGroup>
  );
}

# Skills, plugins and hooks

Two Settings sections answer what a session carries into its work. **Hooks** says every hook a session
runs and where it came from. **Skills & plugins** (Pro) says what a session can call, what an
unattended one loads, and what that costs its context before it reads a word of the phase.

## Settings ▸ Hooks

The page is read-only. It lists every hook the console knows, and the only one it ever writes is the
presence hook, which comes first.

**Session presence.** This user-scope hook tells the console when any Claude session in its repository
starts, finishes a turn or ends. **Install the hook** and **Remove the hook** edit
`~/.claude/settings.json` and need `--allow-writes`. They merge into the file and never replace it.

**Every hook.** There is one tab per source:

- **Plugin** — the console's own plugin (`hooks/hooks.json`).
- **User** — your `settings.json` in the console's config dir.
- **Project** — this repository's `.claude/settings.json` and `.claude/settings.local.json`.
- **Run** — the settings every supervised session is handed.

Each hook says its event, what it runs, its matcher and its timeout. It also says what happens when the
hook fails:

- *blocks the call if it fails*: the hook has `onFailure: block`, so a hook that cannot start, times out
  or answers garbage stops the call.
- *carries on if it fails*: the CLI's own default.

A run's conditional hooks name the runs that carry them. The relay's `PermissionRequest` hook is
only on a run whose relay is armed.

## Settings ▸ Hooks ▸ hookify rules

When a run starts, the console writes one rule file per wall into the
repository's `.claude/`, named `hookify.pe-<plan>-<rule>.local.md`. The file shape is the hookify
plugin's: front matter with `name`, `enabled`, `event`, `action` (`warn` or `block`) and a `pattern`
or `conditions`, then the words a session is shown. There are four rules:

- **publish** — pushing, opening or merging a pull request, cutting a release, publishing a package.
  It blocks under the shipped `permission.destructive` row. It only warns, naming the exceptions,
  when the plan's row allows some.
- **force-push**, **host** and **secret-files** — the never list. They always block, whatever the
  plan says.

The files are added to the repository's own `.git/info/exclude`, so they never dirty the tree. The
console rewrites only its own `hookify.pe-` files and never touches a rule of yours. A session that
loads hookify reads them, so a person can read the rule instead of hook code. The run's own
`PreToolUse` hook and its `deny` list enforce the same walls whether or not hookify is installed.


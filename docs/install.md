# Install

You need [Claude Code](https://claude.com/claude-code); the skill itself needs just Bash. The
**console** additionally needs **Node 22.18 or newer (or 23.6+) with npm** — its client is built
output: one `npm ci && npm run build` inside `viewer/` per machine. You do not have to remember
that: an unbuilt console serves a page naming the two commands and the exact directory to run them in.

Pick a route. Both give you the skill **and** the console from one tree.
There is no package: the repository is the only channel, and a release is a tag on it —
`docs/releasing.md`.

## Route A — as a plugin *(recommended: one line, updates itself)*

A **plugin** is a package Claude Code installs for you. A **marketplace** is a catalog that lists
plugins. This repository is both — it ships a catalog called `phased-execution-public` containing one plugin, itself.
So installing is one command for each.

**Step 1.** Open Claude Code in any project and type:

```
/plugin marketplace add phased-execution-public/phase-console
```

Claude Code clones this repository, checks the catalog inside it, and remembers it as `phased-execution-public`.
Nothing is installed yet — a marketplace is only a list.

**Step 2.** Install the plugin from that catalog:

```
/plugin install phased-execution@phased-execution-public
```

The `@phased-execution-public` part says which catalog to take it from. It matters once you have several registered.

**Step 3.** Load it:

```
/reload-plugins
```

Or just restart Claude Code. Type `/plugin` to confirm it is listed — that screen also has an
**Errors** tab if something failed.

**What you now have.** The skill, as `/phased-execution:phased-execution` — Claude Code puts every
plugin's skills under the plugin's name so two plugins can both ship a `review` skill without
clashing. Type `/phased` and let autocomplete finish it. You will rarely type it at all: the skill
describes itself well enough that Claude reaches for it on its own when work is phased. You also get
`phase-console`, a command that starts the web app from any directory — the first run serves a page
naming the client's one-time build (`npm ci && npm run build`, with the exact path printed, since a
plugin lives in a cache directory you would otherwise have to hunt for).

**Keeping it current.** `/plugin update phased-execution`. This plugin sets no version number on
purpose, which puts it on the *commit channel*: every push to `main` counts as a new release, and
Claude Code also refreshes in the background. Restart to apply an update. An update moves the plugin
to a fresh directory, so the console will ask for its build once more — same two commands, same
printed path. (The **tagged channel** is the other way out: `vX.Y.Z` tags with a GitHub Release carrying the
packed tarball, cut by hand — no registry and no CI. Same tree, two cadences — the plugin tracks
every commit, the tags track releases, and each tag's notes are on the
[Releases page](https://github.com/phased-execution-public/phase-console/releases).)

**Removing it.** `/plugin uninstall phased-execution@phased-execution-public`, then optionally
`/plugin marketplace remove phased-execution-public`.

## Route B — as a plain folder *(if you want to edit the skill, or script against its path)*

```bash
git clone https://github.com/phased-execution-public/phase-console.git ~/.claude/skills/phased-execution
```

Restart Claude Code. The skill is `/phased-execution` — no prefix, because it is not inside a plugin.
Build the console's client once (`cd ~/.claude/skills/phased-execution/viewer && npm ci && npm run
build`), then start it with `~/.claude/skills/phased-execution/start`. Update with `git pull`, then
rebuild.


## Which route?

|  | Plugin | Clone |
|---|---|---|
| **Install** | two commands, inside Claude Code | one `git clone` |
| **Updates** | automatic, every commit to `main` | when you `git pull` |
| **Skill name** | `/phased-execution:phased-execution` | `/phased-execution` |
| **Console** | `phase-console`, from anywhere | `./start`, from the folder |
| **Lives at** | a per-version cache directory that moves on every update | wherever you cloned it, permanently |
| **Suits** | wanting it present and current, with nothing to maintain | scripting against the path, or editing the skill itself |

Plugin and clone at once works, but you would see the skill twice and pay its always-on cost twice —
pick one of those two for the *skill*.

## Linux, and Windows through WSL2

Every route above works on Linux exactly as written. The differences are
below; there is no native Windows build, and on Windows the whole thing (Claude Code included)
runs inside [WSL2](https://learn.microsoft.com/windows/wsl/install).

- **On WSL, run it in a tmux window** — WSL parks its VM when nothing runs in it, so the console is
  up whenever WSL is.
- **The browser.** On a Linux desktop the console opens via `xdg-open`. On WSL it hands the URL to
  Windows (`wslview`); if nothing can open one it prints the URL — WSL2 forwards localhost, so
  `http://127.0.0.1:4123` in your **Windows** browser just works.
- **The Terminal page (optional).** Its native module (`node-pty`) has no Linux prebuilds, so npm
  compiles it during install *if* build tools exist — `sudo apt-get install -y build-essential
  python3` first. Skipping this loses only
  the in-browser shell: board, writes, autopilot and agent sessions all run without it, and the
  Terminal page names exactly what is missing.


<details>
<summary><b>Installing from a terminal instead</b> — for dotfiles scripts and container images</summary>

```bash
claude plugin marketplace add phased-execution-public/phase-console
claude plugin install phased-execution@phased-execution-public
claude plugin details phased-execution@phased-execution-public      # components + token cost
claude plugin update phased-execution
claude plugin uninstall phased-execution@phased-execution-public
```
</details>

---


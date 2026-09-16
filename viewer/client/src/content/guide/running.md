
## Or copy the one line that starts it

**Settings ▸ Essentials ▸ Start with every capability** composes the exact command from this console's own facts
— its source directory, its port, and all seven switches — and gives you a Copy button.

Paths render as `$HOME/…` rather than absolute, so the line works pasted on any account and a
screenshot of that page carries no username.

## Pick your way in

Every route below runs the same console. The switches are identical whichever you choose; which
install you have changes only the command's name — `./start` inside a clone, `phase-console`
everywhere else.

| You want | Do this |
|---|---|
| To start it from a terminal, here | `phase-console start` |
| To start it from a clone | `./start <repo> [switches]` |
| To reach it from your phone | **Mobile setup** |

How to *install* it in the first place is in `docs/install.md`.

## The seven switches

Each capability is its own flag, because they have very different blast radii and a wider one is
never implied by a narrower one. **All seven are off unless you name them.**

| Flag | What it opens |
|---|---|
| `--allow-writes` | Scaffold plans and handoffs, record QA results, take phase locks, close and reopen plans. It never commits and never pushes. |
| `--allow-run` | **Spawn Claude sessions that edit your repository**, unattended, for hours. The widest of the seven. Nothing on the Autopilot tab starts, stops or approves anything without it. |
| `--allow-terminal` | A **real shell** in the browser, running as you, with no policy in front of it. |
| `--allow-agent` | Interactive `claude` sessions in that shell, and the *New plan with AI* wizard. The CLI still asks before it acts; you answer in the terminal itself. |
| `--allow-accounts` | Register more than one Claude account, choose one per run, and let a run that hits its usage window move to one with headroom. **The usage meters work without it** — only registering accounts is gated. |
| `--allow-mcp` | Register MCP servers, hold their credentials, and attach them to plans and phases, so a phase boards with the servers its work needs. **Reading the registry, the health statuses and the catalog works without it** — only registering and attaching is gated. |
| `--allow-webhooks` | **POST every announcement somewhere else** — a Slack channel, a Discord server, a Telegram chat, your own relay. The only switch that sends anything off this machine, which is why it is its own. Off means no outbound request at all, even for a URL already registered. **Reading the destination list works without it.** |

The startup banner says which are on, and the line at the top of this Guide says what *this* console
can do right now.

> Flags are read once, at startup, so turning one on means restarting.

## Starting it, and stopping it


> **`./start` takes a repository, not a verb.** Its first bare argument is rewritten to `--root`, so
> `./start start` asks for a repository called `start` and `./start list` asks for one called
> `list` — both fail on a directory that does not exist, which reads like the verb is broken. Keep
> `./start` for what it is good at: `./start ~/code/your-repo --allow-run`, and stop it with the
> terminal it is running in.

Before anything runs, `phase-console doctor` says whether this machine is ready — accounts, MCP
servers, the `claude` login, a delivery channel, the presence hooks, the Claude CLI's version.
**When stuck** has the rest.


## Talk to a running phase from any terminal

`btw` puts a question to whichever phase is running right now, without opening the browser:

```bash
btw "are you still on the migration, or did you move on?"
btw --plan my-feature "skip the perf work for now"
```

It finds the console for the directory you are in, or takes `PHASE_CONSOLE_URL`. It needs
`--allow-run`, because it is talking to a live session. The question becomes one more turn in the
same conversation — the context is intact and the phase carries on afterwards.


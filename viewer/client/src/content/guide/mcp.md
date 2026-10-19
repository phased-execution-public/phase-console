# MCP servers

MCP (Model Context Protocol) servers are tools your sessions can call: a browser to check the page
actually renders, an issue tracker to read the ticket that asked for the work, a documentation server
so the model reads the current API instead of recalling an old one.

The console's job here is narrow and specific. Claude Code can already connect to MCP servers on its
own — what it cannot do is tell you, *before* an unattended run spends an hour, that the server the
plan chose was never signed in.

## Adding a server

**From the catalog** — Settings ▸ MCP servers ▸ **Catalog**. It is a short curated list plus the
official registry, which the console reads whole into a copy on this machine once a day and searches
here, so a search answers at once. The first read takes about a minute; the page says so and searches
again when it is in.

**By hand** — **Add by hand** under Registered takes any server: a name, the transport, the command and
its arguments or the address, environment, headers, one secret, and a value for every `${VAR}` the
command writes. From a terminal, `phase-console mcp add --manual '<json>'` sends the same — a file
holding the JSON, or `-` to read it from stdin, when it carries a secret.

**A server whose command writes a `${VAR}` nothing supplies** cannot connect. Its row offers **Fill it
in**; `phase-console mcp fill <id> NAME=<value>` does the same. The value is held like a secret.

## The three places a server gets attached

**The plan.** A line in §Session budget:

```
**MCP servers (every session):** `github`, `context7`
```

and, for a phase that needs something the rest of the plan does not:

```
### Phase 4 — Ship the admin
- **MCP:** `playwright`
```

Both are *registry ids* — what the phase needs, never how to reach it, because the how is
per-machine. They are **unioned**: phase 4 above runs with `github`, `context7` and `playwright`.
This is the durable statement; it lives in the repository and every session gets it.

**The run.** The launch offers the registry in its **Tools** row, under **MCP servers for this run**. What
you tick there is
added to what the plan named — you cannot untick the plan's, because that is a statement about the
work rather than a preference for one afternoon.

**One phase.** The launch's phase matrix has an **MCP** column, with **Extra MCP servers** and a `skip
run's` checkbox that drops the *run's*
servers for that phase. The plan's still apply.

## What happens before a phase starts

The console probes the exact set the phase would run with, using a one-turn `claude -p` that never
gets to think. So a server that is not registered, is switched off, or will not connect is found
before the phase costs anything, rather than an hour into it.

That matters because an unattended session cannot fix it. There is no `/mcp` panel in `claude -p`,
and what the CLI does instead is tell the *model* that the tools are unavailable — so the session
improvises around the missing server and hands back work that used none of what you chose it for.

The probe is the console talking to itself, so it never appears on **Sessions**, and one answer lasts
five minutes: the health clock probes on that period, and a phase boarding inside it reuses the answer
— or joins a probe already running — instead of starting one of its own. Each probe is still an
automatic start, so it counts against the console's start ceiling (see **Autopilot**); a console past
the ceiling lets health go stale rather than probing.

**By default the phase still runs.** It boards without the servers that would not answer, its prompt
names them and tells it to do the work that does not depend on them and to record the rest under
**Outstanding** as an errand for you, and you get one notification per run per server. Change that
under Settings ▸ MCP servers ▸ **When a server cannot be reached** — *Run without it and record an
errand*, or *Park the phase until it is signed in* — for one run with the launch's **If one will not
connect**, or for one phase in its phase matrix. A plan can insist for itself with
`**MCP policy:** require`, and that outranks the run-level choice.

Why not always park? Because `parked` is a settled status, so a run whose ready phases have all
parked has nothing left to start and halts. One signed-out server stopped an eleven-phase plan that
named no MCP servers of its own — the park was built for the phase that truly needs its server, and
was firing for every phase that merely had one attached.

A phase that does park names both doors: sign the server in, or **Continue without these servers**.
Signing it in requeues everything parked on it, including on a run that has already stopped — you do
not have to remember which of six plans was blocked on the thing you just fixed.

## Keep the set small

Three to six. Every attached server puts its instructions and its tool names into the system prompt
of *every* turn, and adds names that can collide with another server's. Connecting one mid-phase also
busts the prompt cache and re-reads the whole context, which is why attachment happens at a phase
boundary and nowhere else.

A run's page shows, per phase, how many times each attached server was actually called. A server
sitting at zero was paid for on every turn and never used.

## Credentials

Three kinds, and the console holds only one of them.

- **OAuth** (Sentry, Linear, Notion, Figma, Vercel…) — press **Sign in** on the server's row (or open
  the row to choose whom to sign in for — this console, or one of its profile accounts). A sheet walks
  every step: the Claude CLI asks the server for a sign-in page; at this machine the browser opens and
  you approve there; from elsewhere — a phone, Tailscale — open the page, approve, and paste back the
  address the browser lands on (it may say the page cannot be reached: that is expected). The CLI gives
  up after five minutes; the sheet counts them down, and a timeout says which step it stopped on. The
  token goes to the Claude CLI's own store, which this console never reads or writes. A second writer
  is how two processes corrupt one login.
- **A token in a header** (GitHub's PAT, for instance) — the console holds this one, in your
  keychain on macOS or a 0600 file elsewhere. It never appears in the registry file, in the UI, or in
  any log.
- **`${VAR}` references** — not a secret, the *name* of one, resolved from the console's own
  environment when a run starts, or from a value **Fill it in** stored. A team can share a plan naming
  `postgres` without sharing a DSN.

A URL that carries its own credential (`?token=…`, or `user:pass@`) is refused on add, with the fix
named: put it in a header, where it is kept.

## When a server changes under you

Every probe records the tool names a server advertised. If they change, a banner says so — *github
connects, but advertises different tools than it did when it was attached.* — and the server's row names
what was added and removed, with **I have checked it**.

This is not paranoia about a moving version number. A server whose tool descriptions change is a
server that can change what your sessions are instructed to do — the descriptions go into the prompt.
It is the documented supply-chain attack against MCP, and having written down what the tools used to
be is the only defence a client can offer.

The console also warns when a server exposes a tool marked as requiring a person to approve every
call. An unattended run can never approve one, so a phase that needs it will stall rather than finish.

## Permissions

MCP tool calls do not reach the console's approval hook — only the CLI's own `permissions.deny` list
constrains them. Settings ▸ Permissions ▸ **What a session may run unasked** understands
`mcp__<server>` (every tool that server
exposes) and `mcp__<server>__<tool>` (one of them). Those rules go into the settings file each run
loads, so they hold whether or not this console is running.

## Flags

Registering a server needs `--allow-mcp`. Reading the registry, the connection statuses and the
catalog does not — seeing what your own sessions connect to is display, not capability.

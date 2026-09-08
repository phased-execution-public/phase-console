/**
 * Setup prompts — the text you hand to Claude Code to get something installed.
 *
 * These live here, in `shared/`, for the same reason the route vocabulary does:
 * the same words appear on the Settings page, in the in-app guide and in the
 * README, and three hand-written copies of an install procedure drift within a
 * release. One string, imported by the page and asserted verbatim against the
 * two markdown files by `test/setup-prompts.test.ts`.
 *
 * These are *setup* prompts, not boot prompts. A boot prompt is composed by
 * `phase-graph.sh` and copied byte for byte — the console never writes one,
 * because a second implementation of it would diverge. Nothing owns "how do I
 * get this installed and reachable", so it is owned here.
 *
 * Each one is written to be pasted into Claude Code as-is, and deliberately
 * stops short of running anything with consequences: anything that would start
 * at login, or keep running after the reader closes the terminal, is the
 * reader's decision and not the assistant's.
 */


/**
 * Install the skill and, if wanted, the console — the README's first prompt.
 *
 * Written for someone who has just found the repository, so it starts before
 * the clone and ends at a URL that either loads or does not. The flags are the
 * one part it refuses to hurry: `--allow-run` spawns unattended sessions that
 * edit a repository for hours, and a reader who pasted a command without being
 * told that has been handed a decision they did not know they were making.
 */
export const INSTALL_PROMPT = `Install the phased-execution skill for me, and ask before each step.

1. Install the skill itself, whichever way I prefer — offer both:
     Plugin:  claude plugin marketplace add phased-execution-public/phase-console
              claude plugin install phased-execution@phased-execution-public
     Clone:   git clone https://github.com/phased-execution-public/phase-console \\
                ~/.claude/skills/phased-execution
   Claude Code discovers the SKILL from either. If I already have it, update it
   the same way instead and tell me what changed.
2. Ask which repository holds my work. The console reads plans from
   <repo>/docs/plans and handoffs from <repo>/docs/handoffs; it will not start
   without docs/plans, so create it if I say to.
3. Ask whether I want the web console at all. The skill works without it — it is
   scripts and markdown. For a plugin or clone, build its client once:
     cd <skill>/viewer && npm ci && npm run build
4. Before enabling anything, explain these one at a time and let me answer each:
     --allow-writes   scaffold plans/handoffs, record QA, take locks, close plans
     --allow-run      spawn unattended Claude sessions that edit my repository
                      for hours — the widest of the seven, say so plainly
     --allow-terminal a real shell in the browser, running as me
     --allow-agent    interactive claude sessions and the New-plan wizard
     --allow-accounts register Claude accounts and switch between them mid-run
     --allow-mcp      register MCP servers and attach them to plans and phases
     --allow-webhooks POST every announcement to a Slack/Discord/Telegram URL
   Default every one of them to off. Then start it with only what I chose:
     bash <skill>/start --root <repo> [flags]
5. Open http://127.0.0.1:4123 and confirm it loads. If it does not, tell me
   exactly what it printed.
6. Finish by listing what you enabled, what you left off, and how to change it.

Do not turn on a flag I did not agree to, and do not start a phase run to
"test" it — a run edits my repository.`;

/**
 * Turn a loopback console into one a phone can open — the README's second prompt.
 *
 * The order is the whole point. `tailscale serve` publishes 443 immediately,
 * but the console refuses every proxied request until `--remote` names the
 * hostname it now answers to, so serving first and restarting second is the
 * sequence that never leaves a window where the URL is live and broken. The
 * hostname and login are read out of the CLI rather than typed, because both
 * are easy to mistype and the failure mode — a 421 or a 403 — reads like the
 * feature is broken rather than like a typo.
 */
export const TAILSCALE_PROMPT = `Make my Phase Console reachable from my phone over Tailscale.

1. Check the ground first and stop if any of it is missing:
     tailscale status            is it installed, and signed in?
     tailscale status --json     read MagicDNSSuffix, CurrentTailnet.MagicDNSEnabled,
                                 Self.DNSName and User for my login
   If MagicDNS is off, or HTTPS certificates are not enabled for the tailnet,
   tell me to turn both on in the Tailscale admin console (DNS → MagicDNS, and
   DNS → HTTPS Certificates) — they are tailnet-wide settings you cannot set
   from here — then wait for me.
2. Publish the console on the tailnet, on 443, still bound to loopback:
     tailscale serve --bg --https=443 http://127.0.0.1:4123
   Use my real port if it is not 4123. Confirm with: tailscale serve status
3. Restart the console so it answers to that hostname, keeping every flag it
   already has — read them from how it is running right now, never guess:
     bash <skill>/start --root <repo> [existing flags] \\
       --remote <Self.DNSName without the trailing dot> \\
       --remote-user <my login>
   Without --remote the console refuses proxied requests with a 421, so the URL
   would resolve and then fail. With it, the console still listens only on
   loopback: Tailscale terminates TLS, proves who is calling, and forwards.
4. Print the https URL and confirm it answers from this machine.
5. Then tell me what to do on each device I want to use:
     - install Tailscale and sign into the SAME tailnet
     - turn on MagicDNS / "Use Tailscale DNS"
     - open the URL
     - on iOS, add it to the Home Screen — notifications only work from there
   Only devices on my tailnet, signed in as an allowed user, can reach it.

Never widen --host to expose the console on a network interface. The identity
header is trustworthy only because nothing but the proxy can reach the port.`;

/** Everything above, by id, so a surface can enumerate rather than hard-code. */
export const SETUP_PROMPTS = [
  {
    id: 'install',
    title: 'Install phased-execution',
    lede: 'Skill, console and flags — each door explained before it is opened.',
    prompt: INSTALL_PROMPT,
  },
  {
    id: 'tailscale',
    title: 'Reach this console from your phone',
    lede: 'Publish it on your tailnet over HTTPS — still bound to loopback, still private.',
    prompt: TAILSCALE_PROMPT,
  },
];

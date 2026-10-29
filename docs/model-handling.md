# Model handling

Everything about sizing flows from the model you are running.

| Model | Window | Session budget *(phase weight)* | Best used for |
|---|---|---|---|
| **Opus** 5.5 / 5 / 4.8 | 1M | **~200K** | the default executor (Opus 5.5 is the latest: `opus` → `claude-opus-5-5`); hard reasoning and architecture |
| **Fable 5** | 1M | **~200K** | planning, and the most demanding long-horizon phases |
| **Sonnet** 5 / 4.6 | 1M | **~200K** | balanced implementation phases |
| **Haiku 4.5** | 200K | **~40K** | subagents and side work — a 200K window cannot hold the floor of a phase session |
| *unknown / unspecified* | — | **~40K** | assumes a 200K effective window |

These numbers live in one place, [`scripts/sizing.env`](../scripts/sizing.env), which the engine reads
directly — so the docs and the tool cannot drift apart. Edit that file to change them globally.

**Why weight, and why 0.2×.** A phase's weight estimates the working set its work adds — bootstrap
reads, files opened, tool output, diffs. What a session's context
actually is, is measured rather than a multiple of the weight: a floor every session pays before its work
counts (the boot and the work every phase does), plus a slope × the weight
([`references/sizing.md`](../references/sizing.md) §The session model). The target is 60% of the window;
on a 1M model about 129K of weight fits under it, so the ~200K preset is a ceiling the measured model
tightens.

> ⚠️ **Check your *effective* window, not the model's maximum.** A session can be configured with a
> 200K window even on a 1M-capable model. Budget ≈ 0.2 × the window you actually have.

**Per-phase model choice is a lever too.** Hard reasoning on Opus or Fable, balanced implementation on
Sonnet, and Haiku for subagents and side work. One caveat: switching models mid-session throws away
the prompt cache, so keep one model per session — a wanted model switch is one of the few things that
*earns* a session boundary.

**Keeping a session lean** stretches the budget: push broad code search and multi-file exploration
into subagents that read a lot and return a short summary, so those tokens never enter the phase
session. Do not over-delegate — a single file read is faster done directly.

---


## Whose logins and keys a session spends

Every account the console starts a session on is **the operator's own**, spent on the operator's own
machine — the console never offers, resells or intermediates anyone else's Claude usage. The pool
rotates among those accounts and no others. What each
kind is (Settings ▸ Accounts ▸ Inspect ▸ Overview says the same in one line):

| Kind | What it is |
|---|---|
| `default` | your own Claude subscription, signed in through the unmodified `claude` binary on this machine |
| `profile` | another of your own Claude logins, signed in through `claude` itself into a config directory of its own |
| `token` | your own long-lived setup token (`claude setup-token`), kept in this machine's keychain and handed to the sessions you start |

The reading of Anthropic's terms behind this table is the 2026-10-17 ecosystem audit's (its chapter
on the Anthropic platform, §1, which quotes `code.claude.com/docs/en/legal-and-compliance`), cited, not
argued here; it is not legal advice.

**What a dollar on a screen is.** Every figure is drawn with its word — `reported` (a provider's own
meter: the bridge's exact usage, the Usage & Cost Admin API), `estimated` (a client-side list price: the
CLI's `total_cost_usd`, the price book `viewer/shared/price-book.js` × tokens) or `unavailable` (no
balance, no meter, a model nobody prices) — and never a zero that means unknown
(`viewer/shared/money-model.js`).

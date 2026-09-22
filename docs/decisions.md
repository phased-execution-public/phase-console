# Decisions

Every question a run could ask a person, answered before it starts.

Phase Console exists to make plan implementation automatic. The one thing that made it not so was
the ask that arrives *during* a run: a credential nobody holds, an account an organisation policy
blocks, a gate nobody categorised, a wait nobody bounded — each discovered after the phase was paid
for, each parked or filed as an errand, each with an answer that existed before the run began. The
**decision manifest** moves those answers to the front: a plan carries them, both engines read them,
and a session that hits one anyway declares it *by key* instead of asking in prose.

## The table

A plan's `## Decisions` section holds one row per **key** of a closed vocabulary:

| key | value | owner | state | blocking | source | evidence |
|---|---|---|---|---|---|---|
| `credentials` | `gh` and the machine `claude` login | operator | answered | yes | plan | errand E7 |
| `waits` | | dev-lead | outstanding | yes | plan | to be bounded before phase 6 |
| `qa.exhausted` | QA is off on this plan | operator | waived | no | plan | decision 4 |

The eighteen keys, and what each answers:

| key | what it decides |
|---|---|
| `permission.policy` | this plan's ask / deny / allow overlay, and whether an `ask` means a real tap |
| `permission.destructive` | publishing and destructive verbs: `deny`, with named per-phase exceptions — a clause beginning with `allow` naming backticked rules (`` deny; allow `Bash(gh pr create:*)` ``) is the one thing that lets auto-grant answer a publishing ask (`git push`, `gh pr create`), and each such grant is announced |
| `issues` | whether a session may open an issue for a defect it finds OUTSIDE its phase: `off` (it may not ask — the default, because an outward write on somebody's repository is never one), `draft` (it writes a draft, the console holds it in the inbox and a person approves), `file` (it files at once). Budgeted three per phase and ten per run, and filed through one allow-listed `gh` writer under `--allow-publish` — the cap is what turns four reports of one broken lock into the one issue a person can act on |
| `credentials` | the credential ids every phase needs, and whether a missing one refuses the phase (`require`) or runs it and reports (`continue`) |
| `accounts` | which Claude accounts may spend, in order, and the minimum five-hour headroom each must show |
| `mcp` | the MCP servers, and what happens when one will not connect |
| `gates` | that every `*(GATED)*` heading carries a `Gate-check`, and whether human gates are delegated |
| `verification.person-check` | allow, halt, or an owner, when a §Verification fragment is prose |
| `qa.exhausted` | waive, halt, or an owner, once the QA round budget is spent |
| `waits` | each expected external wait: what, whose clock, the `--watch` ref, the maximum window |
| `human-acts` | steps denied to an agent, each with the ref that proves it landed |
| `ambiguity` | ruling, ask or halt when the plan did not decide — and, on a run whose relay is not armed, the answer to a question a session asks mid-run (`AskUserQuestion`): `ruling` tells it to decide and record the call, `ask` and `halt` to declare `needs-human`. A relayed question's answer is filed under this key too, as a ruling |
| `budgets` | run, phase and turn ceilings |
| `resume.on-restart` | continue, hold or ask — the **run's** answer, not the console's preference |
| `plan-health` | whether the advisory lints gate this plan |
| `stop` | `autonomy`, and who is told when the run halts |
| `relay` | `off` (shipped) or `last-resort`. `last-resort` arms only on a phase session, at a CLI whose `system/init.claude_code_version` reads at or above 2.1.268 (else that session keeps `--permission-prompts none` and the run journals `run.relay-refused`): a question a session raises is held 60 s for a person, then answered at 55 s by a relay rule, else its sole `(Recommended)` option, else its first — never a multi-select, a destructive option, a deny-list match, a stopped run, a repeated question or a phase's ninth, which go to a person ([The relay](#the-relay)) |
| `announce` | which categories push, to whom, on which origin |

Each row also says who **owns** it, its **state** — `answered` (a value stands), `outstanding`
(somebody still owes it; the owner says who), `waived` (it does not apply here, the reason as its
value) — whether it **blocks** a run from starting while outstanding, its **source** (`plan`, `run`,
`default`, `ruling`) and its **evidence**. Columns are read by name, so the order is yours; bold and
backticks around a key or a state are decoration.

## How the rows get answered

**At plan time.** The skill's plan mode asks each decision with one question, the recommended
default first, and writes the row. The template ships the skeleton with the shipped defaults already
answered — `gates: delegated`, `qa.exhausted: waive`, `resume.on-restart: continue`,
`ambiguity: ruling` — and every other row `outstanding`, owned by the operator.

**Later, without editing the plan.** Answers that arrive after the plan was committed go to a twin,
`docs/handoffs/<slug>/decisions.md`, that only `scripts/decisions.sh` writes:

```bash
scripts/decisions.sh <slug> answer waits --value "gh:acme/widgets#run/1 · 45m" --by me
scripts/decisions.sh <slug> --phase 4 waive relay --reason "phase 4 is hand-driven"
scripts/decisions.sh <slug> promote --from-ruling 34ebc941c2f6 [--key ambiguity]
scripts/decisions.sh <slug> list
```

The engine merges the twin **over** the plan's rows: a twin row replaces the plan's whole row for its
key, and a row written with `--phase N` replaces both, for that phase only. Never edit the twin by
hand — the script writes exactly the shape the readers parse and checks its own row back through the
engine, so a table nobody can read is never left behind.

**From a ruling.** What a session decided on the way is the next plan's question, so a ruling that
names its decision key (`phase-outcome.sh <slug> <N> ruling --needs <key> …`) can become a row
without anyone retyping it: `promote` finds the ruling by the id the script stamped on its line (the
ruling line, never its ack) and writes its `--what` as the value with `source: ruling` and the id as
evidence — `--key` is only needed for a ruling that carries none. The session can do it as it
records (`--remember plan`), a person from the inbox row every keyed ruling raises (**Remember for
this plan**), and either way the ruling is then acknowledged in the ledger by name.

**On this console rather than in a plan.** The same inbox row offers **Remember on this console**
when the ruling's words are an answer the key can hold: that writes the console's own `policy.<key>`
(Settings ▸ Automation ▸ Policy answers — every row of the policy table, edited in place, each change
journalled as `policy.changed`), which every plan whose manifest is silent on the key then reads.
A session asks for the same with `--remember global`, which reaches the owning console over
`POST /api/run/<slug>/rulings/<id>/remember` and says so when none answers.

## Reading it back

```bash
scripts/phase-graph.sh <slug> --decisions        # every row as it holds, in vocabulary order
scripts/phase-graph.sh <slug> --decisions 4      # resolved for phase 4
```

One line per row — `key`, `state`, `owner`, `blocking`, `source`, `value`, tab-separated. The
console's Source tab shows the same rows, and every phase's boot prompt carries them, `outstanding`
first, so a session sees what nobody has answered before it starts.

## What the lint refuses

`validate.sh` fails a plan — not warns — on an `outstanding` row with no owner, a key outside the
vocabulary, a state outside the three, a source outside the four (all **F25**); on a `*(GATED)*`
heading with no `Gate-check` (it reads as `ai` until it has one) or a directive whose type is not on
the list (**F24**); and on an open phase whose §Verification holds nothing runnable (**F14**). A plan
with no `## Decisions` section at all has no rows and passes: the manifest is opt-in until a run
asks for it.

## Before a run starts — the prelude

Since 5.0.0 the console reads the manifest at the run door, not mid-run. `Service.startRun` runs the
**prelude** (`viewer/server/prelude.ts`): the rows as they hold (plan, twin, and for a plan with no
`## Decisions` a row synthesised as `answered` from the run's own fields and the policy defaults —
never `outstanding`), then five probes, each over the console's own facts and never over a secret's
value:

| Probe | What it checks | When it refuses |
|---|---|---|
| **accounts** | every declared account's registration, sign-in, entitlement and five-hour headroom against its `minHeadroomPct`. With no accounts on the form and no `**Accounts:**` clause, the run may spend the machine login alone — `[{id: default, minHeadroomPct: 0}]`, the headroom verdict's own wall still applying | only when every declared account is unusable; one usable account starts the run, the rest are warnings |
| **mcp** | `Mcp.preflight` over the plan's servers and the run's | only under `require` |
| **credentials** | the plan's ids, by presence: `gh`, `claude`/`claude-login`, `env:NAME`, `keychain:SERVICE`, `file:PATH` | only under `require`; an id nobody can probe is `skip`, never a refusal |
| **verification** | every open phase's §Verification, through the same review boarding asks (`runner/verify-review.ts`): what the runner will run, what it will not and why, under the phase's Person-check and the draft's answers (`verifyAnswers` — exact commands approved by fingerprint, `<phase>:<fp>` fragments waived) | when a phase in the run's scope would PARK on a named command or fragment (`Person-check: halt`) or ALWAYS ask (`halt-on-everything`), under the `verification.person-check` row, until each is approved (only where an approval can make it run) or waived; a park with nothing to name, a Setup refusal, a missing binary and a phase outside the scope are warnings |
| **delivery** | a channel an unattended run can announce on: a subscribed device; a notifier — `PHASE_CONSOLE_NOTIFY`, else the machine profile's `notifyCommand` (`~/.config/phase-console/fleet.json`, this console's override first); or a webhook, the profile's `webhooks[]` rows counting beside this console's own. With `--remote`, Tailscale must also be running and serving our port | when there is no channel, unless the start acknowledges it |

A probe that could not run answers `skip` and refuses nothing.


**The breaker is learned, and a check can teach it.** The accounts probe reads what the machine has
learned about each credential — `<stateHome>/accounts/learned.json`, one file every console on the
machine shares — so a wall or a refusal one console met is one every other console already knows. A
credential nothing has judged yet reads `unknown`. The one-turn check,
`POST /api/accounts/<id>/probe-entitlement`, runs one real session under the account before a run
spends: a refusal retires the credential, a success promotes only `unknown` → `entitled` and moves
no other state, and a check that could not be asked (signed out, a missing token, a timeout) moves
nothing. Each check is kept on the credential as `probe`, with its age, its cost and how many there
have been.

**What refuses, and the ways past.** A blocking row still `outstanding`, a `waived` row the start did
not acknowledge (`acknowledgedWaivers: [<key>]`), or a failed blocking probe is a **409** naming
each one. The template marks `blocking: yes` on `permission.policy`, `permission.destructive`,
`credentials`, `accounts`, `human-acts` and `relay` (`MANIFEST_BLOCKING`). A start with no delivery
channel is admitted only with `acknowledgedWaivers: ['announce']`, which records the `announce` row as
`waived`, source `run`, with the reason. `manifestOverride` starts anyway and journals
`run.manifest-override {rows, by}`; `run.start` echoes the resolved manifest so the journal says what
was answered, by whom, and what merely defaulted. Three of the run's fields are the answers to three
rows — `resumeOnRestart`, `relay`, `accounts` — and are required at the HTTP door. A resume
(`resumeRunId`) skips the prelude: the door asked when the run first started. The same probes run by
hand as `phase-console doctor`.

## Mid-run — the policy table

Every class of intervention the console used to ask a person about has a row in
`viewer/shared/policy-model.js` (`POLICY_TABLE`, 18 rows), tied to the manifest key that answers it.
The answer in force is the run's own (for `resume.on-restart` and `relay`), else the plan row's, else
this console's `policy.<key>` preference (Settings ▸ Automation ▸ Policy answers), else the shipped
default. When that answer needs no person the console acts and journals
`phase.policy-answered {decisionKey, answer, source}` instead of writing an errand, and the inbox
raises an `fyi` **Policy answered** row naming the key, the answer, where it came from and the
shipped default — the console deciding in your name is something you can see, and change.

| Class | Answered by | No person when the answer is | What the console does | Journal |
|---|---|---|---|---|
| `tool-ask` | `permission.policy` | — | A tool call the profile would ask about: the plan's rule, else the profile's, else deny and continue. | `phase.tool-denied` |
| `carve-out` | `permission.destructive` | — | `git push` and `gh pr create`: a card for a person that auto-grant never answers, unless this row names the rule after `allow` — and then the grant is announced. | `phase.tool-denied` |
| `verification-prose` | `verification.person-check` | `allow` | A §Verification fragment written as prose: allow (waived by policy), halt at boarding, or ask the owner. | `phase.verify-waived` |
| `manual-gate` | `gates` | — | A manual gate: delegated to the session that can evidence it, else the operator approves it. | `phase.gate-delegated` |
| `credential-block` | `credentials` | — | A credential the plan named: `require` refuses the phase at boarding, `continue` runs it and reports the gap. | `phase.credential-preflight` |
| `permission-block` | `permission.policy` | — | A session blocked by a permission rule: one rung, widen the rule, offered as a card. | `phase.widen-decided` |
| `gate-block` | `gates` | — | A session waiting on an approval: the `gates` row; an undeclared gate is a lint failure, not an ask. | `phase.gated` |
| `external-block` | `waits` | — | An external clock: the row's window, the cap told to the session; no watch ref means refused. | `phase.waiting` |
| `lock-block` | `waits` | `window` | A peer holds the scope: queue behind it and name it; never force-release a live session. | `phase.queued` |
| `unknown-block` | `ambiguity` | never — pinned | A block whose key the manifest lacks: always an errand, as a defect report. | `phase.errand` |
| `entitlement-wall` | `accounts` | — | An organisation refuses the account: retire it for the run, switch by rank, break the circuit by orgId. | `run.account-retired` |
| `resource-wall` | `accounts` (the budget wall: `budgets`) | — | A usage or budget wall: the `accounts` row's `onLimit` and the `budgets` row's ceilings. | `phase.live-wall` |
| `resume-on-restart` | `resume.on-restart` | `continue` | A console restart stopped the run: the run's own answer — continue, hold, or ask. | `phase.resume-automatic` |
| `qa-exhausted` | `qa.exhausted` | `waive` | The QA round budget is spent: waive naming the policy, halt, or hand the verdict to the owner ([QA gating](qa-gating.md)). | `phase.qa-waived` |
| `plan-health` | `plan-health` (a phase stopped mid-work or never started: `budgets`) | — | The plan or the phase cannot progress: the repair rungs first; a red lint refuses the boarding. | `phase.rung` |
| `mcp-sign-in` | `mcp` | — | An MCP server will not connect: continue without it, or require it and park. | `phase.mcp` |
| `ambiguity` | `ambiguity` | `ruling` | The plan did not decide: record a ruling and continue, ask, or halt. | `phase.ruling` |
| `human-only` | `stop` | — | Stop, ask/steer and a foreign session's prompt are a person's; what the console owes them is a record. | `run.stop-requested` |

**The shipped defaults** (`POLICY_DEFAULTS`) are the operator's four — `gates: delegated`,
`qa.exhausted: waive`, `resume.on-restart: continue`, `ambiguity: ruling` — and what the console
already did before the class had a name: `verification.person-check: operator` (a prose check is
asked of the operator), `credentials: continue`, `mcp: continue`, `relay: off` and `waits: window`.
Every other key has no shipped answer; nothing answers it until a plan or this console does.

## The relay

`relay` is the one row that lets the console answer a question a session asks mid-run
(`AskUserQuestion`) — the last resort, after the plan and the policy table.

**`off` — the floor.** The shipped answer. Every session of the run carries `--permission-prompts
none`, the floor for a run nobody can answer, and a question it asks anyway is the `ambiguity` row's.
The flag needs CLI 2.1.259 (`PERMISSION_PROMPTS_CLI_FLOOR`): a CLI known to be older runs without
it, and the run journals `run.permission-prompts-skipped {version, floor, relay}` once. A version
nobody has read still gets the flag, on purpose — an old CLI then fails loudly at spawn instead of
dropping the floor with nobody told.

**`last-resort` — armed per session, at a CLI that can carry it.** Only a session of mode `phase`
arms, and only when the newest `system/init.claude_code_version` any session on this console
reported reads at or above 2.1.268 (`RELAY_CLI_FLOOR`, the first release whose `PermissionRequest`
hook fires in `--print`). A version nobody has read refuses, so a fresh console's first session runs
on the floor and its own `system/init` arms the next; a refusal keeps that session on
`--permission-prompts none` and is journalled once per run as `run.relay-refused`.

**The window.** An armed question is `phase.question-raised`, a `session-ask` push and a `question`
row in the inbox — one button per option, with its countdown. A person who picks inside 60 s
(`RELAY_WINDOW_MS`) wins. At 55 s the console answers, with no model call, in one order: a relay
rule, else the sole option labelled `(Recommended)`, else the first option. Every answer is
`phase.question-answered {by}` (`human`, `rule`, `recommended` or `first-option`) and a ruling row
filed under `ambiguity`. When nobody answered, the session is told, question by question:

> No operator answered within 60 s. The console answered `<label>` by `<rule>`. This is NOT a change
> to the phase. If that answer is wrong, declare `blocked --needs ambiguity` rather than asking again.

What is never answered by rule — a deny-list match, a multi-select, a destructive option, a stopped
run, a repeated question — and the budget of eight questions a phase (`RELAY_QUESTIONS_PER_PHASE`)
are in [Safety rails](safety-rails.md); each goes to a person as `phase.question-unanswerable {reason}`.

**Relay rules.** `relayRules` is this console's table, edited under Settings ▸ Automation ▸ Policy
answers and shipped empty (`RELAY_RULE_DEFAULTS`) — a shipped rule would be the console deciding a
question nobody has seen. A rule is `{tool, key, profile, answer}`: `tool` defaults to
`AskUserQuestion`; `key` is a glob over the question's key, its header and the head of its text as one
slug (`colour:which-colour-should-the-banner-be`); `profile` is `*` or one permission profile; and
`answer` names an option label exactly, or as the one label it is a prefix of, case-insensitively. A
rule whose answer names no option of the question does not apply, and the order falls through. At
most 50.

**Remember as a relay rule.** A relayed answer's ruling raises an inbox row whose one action is
**Remember as a relay rule** (`POST /api/run/<slug>/rulings/<id>/remember` with `{"scope": "rule"}`):
it adds "this question, this answer" to `relayRules` for every profile and acknowledges the ruling.
It is never a `## Decisions` row — `ambiguity`'s value is a policy word, not an option label.

## When a session needs a decision anyway

A `blocked` or `needs-human` declaration names its key — `--needs` is required, and the script
refuses the declaration without it:

```bash
scripts/phase-outcome.sh <slug> <N> blocked --needs credentials --reason "no deploy key on this box"
scripts/phase-outcome.sh <slug> <N> needs-human --needs gates --reason "the release gate wants a person"
```

The key is one of the eighteen, or a blocker class as its short form — `credential`, `permission`,
`gate`, `external`, `lock`. The runner reads it **before** the prose: `--needs credential` classifies
as a credential block whatever the sentence says, and a block whose key the manifest lacks is a
defect report rather than an errand. `--rule` and `--command` structure a permission block beside it.

# Documentation

The [README](../README.md) is deliberately short — two prompts and what the thing is. Everything
below is the long version, in the order it is worth reading.

## Start here

| | |
|---|---|
| [Overview](overview.md) | What problem this solves, the three levers it actually pulls, and the whole idea in one picture. |
| [Install](install.md) | The manual routes — plugin or plain clone — and the platform notes. |
| [Your first plan](first-plan.md) | Seven steps from "I want this built" to a plan that is building itself. |

## How it runs

| | |
|---|---|
| [The loop](loop.md) | The autopilot's specification: the three modes, how a stopped phase is read (situations), what the machine tries before it asks (the ladder), convergence, session presence, and what is still a person's. |
| [The artifacts](artifacts.md) | Plan, handoff, memory, and the optional QA record — one job each, never duplicated. |
| [What you control](controls.md) | Every knob — the launch defaults and the ladder's caps and toggles — plus the full command reference for the engine and its helpers. |
| [Session budget](session-budget.md) | The eleven decisions a plan records: model, budget, phase size, batching, QA, branch, skills, gates, MCP servers, docs root, and the decision manifest. |
| [Decisions](decisions.md) | The decision manifest: every question a run could ask a person, answered before it starts — the `## Decisions` table, the twin `decisions.sh` writes, and `--needs`. |
| [Model handling](model-handling.md) | How a phase's model is chosen, and what changes when you run a different one. |

## Gates and safety

| | |
|---|---|
| [QA gating](qa-gating.md) | Off by default. What turning it on actually blocks, and why a recorded `fail` outlives the switch. |
| [Safety rails](safety-rails.md) | What an unattended session may and may not do, and what stops it. |

## The console

| | |
|---|---|
| [Phase Console](console.md) | The local web app: every plan's board, the graph, runs, terminal and search. |
| [Reaching it from your phone](phone.md) | Tailscale end to end — serve, identity, push notifications, and what is actually enforced. |
| [Metrics](metrics.md) | `GET /api/metrics` — the cost, progress and ladder numbers in Prometheus text, and the contract their names are. |
| [Debugging](debugging.md) | Where every log, journal and declaration lives, how to tie a run to a session to a lock to a tree, and the one bundle to hand a model. |
| [Webhooks](webhooks.md) | `--allow-webhooks` — the same announcements POSTed to a Slack, Discord or Telegram URL. The payload schema, what is redacted, and what never travels. |

## Also

| | |
|---|---|
| [Reference](reference.md) | How Agent Skills work, requirements, and how to run the tests. |
| [Versioning and releasing](releasing.md) | The two channels, how a change becomes an update, and what every change must carry with it. |
| [viewer/README.md](../viewer/README.md) | The console's own technical documentation — architecture, API, deploy. |
| [USAGE.md](../USAGE.md) | The loop in operational detail. |

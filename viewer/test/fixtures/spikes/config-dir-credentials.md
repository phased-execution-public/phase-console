# Probe — can a throwaway `CLAUDE_CONFIG_DIR` be seeded from the machine login, without a second sign-in?

cli: 2.1.274
date: 2026-09-18
verdict: yes
cost_usd: 0.01 (two one-turn haiku sessions)
settles: `many-plans-one-repo` phase 1 arm S-G — and with it, whether errand **E6** is real

**Why this exists.** Phase 17 rehearses three plans against one dev console, which wants more than one
credential in play without the operator signing in again. The plan's contingency said: *if S-G is NO for
both routes, E6 becomes a real errand.* It is YES on the first route, so **E6 stays hypothetical** — the
rehearsal can mint its own config dirs.

| arm | what | verdict |
|---|---|---|
| `S-G` | seed a throwaway `CLAUDE_CONFIG_DIR` from the default account by credential-file copy | yes |

## The two arms

| step | what was done | result |
|---|---|---|
| G-a | empty `CLAUDE_CONFIG_DIR`, then `claude -p 'say ok' --model haiku --max-turns 1 --max-budget-usd 0.02 --setting-sources project` | `Not logged in · Please run /login`, exit **1** |
| G-b | the same, after writing the machine login's credential blob to `$CLAUDE_CONFIG_DIR/.credentials.json` at `0600` | answered `ok`, exit **0** |

The blob is the verbatim value of the macOS keychain item `Claude Code-credentials`, read with
`security find-generic-password -s "Claude Code-credentials" -w`. Its top-level keys are `mcpOAuth` and
`claudeAiOauth`; 6,513 bytes on this machine. **Nothing about its contents is recorded here, and the file
written for this arm was deleted immediately after the measurement.**

## What this settles about where credentials live

On this Mac the default account keeps **no `.credentials.json` at all** — `~/.claude/.credentials.json` does
not exist, and the credential is in the keychain. So "copy the credential file" is not a copy between two
files: it is a keychain read followed by a file write. The CLI accepts the file route in a redirected config
dir, which is what makes the seeding one `security` call and one `writeFile`, with no keychain *write* and
no second sign-in.

The keychain also carries the CLI's per-config-dir scheme, and the console already knows it
(`viewer/server/accounts/credentials.ts:15-17,129-131`): `Claude Code-credentials` for the machine login and
`Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>` for a redirected profile. This arm
never created such an item — it was confirmed absent afterwards — so the file route is the cheaper of the
two and the one phase 17 should use.

## What this fixture does not establish

The **token account** half of the arm (`claude setup-token`, then `CLAUDE_CODE_OAUTH_TOKEN`) was **not
measured**: minting a setup token needs an interactive sign-in, which an unattended session cannot do. It is
recorded as untested rather than negative. The console's own note on that route still stands
(`credentials.ts:228`): a token account must **not** also set `CLAUDE_CONFIG_DIR`, because the token
outranks it.

Nor does this say anything about whether two sessions may spend one credential concurrently, or how the
usage meters attribute a config dir seeded this way — both are phase 17's to find out.

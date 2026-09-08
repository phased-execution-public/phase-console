# Webhooks — the same events, to a channel you already watch

Push reaches a phone you installed the console on. A webhook reaches everywhere else: the Slack
channel your team has open all day, a Discord server, a Telegram chat, a relay you wrote yourself.

It is the *same* event. The category catalogue decides what is worth saying, the global switches in
**Settings ▸ Notifications** decide whether it is said at all, and a webhook is one more leg leaving that
one choke point. Nothing here has its own notion of what is interesting.

**It is off.** Start the console with `--allow-webhooks` to register one. Without the flag no
outbound request is ever made — not even for a destination already on file from a day the console
*was* started with it. The flag is checked when a payload is about to be sent, not only when a URL
is registered.

## Why it is a separate flag

The other six capability switches widen what may happen *on this machine*. This one sends what
happened here somewhere else, unattended, from a laptop that usually sits inside a private network.
That is a different kind of decision, so it is a different switch — and it is why the console
refuses a URL that points back inside: no `http:`, no `localhost` or `127.0.0.1`, no link-local
(where the cloud metadata address lives), no RFC 1918 range, no bare IP, no dotless intranet name.
The same rule push applies to a subscription endpoint, for the same reason.

## Registering one

**Settings ▸ Notifications ▸ Channels.** Paste the URL, give it a name, choose its categories.

The URL is stored and **never shown again**. A Slack incoming-webhook URL is the whole
authorisation — anyone holding it can post to that channel — so the console serves back only its
origin and the last few characters of its path, enough to tell two rows apart. There is no Edit for
the same reason: pasting a URL that is already registered replaces that row, which is the honest
name for changing a secret. It also clears any backoff, so a re-paste is how you say *try again now*.

Each destination has its own category choices, exactly as a push device does. `Test` sends one
`health` payload immediately, whatever the categories say.

## What a payload looks like

`POST`, `content-type: application/json`, plus two headers so a relay can filter without
parsing: `x-phase-console-category` and `x-phase-console-instance`.

```json
{
  "version": 1,
  "instance": "a1b2c3d4-your-repo",
  "at": "2026-08-25T09:14:22.031Z",
  "category": "halted",
  "urgent": true,
  "title": "Run halted — console-audit-hardening",
  "body": "phase 4 would not settle after three attempts",
  "url": "/#/plan/console-audit-hardening/run",
  "link": "http://127.0.0.1:4123/#/plan/console-audit-hardening/run",
  "notificationId": "n_01J8…",
  "slug": "console-audit-hardening",
  "phase": 4,
  "runId": "run-9845d1b5",
  "text": "Run halted — console-audit-hardening — phase 4 would not settle after three attempts",
  "content": "Run halted — console-audit-hardening — phase 4 would not settle after three attempts"
}
```

| Field | What it is |
|---|---|
| `version` | The payload schema version. A consumer that does not know it should ignore the event. |
| `instance` | Which console spoke. |
| `at` | When it was announced, ISO 8601. |
| `category` | The catalogue id (`halted`, `needs-you`, `phase`, …). |
| `urgent` | Whether the category is one that means "nothing proceeds without you". |
| `title` | The announcement's headline, redacted and clipped. |
| `body` | Its detail, redacted and clipped to 500 characters. |
| `url` | The console-relative route this event is about. |
| `link` | The same route, absolute, so a chat client makes it clickable. |
| `notificationId` | The inbox record's id — the same event in **Settings ▸ Notifications** and in the inbox. |
| `slug` | The plan, when the event has one. `null` otherwise. |
| `phase` | The phase number, when the event has one. |
| `runId` | The run, when the event has one. |
| `text` | `title — body` as one line. **Slack and Telegram render this.** |
| `content` | The same line. **Discord renders this.** |

`text` and `content` are why there is no vendor code anywhere in this feature: an incoming-webhook
URL works on its own, because the field each service reads is already in the body.

## What never travels

- **No push action token.** The buttons on a notification are same-origin by construction and mean
  nothing to a third party, so a webhook payload carries no `callback`, no `actions`, no
  `approvalId`. A webhook tells you something happened; answering it happens in the console.
- **No file contents, no diffs, no transcripts.** Ids and titles only.
- **No secret-shaped strings.** A notification body is composed from a run's own words — a failing
  verification line, a session's last message — and that is exactly where a token gets echoed by
  accident. Every free-text field is masked on the way out: API keys, GitHub and Slack tokens, AWS
  key ids, JWTs, PEM blocks, `Authorization: Bearer …`, credentials in a URL's userinfo, vendor
  webhook URLs, and any long mixed-case-with-digits run that looks like a token. Commit shas, UUIDs,
  slugs, timestamps and dollar figures are deliberately kept — a redactor that ate those would be
  silently useless.

Masking is a recogniser, not a guarantee. The real defence is the one above it: a payload carries
ids and titles rather than content.

## When a destination is down

A failed POST backs off — 30 seconds, then a minute, then two, doubling to a ceiling of half an
hour — and the row **stays registered**. Push drops a dead device after fifteen failures because
that is the push service saying the app is gone; a webhook URL is something you typed, and losing
the row means re-issuing a secret. A relay that is down for a weekend costs 48 requests a day and
nothing else. The card shows the failure count and the last rejection; a success clears both.

A POST that hangs is abandoned after 10 seconds and counts as a failure. Nothing here is awaited by
a run: a relay being down can never slow a phase or fail one.

## Recipes

None of these needs anything installed. Each is a URL to paste.

**Slack** — *Incoming Webhooks* app → *Add New Webhook to Workspace* → copy the
`https://hooks.slack.com/services/…` URL. The channel renders `text`.

**Discord** — in the channel's own settings, *Integrations → Webhooks → New Webhook* → *Copy Webhook
URL*. The channel renders `content`.

**Telegram** — talk to `@BotFather` for a bot token, get your chat id, and register
`https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>` — the chat id goes in the **query
string**, because the body is this console's payload and `text` is the field `sendMessage` reads.

**Your own relay** — anything that accepts a JSON `POST` over https. Filter on
`x-phase-console-category` and read whatever fields you like; `version` tells you when the shape
changed.

> These are the vendors' documented contracts, and the payload is shaped to fit them. They are held
> here by this console's own tests, not by a live call: no third-party endpoint is contacted by the
> test suite. Press **Test** once after registering a URL — that is the check that proves the whole
> chain end to end.

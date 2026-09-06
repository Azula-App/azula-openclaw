# @azula-app/openclaw

An [OpenClaw](https://docs.openclaw.ai) channel plugin that lets you reach your
bot from your phone over [azula](https://azula.app), instead of routing a
personal agent's traffic through a third-party messenger.

azula is an end-to-end [iroh](https://iroh.computer) transport between a phone
and a machine. This plugin makes an OpenClaw gateway treat it as an ordinary
chat channel, alongside WhatsApp, Telegram and the rest.

## What it gives you

- **Text both ways** — the agent's replies arrive as chat; your replies wake it.
- **Attachments** — files in either direction, up to azula's 64 MiB inline cap.
- **Real controls** — when the agent offers a discrete set of choices, they
  render as actual buttons on the phone rather than "reply 1, 2 or 3". A tap
  comes back as that message's answer. Every surface ships with a text
  fallback, so the conversation still reads correctly in history.
- **A thinking indicator** during long turns, so the bot doesn't look dead.

## Requirements

- **OpenClaw 2026.9.2** — the release this plugin is built and tested against,
  pinned exactly. OpenClaw versions are dates, not semver, so a range would say
  nothing about compatibility. Node 22.22.3+; this repo pins 22.23.2 in
  `mise.toml`.
- **azula** on the gateway machine, new enough to provide `get_events` and
  `set_typing`. The plugin checks at startup and refuses to run with a clear
  message rather than failing per-message later.
- **A paired phone.** azula's own device pairing is the access boundary — this
  plugin does not define a second allowlist.

## Install

```bash
openclaw plugins install @azula-app/openclaw --accept-capabilities
```

Then restart the gateway so it loads.

`--accept-capabilities` is not boilerplate. OpenClaw shows you the surfaces a
plugin registers and asks you to consent to them; this one registers **a single
chat channel (`azula`) and nothing else** — no providers, tools, hooks, MCP
servers, CLI commands, skills, or dangerous config flags. Its manifest declares
exactly that, so what you are shown is what you get.

What the surface vocabulary *cannot* express, and you should know anyway:
running this channel means OpenClaw launches the **`azula` binary as a child
process** and reads the local files you ask it to attach. That is how it reaches
your phone; there is no network service in between.

## Configure

```jsonc
{
  "channels": {
    "azula": {
      "device": "phone"          // the name from `azula devices`
      // "binary":  "azula",     // path, if not on PATH
      // "session": "openclaw",  // persistent: keeps one conversation across restarts
      // "label":   "OpenClaw"   // conversation title on the phone
    }
  }
}
```

Check it:

```bash
openclaw channels list
```

### More than one phone

Each account addresses its own device, and inherits anything it doesn't set:

```jsonc
{
  "channels": {
    "azula": {
      "device": "phone",
      "accounts": {
        "work": { "device": "work-phone" }
      }
    }
  }
}
```

A sub-account gets its **own** session name (`openclaw-work`) rather than
inheriting the root's. azula gives every process a distinct session identity so
two cannot collide; inheriting one name would undo exactly that.

## Pairing

If the phone isn't paired with the gateway machine yet, get an invite:

```bash
azula pair
```

or let the channel show you one — it surfaces azula's own invite URL and QR
rather than inventing a second pairing code.

## How it works

The plugin runs **one** long-lived `azula mcp` session per account and drives
it in both directions:

| Direction | How |
| --- | --- |
| Agent → phone | `send_message`, `send_file`, `render_ui` |
| Phone → agent | `get_events` (long-polled), translated into inbound envelopes |

One session, not two, because azula binds a per-process identity: a second
process would be a second endpoint id and therefore a second conversation on
your phone.

Inbound events are **typed at the source** rather than parsed back out of
rendered text. That's what keeps a tap on a button distinguishable from a user
who literally types `ui-event: {...}`, and what preserves an attachment's
facts.

## Development

```bash
mise install        # once, plus `mise trust`
npm install
npm run typecheck
npm test
```

To install a working copy into a throwaway gateway profile:

```bash
npm run build
openclaw --profile dev plugins install "$PWD" --force --accept-capabilities
openclaw --profile dev plugins doctor
```

`--force` is needed only here: OpenClaw warns that a local path is outside
ClawHub's review and trust metadata, which is the right warning for a directory
you are editing. The published install above does not need it.

The test suite includes tests that run against a **real** `azula mcp` process
when a locally built binary is present, and skip cleanly when it isn't.

## Licence

MIT.

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

- **OpenClaw 2026.10.2** — the release this plugin is built and tested against,
  pinned exactly. OpenClaw versions are dates, not semver, so a range would say
  nothing about compatibility. Node 24.16.0+ (24.x) or 26.1.0+ — OpenClaw
  2026.10 dropped Node 22; this repo pins 24.20.0 in `mise.toml`.
- **azula** on the gateway machine, new enough to provide `get_events` and
  `set_typing`. The plugin checks at startup and refuses to run with a clear
  message rather than failing per-message later.
- **A paired phone.** azula's own device pairing is the access boundary — this
  plugin does not define a second allowlist.

## Install

```bash
openclaw plugins install @azula-app/openclaw --force --accept-capabilities
```

Then restart the gateway so it loads.

`--accept-capabilities` is not boilerplate. OpenClaw shows you the surfaces a
plugin registers and asks you to consent to them; this one registers **a single
chat channel (`azula`) and nothing else** — no providers, tools, hooks, MCP
servers, CLI commands, skills, or dangerous config flags. Its manifest declares
exactly that, so what you are shown is what you get.

`--force` acknowledges a second, separate warning: this package is not in
ClawHub, OpenClaw's reviewed plugin index, so the gateway asks you to confirm
you trust the source. That gate is about ClawHub review metadata, not about
where the package came from — it fires for an npm install exactly as it does
for a local path.

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
openclaw channels list      # is it configured
openclaw channels status    # is it running — and, if not, why
```

If the channel cannot start — `azula` isn't installed, it's too old, or the
phone named in `device` isn't paired — `channels status` shows the error with
the fix, and the account stays stopped rather than retrying: nothing a retry
could do would cure it. Fix the problem, then restart the channel (or the
gateway). Other channels are unaffected either way.

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

The phone pairs with the channel's own azula session — the persistent identity
named by `session` (`openclaw` unless you changed it) — not just with the
machine. The plugin ships a helper that starts that session exactly as the
channel will, prints its invite as a URL and QR, and waits for the phone:

```bash
openclaw plugins inspect azula | grep 'Install path:'   # where OpenClaw put the plugin
node <install path>/scripts/pair.mjs                    # add --session/--label/--binary to match your config
```

(An npm install lands under `~/.openclaw/npm/projects/…/node_modules/@azula-app/openclaw`,
not `~/.openclaw/extensions/`, so ask OpenClaw rather than guessing.)

Run it on the gateway machine as the gateway's user, before enabling the
channel (one session can't be held by two processes). In the azula app, tap
**+ connect a peer** and scan the QR or open the link. The helper then prints
the device name to set as `channels.azula.device`.

The channel does not show an invite itself, and `azula pair` is the opposite
direction — it imports a device's ticket rather than producing an invite.

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

When the gateway starts an account, the plugin spawns `azula mcp`, confirms the
phone is paired, and starts long-polling it. Each message is handed to the agent
as an ordinary direct message from the phone — slash commands included, since
the paired phone is the one sender this channel admits — and the agent's replies
go back through the same session. A file you send is copied into OpenClaw's media
store first (the gateway won't read attachments from outside it), so the agent
sees it like any other channel's. While the agent is working on a turn the phone
shows the thinking indicator; it is cleared when the turn ends, however it ends.

If the `azula` process dies, the plugin restarts it with backoff and carries on.
Stopping the account — a reload, a config change, the gateway shutting down —
kills the process at once, even mid-poll.

Messages are handled one at a time, in the order they arrive: a message sent
while the agent is still busy with the previous one waits its turn.

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

Same two flags as the published install — the ClawHub trust warning is not
specific to local paths.

Use an `openclaw` that lives outside this checkout (a global install). Running
this repo's own `node_modules/.bin/openclaw` against `"$PWD"` makes OpenClaw's
bundled plugins sit inside the install's source path, and 2026.10.2 then
refuses the install with `package owner "azula" has conflicting child rows`.

The test suite includes tests that run against a **real** `azula mcp` process
when a locally built binary is present, and skip cleanly when it isn't.

## Licence

MIT.

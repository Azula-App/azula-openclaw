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

The smallest configuration turns the channel on and leaves the phone for
pairing (see [Pairing](#pairing)), which fills in `device` for you:

```bash
openclaw config set channels.azula.enabled true     # no restart needed
openclaw channels login --channel azula             # shows the invite; scan it with the phone
```

Or name a phone you have already paired yourself:

```jsonc
{
  "channels": {
    "azula": {
      "device": "phone"          // the name from `azula devices`; leave unset to pair a phone
      // "binary":  "azula",     // path, if not on PATH
      // "session": "openclaw",  // persistent: keeps one conversation across restarts
      // "label":   "OpenClaw",  // conversation title on the phone
      // "configWrites": false   // don't let pairing write `device` into this file (see Pairing)
    }
  }
}
```

Check it:

```bash
openclaw channels list      # is it configured
openclaw channels status    # is it running — and, if not, why
```

An account with no `device` is not an error: it starts, holds its azula session
and waits for a phone. `channels status` says so (*waiting for a phone to pair*)
and names the command to run. Nothing reaches the agent until a phone has
paired.

If the channel cannot start — `azula` isn't installed, it's too old, or the
phone named in `device` isn't paired — `channels status` shows the error with
the fix, and the account stays stopped rather than retrying: nothing a retry
could do would cure it. Fix the problem, then restart the channel (or the
gateway). Other channels are unaffected either way. For a `device` that isn't
paired, the fix is the same command that pairs a new phone — it was most likely
a typo or a pairing that never happened.

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

To add a second phone, add the account and pair it by name:

```bash
openclaw config set channels.azula.accounts.work.enabled true
openclaw channels login --channel azula --account work
```

(A device-less root next to named accounts is just their shared defaults: it is
not started as an account of its own.) A sub-account that sets no `device` of
its own inherits the root's, so if the root already names a phone the new
account will report that phone as not paired with *its* session; the same
`login --account work` command is the fix, and it saves the new phone as the
sub-account's own `device`.

## Pairing

The phone pairs with the channel's own azula session — the persistent identity
named by `session` (`openclaw` unless you changed it) — not just with the
machine. The channel shows azula's own invite (its URL and QR, never a second
code) through OpenClaw's login command:

```bash
openclaw channels login --channel azula                 # add --account <id> for a named account
```

In the azula app, tap **+ connect a peer** and scan the code or open the link.
Run it on the gateway machine, from a terminal, as OpenClaw's own docs say for
every `channels login`.

What happens:

1. The CLI asks the **running gateway** for the invite. A phone has to pair with
   the account's own session, and one process at a time can hold a session, so
   while the gateway runs the account only the gateway can mint an invite that
   works. (It is the same RPC pair OpenClaw uses for WhatsApp's QR login,
   `web.login.start` / `web.login.wait`; you can call them directly with
   `openclaw gateway call web.login.start --params '{"channel":"azula"}'`.
   OpenClaw's Control UI only wires its login panel to WhatsApp in 2026.10.2, so
   there is no button for azula there.)
2. The account is already waiting for a phone (it is in its pairing state when
   `device` is unset). It watches the session's device list for a phone that
   *this session has connected with* and hadn't when the account began waiting:
   one that has just redeemed the invite, or one already paired with this session
   that connects while the account is waiting. azula's device list is the
   machine's, so a phone paired with a *different* session (another account's,
   say) is listed here too, but as `offline` (this session never dialed or
   accepted it); it is not taken.
3. The account **saves it**: `channels.azula.device` (or the named account's own
   `device`) is written through OpenClaw's config API, and the account goes ready
   at once, with no restart. Only one phone per account: a second phone pairing
   later is left alone. The new phone appears under its endpoint id, because the
   app does not announce a name — that is the `device` value you will see.
4. If the config cannot be written (`channels.azula.configWrites: false`, or the
   write fails), the account still serves the phone; it keeps the device in
   memory, `channels status` warns that a restart would forget it, and shows the
   exact `openclaw config set …` line that saves it. Run that line to make it
   stick; until then, CLI-side commands such as `message send` (which look the
   phone up in the config) cannot address it.

Asking for the invite when the account is **not** running — it is blocked on a
`device` that isn't paired, or you stopped it — works too: the gateway opens the
account's session just for the pairing, hands it back as soon as the phone has
paired, saves the new phone as the account's `device` (replacing the one that
wasn't paired) and starts the account.

Check that it took:

```bash
openclaw channels status --channel azula     # azula default (<device>): running, connected
```

To **replace** a phone that is already paired, clear the account's `device` and
pair again:

```bash
openclaw config unset channels.azula.device     # the account restarts and waits for a phone
openclaw channels login --channel azula
```

(Run on an account that already has a phone, `channels login` says so and points
here rather than minting a second invite.)

### Pairing without a gateway

If no gateway is running, the plugin ships a helper that starts the account's
session exactly as the channel will, prints its invite as a URL and QR, waits for
the phone, and tells you the line to put in your config:

```bash
openclaw plugins inspect azula | grep 'Install path:'   # where OpenClaw put the plugin
node <install path>/scripts/pair.mjs                    # add --session/--label/--binary to match your config
```

(An npm install lands under `~/.openclaw/npm/projects/…/node_modules/@azula-app/openclaw`,
not `~/.openclaw/extensions/`, so ask OpenClaw rather than guessing.)

Run it on the gateway machine as the gateway's user, **before** starting the
gateway or with the channel stopped (one session can't be held by two
processes). The helper prints the device name to set as `channels.azula.device`.

`azula pair` is the opposite direction — it imports a device's ticket rather
than producing an invite.

## Sending to the phone

The agent's replies to the phone's own messages need nothing from you. To send
something yourself — from the CLI, the agent's `message` tool, `cron` or
heartbeat — address the account's phone by its device name:

```bash
openclaw message send --channel azula --target <device> -m "build finished"
openclaw message send --channel azula --target azula:<device> -m "same thing"
openclaw message send --channel azula --account work --target <work-device> -m "…"
```

An azula account has exactly one phone, so a target is checked rather than
chosen: a name that isn't the account's device is refused, naming the paired
device(s) and, if it belongs to another account, which `--account` to use. The
delivery happens in the gateway (that is where the account's azula session
lives), so the gateway must be running. `cron` announcements
(`openclaw cron add … --announce --channel azula --account <id> --to <device>`)
take the same path, and a heartbeat with `heartbeat.target: "azula"` resolves to
the account's phone, with or without a `to`. (`cron` refuses to guess a
destination for an isolated job, so give it the `--to`.)

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
phone is paired (or, with no `device` yet, waits for one to pair), and starts
long-polling it. Each message is handed to the agent
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

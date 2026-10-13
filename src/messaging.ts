/**
 * Addressing: how a target string becomes "this account's phone".
 *
 * An azula account serves exactly one device, so a destination is never chosen
 * from many; it is checked. `openclaw message send --channel azula --target
 * <device>`, the agent's `message` tool, `cron` and heartbeat all end up asking
 * the same question — is this the phone the account serves? — and this module
 * is the one place that answers it. The answers are used at two points in the
 * gateway's pipeline:
 *
 *  - `messaging.targetResolver` / `normalizeTarget`, where a typed target is
 *    first understood (and an unknown one is turned away, naming the device);
 *  - `outbound.resolveTarget`, the last check before delivery, which also covers
 *    the paths that never see a typed target (cron and heartbeat reuse the
 *    session's last route, or `config.resolveDefaultTo`).
 *
 * Delivery itself is unchanged: `sendText` / `sendMedia` look up the account's
 * bridge, which always addresses its own device. Validating here is what stops a
 * target naming some other device from silently landing on this one.
 */

import {
  azulaSection,
  DEFAULT_ACCOUNT_ID,
  listAccountIds,
  loginCommand,
  resolveAccount,
} from "./accounts.js";
import { CHANNEL_ID } from "./channel-id.js";
import { getRuntime } from "./runtime.js";

const PREFIX = `${CHANNEL_ID}:`;

/**
 * The device name inside a target: `azula:phone`, `user:phone`, `@phone` and
 * `phone` all name the same thing.
 */
export function parseTarget(raw: string | null | undefined): string | undefined {
  let value = (raw ?? "").trim();
  for (;;) {
    const lowered = value.toLowerCase();
    if (lowered.startsWith(PREFIX)) value = value.slice(PREFIX.length).trim();
    else if (lowered.startsWith("user:")) value = value.slice("user:".length).trim();
    else if (lowered.startsWith("direct:")) value = value.slice("direct:".length).trim();
    else break;
  }
  value = value.replace(/^@/, "").trim();
  return value === "" ? undefined : value;
}

/** The canonical target for a device. Matches what inbound turns record as the route. */
export const targetFor = (device: string): string => `${PREFIX}${device}`;

/** Accept a bare device name, or the same with the channel prefix. */
export function normalizeTarget(raw: string): string | undefined {
  const device = parseTarget(raw);
  return device === undefined ? undefined : targetFor(device);
}

/** How the gateway classifies an azula destination: always a direct conversation. */
export const inferTargetChatType = (): "direct" => "direct";

/** A destination as the gateway will use it. */
export type ResolvedTarget = { accountId: string; device: string; to: string };

export type TargetResult =
  | ({ ok: true } & ResolvedTarget)
  | { ok: false; error: Error };

/** How strictly a destination is checked. */
export type TargetMode = "explicit" | "implicit" | "heartbeat" | undefined;

type ServedDevice = { accountId: string; device: string | undefined };

/**
 * The device an account serves right now.
 *
 * A running account is asked first: one that adopted its phone without being able
 * to save it knows more than the config does.
 */
function servedDevice(cfg: unknown, accountId: string): ServedDevice {
  const live = getRuntime(accountId)?.bridge.device;
  if (live) return { accountId, device: live };
  try {
    return { accountId, device: resolveAccount(azulaSection(cfg), accountId).device };
  } catch {
    return { accountId, device: undefined };
  }
}

function otherAccounts(cfg: unknown): ServedDevice[] {
  return listAccountIds(azulaSection(cfg)).map((id) => servedDevice(cfg, id));
}

/**
 * Decide whether `input` names the phone `accountId` serves.
 *
 * Without an explicit account the default one is meant. A device that belongs to
 * a different account is reported as such, since that is the mistake multi-phone
 * setups actually make.
 */
export function resolveAzulaTarget(
  cfg: unknown,
  accountId: string | null | undefined,
  input: string | null | undefined,
  mode?: TargetMode,
): TargetResult {
  const section = azulaSection(cfg);
  const ids = listAccountIds(section);
  const id = accountId?.trim() || (ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (ids[0] ?? DEFAULT_ACCOUNT_ID));
  if (id !== DEFAULT_ACCOUNT_ID && !ids.includes(id)) {
    return { ok: false, error: new Error(`no azula account named '${id}'`) };
  }
  const served = servedDevice(cfg, id);

  if (served.device === undefined) {
    return {
      ok: false,
      error: new Error(
        `azula account '${id}' has no paired phone in the config, so there is nothing to send to; run \`${loginCommand(id)}\` to pair one ` +
          "(if it already serves a phone that was never saved, `channels status` shows the `openclaw config set` line that saves it)",
      ),
    };
  }
  const device = served.device;

  const wanted = parseTarget(input);
  if (wanted === undefined) {
    // No destination named: the account's phone is the only one there is.
    return { ok: true, accountId: id, device, to: targetFor(device) };
  }
  if (wanted.toLowerCase() === device.toLowerCase()) {
    return { ok: true, accountId: id, device, to: targetFor(device) };
  }

  // A route recorded for an earlier phone, or an owner/heartbeat destination:
  // nothing a person typed, and the account has only the one phone to deliver to.
  if (mode === "implicit" || mode === "heartbeat") {
    return { ok: true, accountId: id, device, to: targetFor(device) };
  }

  const elsewhere = otherAccounts(cfg).find(
    (other) => other.accountId !== id && other.device?.toLowerCase() === wanted.toLowerCase(),
  );
  if (elsewhere) {
    return {
      ok: false,
      error: new Error(
        `Unknown target "${input}" for azula on account '${id}': device '${wanted}' belongs to account '${elsewhere.accountId}'; add --account ${elsewhere.accountId}`,
      ),
    };
  }

  const known = otherAccounts(cfg)
    .filter((other): other is { accountId: string; device: string } => other.device !== undefined)
    .map((other) => (ids.length > 1 ? `'${other.device}' (account '${other.accountId}')` : `'${other.device}'`));
  return {
    ok: false,
    error: new Error(
      `Unknown target "${input}" for azula. ${
        known.length > 1 ? "The paired devices are" : "The paired device is"
      } ${known.join(", ")}; use --target ${device} or --target ${targetFor(device)}.`,
    ),
  };
}

/** What shows next to a destination in logs and listings. */
export function formatTargetDisplay(params: { target: string; display?: string | undefined }): string {
  return params.display ?? parseTarget(params.target) ?? params.target;
}

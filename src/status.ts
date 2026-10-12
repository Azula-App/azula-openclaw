/**
 * What `openclaw channels status` shows for an azula account.
 *
 * Without a snapshot builder the gateway projects only a fixed, deliberately
 * narrow set of fields from the account's runtime state — and `lastError` is
 * not one of them. That would hide exactly the text an operator needs most: why
 * the channel is blocked, and what to do about it. The lifecycle publishes that
 * text as `lastError`; this passes it (and the other runtime facts the gateway
 * tracks for the account) through to the status surface.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { DEFAULT_ACCOUNT_ID, type ResolvedAzulaAccount } from "./accounts.js";

type AzulaStatus = NonNullable<ChannelPlugin<ResolvedAzulaAccount>["status"]>;
type Snapshot = NonNullable<AzulaStatus["defaultRuntime"]>;

/** The runtime facts worth showing. Nothing here is or contains a secret. */
const RUNTIME_FIELDS = [
  "running",
  "connected",
  "lifecycle",
  "restartPending",
  "terminalDisconnect",
  "reconnectAttempts",
  "lastStartAt",
  "lastStopAt",
  "lastConnectedAt",
  "lastInboundAt",
  "lastOutboundAt",
  "lastEventAt",
  "lastError",
] as const;

export const azulaStatus: AzulaStatus = {
  defaultRuntime: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    connected: false,
    lastError: null,
  },

  buildAccountSnapshot: ({ account, runtime }) => {
    const published: Record<string, unknown> = {};
    for (const key of RUNTIME_FIELDS) {
      const value = runtime?.[key];
      if (value !== undefined) published[key] = value;
    }

    return {
      running: false,
      connected: false,
      lastError: null,
      ...published,
      accountId: account.accountId,
      // The device is what distinguishes one account from another to an operator.
      name: account.device,
      enabled: account.enabled,
      configured: true,
      // The azula binary this account runs, as `channels status` shows for CLI-backed channels.
      cliPath: account.binary,
    } as Snapshot;
  },
};

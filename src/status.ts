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
import { DEFAULT_ACCOUNT_ID, loginCommand, type ResolvedAzulaAccount } from "./accounts.js";

type AzulaStatus = NonNullable<ChannelPlugin<ResolvedAzulaAccount>["status"]>;
type Snapshot = NonNullable<AzulaStatus["defaultRuntime"]>;

/** The runtime facts worth showing. Nothing here is or contains a secret. */
const RUNTIME_FIELDS = [
  "running",
  "connected",
  // The plugin's own facts: waiting for a phone; the device the account serves
  // when that differs from the config; and, if it is not saved, how to save it.
  "azulaPairing",
  "azulaDevice",
  "azulaConfigHint",
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
      const value = (runtime as Record<string, unknown> | undefined)?.[key];
      if (value !== undefined) published[key] = value;
    }
    const adopted = published["azulaDevice"];
    const device = typeof adopted === "string" ? adopted : account.device;

    return {
      running: false,
      connected: false,
      lastError: null,
      ...published,
      accountId: account.accountId,
      // The device is what distinguishes one account from another to an operator.
      // An account that adopted its phone in this run may know it before the
      // config does; one still waiting for a phone has no name yet.
      ...(device === undefined ? {} : { name: device }),
      enabled: account.enabled,
      configured: true,
      // The azula binary this account runs, as `channels status` shows for CLI-backed channels.
      cliPath: account.binary,
    } as Snapshot;
  },

  /**
   * Things that are not failures but need the operator: a phone still to pair,
   * and a paired phone that nothing has saved yet.
   */
  collectStatusIssues: (accounts) =>
    accounts.flatMap((account) => {
      const accountId = account.accountId;
      const fields = account as Record<string, unknown>;
      if (fields["azulaPairing"] === true) {
        return [
          {
            channel: "azula",
            accountId,
            kind: "config" as const,
            message: "waiting for a phone to pair (no device configured)",
            fix: `run \`${loginCommand(accountId)}\`, then scan the invite with the azula app`,
          },
        ];
      }
      const hint = fields["azulaConfigHint"];
      if (typeof hint === "string" && hint !== "") {
        return [
          {
            channel: "azula",
            accountId,
            kind: "config" as const,
            message: "serving a paired phone that is not saved in the config; a restart would forget it",
            fix: hint,
          },
        ];
      }
      return [];
    }),
};

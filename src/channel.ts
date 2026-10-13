/**
 * The `azula` channel definition.
 *
 * Only the surfaces this channel actually implements are declared; everything
 * else on `ChannelPlugin` is optional and deliberately left off rather than
 * stubbed, so an unimplemented surface reads as absent rather than broken.
 */

import {
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/channel-core";
import { sendMedia, sendText } from "./outbound.js";
import {
  azulaSection,
  listAccountIds,
  resolveAccount,
  type ResolvedAzulaAccount,
} from "./accounts.js";
import { MAX_FILE_BYTES } from "./bridge.js";
import { createGatewayAdapter } from "./gateway.js";
import { azulaAuth } from "./login.js";
import {
  formatTargetDisplay,
  inferTargetChatType,
  normalizeTarget,
  resolveAzulaTarget,
  targetFor,
} from "./messaging.js";
import { azulaStatus } from "./status.js";

export { CHANNEL_ID } from "./channel-id.js";
import { CHANNEL_ID } from "./channel-id.js";

/** Pull `channels.azula` out of a gateway config without assuming its shape. */
const channelConfig = (cfg: OpenClawConfig | undefined) => azulaSection(cfg);

const base = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "azula",
    selectionLabel: "azula",
    docsPath: "https://azula.app",
    docsLabel: "azula.app",
    blurb:
      "Reach your bot from your phone over azula's end-to-end iroh transport, with no third-party messenger in between.",
    markdownCapable: true,
  },

  capabilities: {
    // One paired phone per account: a direct conversation, no groups or
    // threads to model.
    chatTypes: ["direct" as const],
    media: true,
    reply: false,
    reactions: false,
    edit: false,
    unsend: false,
    threads: false,
    groupManagement: false,
    polls: false,
  },

  // What actually runs the channel: starts an account's bridge, polls it for
  // the phone's messages, and tears it down. Without this the plugin loads but
  // nothing is ever listening — every send fails and nothing arrives.
  gateway: createGatewayAdapter(),

  // Pairing a phone saves its `device` into config, which the gateway answers by
  // reloading the channel. Scoped to the account that changed, a named account's
  // new phone does not bounce its siblings (and whatever turn they are in the
  // middle of). Accounts are isolated enough for that: each owns its azula
  // session, its lifecycle and its registry entry.
  reload: { configPrefixes: ["channels.azula"], accountScopedRestart: true },

  // So `channels status` can show *why* an account is blocked, not just that it is.
  status: azulaStatus,

  // `openclaw channels login`: the CLI half of the pairing affordance. It asks
  // the gateway (whose account holds the azula session) for azula's invite.
  auth: azulaAuth,

  config: {
    listAccountIds: (cfg?: OpenClawConfig) => listAccountIds(channelConfig(cfg)),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveAccount(channelConfig(cfg), accountId),
    inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      try {
        const account = resolveAccount(channelConfig(cfg), accountId);
        return {
          enabled: account.enabled,
          configured: true,
          label: account.label,
          ...(account.device === undefined ? {} : { target: account.device }),
        };
      } catch {
        return { enabled: false, configured: false };
      }
    },
    // Cron, heartbeat and `message send` without a target have exactly one
    // place to go: the account's phone.
    resolveDefaultTo: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
      const resolved = resolveAzulaTarget(cfg, accountId, undefined);
      return resolved.ok ? resolved.to : undefined;
    },
  },

  // Turning what an operator, a cron job or the agent's `message` tool typed
  // into "this account's phone", or turning it away. See messaging.ts.
  messaging: {
    targetPrefixes: [CHANNEL_ID],
    normalizeTarget,
    inferTargetChatType,
    formatTargetDisplay,
    targetResolver: {
      hint: `a device name or ${targetFor("<device>")} (the phone paired with the account)`,
      // Never "looks like an id": that would skip the check against the
      // account's own device.
      looksLikeId: () => false,
      resolveTarget: async ({
        cfg,
        accountId,
        input,
      }: {
        cfg: OpenClawConfig;
        accountId?: string | null;
        input: string;
      }) => {
        const resolved = resolveAzulaTarget(cfg, accountId, input, "explicit");
        if (!resolved.ok) throw resolved.error;
        return {
          to: resolved.to,
          kind: "user" as const,
          display: resolved.device,
          source: "normalized" as const,
        };
      },
    },
  },
};

/**
 * The channel, with outbound composed on.
 *
 * `createChatChannelPlugin` fills in the delivery plumbing (chunking,
 * formatting, the `channel` field on every result) around these two hooks, so
 * the plugin only has to say what "send" means for azula.
 */
export const azulaChannelPlugin: ChannelPlugin<ResolvedAzulaAccount> =
  createChatChannelPlugin<ResolvedAzulaAccount>({
    base,
    outbound: {
      base: {
        // The azula bridge is a child process of the *gateway*: only the gateway
        // process has a running bridge to send through. `direct` would make
        // `openclaw message send` try to deliver from the CLI process, which has
        // none ("no running bridge"); `gateway` makes the CLI hand the send to
        // the gateway, and in-gateway senders (the agent, cron, heartbeat)
        // deliver locally as before. This is what WhatsApp, whose socket also
        // lives in the gateway, declares.
        deliveryMode: "gateway",
        chunkerMode: "markdown",
        // The last check before delivery, and the only one that sees cron and
        // heartbeat destinations. Strict for a target someone typed, lenient
        // for a recorded route that predates the account's current phone.
        resolveTarget: ({ cfg, to, accountId, mode }) => {
          const resolved = resolveAzulaTarget(cfg, accountId, to, mode);
          return resolved.ok ? { ok: true, to: resolved.to } : { ok: false, error: resolved.error };
        },
      },
      attachedResults: {
        channel: CHANNEL_ID,
        sendText,
        sendMedia,
      },
    },
  });

/**
 * The per-message media ceiling advertised to the gateway.
 *
 * Matching azula's own inline transfer cap means an oversized attachment is
 * refused before any transfer frames are written, rather than part-way
 * through.
 */
export const azulaMediaMaxBytes = MAX_FILE_BYTES;

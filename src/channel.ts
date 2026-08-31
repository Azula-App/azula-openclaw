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
  listAccountIds,
  resolveAccount,
  type ResolvedAzulaAccount,
} from "./accounts.js";
import { MAX_FILE_BYTES } from "./bridge.js";

export { CHANNEL_ID } from "./channel-id.js";
import { CHANNEL_ID } from "./channel-id.js";

/** Pull `channels.azula` out of a gateway config without assuming its shape. */
function channelConfig(cfg: OpenClawConfig | undefined):
  | (Record<string, unknown> & { accounts?: Record<string, Record<string, unknown>> })
  | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> } | undefined)
    ?.channels;
  const own = channels?.[CHANNEL_ID];
  return typeof own === "object" && own !== null
    ? (own as Record<string, unknown>)
    : undefined;
}

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
          target: account.device,
        };
      } catch {
        return { enabled: false, configured: false };
      }
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
        // azula owns the connection, so the plugin delivers directly rather
        // than handing payloads to the gateway to route.
        deliveryMode: "direct",
        chunkerMode: "markdown",
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

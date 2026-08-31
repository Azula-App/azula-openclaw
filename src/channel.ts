/**
 * The `azula` channel definition.
 *
 * Only the surfaces this channel actually implements are declared; everything
 * else on `ChannelPlugin` is optional and deliberately left off rather than
 * stubbed, so an unimplemented surface reads as absent rather than broken.
 */

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  listAccountIds,
  resolveAccount,
  type ResolvedAzulaAccount,
} from "./accounts.js";
import { MAX_FILE_BYTES } from "./bridge.js";

export const CHANNEL_ID = "azula";

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

export const azulaChannelPlugin: ChannelPlugin<ResolvedAzulaAccount> = {
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
    chatTypes: ["direct"],
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
 * The per-message media ceiling advertised to the gateway.
 *
 * Matching azula's own inline transfer cap means an oversized attachment is
 * refused before any transfer frames are written, rather than part-way
 * through.
 */
export const azulaMediaMaxBytes = MAX_FILE_BYTES;

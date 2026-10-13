/**
 * Remembering the phone that paired.
 *
 * The device an account adopts is written to `channels.azula.device` (or the
 * named account's own entry) through the SDK's supported config-write API, so
 * the pairing survives a restart. Two things can stop that, and neither may
 * stop the account serving its phone: the operator has switched channel-initiated
 * config writes off, or the write fails. In both cases the account keeps the
 * device in memory and the caller is handed the exact `openclaw config set`
 * line that would save it.
 */

import { configSetCommand, DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { CHANNEL_ID } from "./channel-id.js";
import type { AdoptResult } from "./lifecycle.js";
import type { Logger } from "./mcp-client.js";
import type { Sdk } from "./sdk.js";

export type PersistSdk = Pick<
  Sdk,
  "getRuntimeConfig" | "mutateConfigFile" | "resolveChannelConfigWrites"
>;

export type PersistOptions = {
  sdk: PersistSdk;
  accountId: string;
  device: string;
  logger: Logger;
  /**
   * Overwrite a `device` that is already configured. Adoption never does: a
   * device the operator named is theirs. Re-pairing an account whose device is
   * not paired does, because that name is the thing being replaced.
   */
  replace?: boolean;
};

type Section = Record<string, unknown> & { accounts?: Record<string, Record<string, unknown>> };

/** Save `device` as the account's configured device. Never throws. */
export async function persistDevice(options: PersistOptions): Promise<AdoptResult> {
  const { sdk, accountId, device, logger } = options;
  const unsaved = (why: string): AdoptResult => {
    logger.warn(`azula: device '${device}' was not saved to the config (${why})`);
    return { persisted: false, configHint: configSetCommand(accountId, device) };
  };

  try {
    const current = sdk.getRuntimeConfig();
    if (!sdk.resolveChannelConfigWrites({ cfg: current, channelId: CHANNEL_ID, accountId })) {
      return unsaved("config writes are switched off for this channel");
    }

    const { result } = await sdk.mutateConfigFile({
      // Let the gateway's reload planner decide. A change under `channels.azula`
      // hot-reloads the channel, so the account restarts a moment later with the
      // device from the file (a sub-second bounce). The alternative, `mode:
      // "none"`, leaves the gateway's runtime config without the device until
      // something else reloads it, and an account restarted from that stale view
      // would start with no device, find its phone already paired, and wait
      // forever for a new one.
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const channels = ((draft as { channels?: Record<string, unknown> }).channels ??= {});
        const section = (channels[CHANNEL_ID] ??= {}) as Section;
        const target =
          accountId === DEFAULT_ACCOUNT_ID
            ? section
            : ((section.accounts ??= {})[accountId] ??= {});
        const existing = target["device"];
        if (typeof existing === "string" && existing.trim() !== "" && !options.replace) {
          return "occupied" as const;
        }
        target["device"] = device;
        return "written" as const;
      },
    });

    if (result === "occupied") {
      return unsaved("the account already has a configured device, which was left alone");
    }
    return { persisted: true };
  } catch (err) {
    return unsaved(err instanceof Error ? err.message : String(err));
  }
}

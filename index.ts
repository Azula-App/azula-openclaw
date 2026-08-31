/**
 * Plugin entry for the `azula` channel.
 *
 * Imports come from specific `openclaw/plugin-sdk/*` subpaths rather than a
 * barrel, per the SDK's own guidance — each subpath is self-contained, and
 * pulling the barrel in would slow gateway startup.
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { azulaChannelPlugin, CHANNEL_ID } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "azula",
  description:
    "Reach your OpenClaw bot from your phone over azula's end-to-end iroh transport.",
  plugin: azulaChannelPlugin,
});

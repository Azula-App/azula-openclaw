/**
 * The OpenClaw SDK values the running channel needs, loaded on demand.
 *
 * The gateway evaluates a channel plugin's modules to build discovery
 * snapshots and CLI help, long before (and often without) starting an account.
 * Pulling the inbound, dedupe and gateway-runtime subpaths in at import time
 * would make every `openclaw channels list` pay for code only a *running*
 * account uses, so they are imported here, once, when an account starts.
 *
 * Everything else in the plugin reaches these through the returned object,
 * which also makes them a single seam for tests.
 */

export async function loadSdk() {
  const [gateway, inbound, dedupe, config] = await Promise.all([
    import("openclaw/plugin-sdk/gateway-runtime"),
    import("openclaw/plugin-sdk/channel-inbound"),
    import("openclaw/plugin-sdk/persistent-dedupe"),
    import("openclaw/plugin-sdk/runtime-config-snapshot"),
  ]);

  return {
    // Account status patches: the gateway's own vocabulary for ready / blocked /
    // stopped, so health policy (which keys off `lifecycle` and
    // `terminalDisconnect`) reads them the way it reads every other channel's.
    channelReadyPatch: gateway.channelReadyPatch,
    channelBlockedPatch: gateway.channelBlockedPatch,
    channelStoppedPatch: gateway.channelStoppedPatch,

    // Routing an inbound direct message to an agent session.
    resolveChannelInboundRouteEnvelope: inbound.resolveChannelInboundRouteEnvelope,
    // Attachments as the ordered media facts the agent turn expects, and the
    // standard way to tell the agent one could not be provided.
    toInboundMediaFacts: inbound.toInboundMediaFacts,
    formatInboundMediaUnavailableText: inbound.formatInboundMediaUnavailableText,

    createClaimableDedupe: dedupe.createClaimableDedupe,

    // A long-lived monitor must not decide every future turn from the config it
    // was started with: routing and bindings change while it runs.
    createRuntimeConfigReader: config.createRuntimeConfigReader,
  };
}

export type Sdk = Awaited<ReturnType<typeof loadSdk>>;

/**
 * One RPC to the running OpenClaw gateway, as a CLI command makes it.
 *
 * Shared by the two things in this plugin that run in a *CLI* process and need
 * the gateway's azula account: `channels login` (the invite lives in the
 * account's session) and `message send` (the bridge lives there too). Neither
 * may be done from the CLI process itself, because only the gateway holds an
 * `azula mcp` session for the account.
 */

/** One gateway RPC. */
export type CallGateway = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
) => Promise<Record<string, unknown>>;

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The real thing: the same gateway client every other CLI command uses.
 *
 * `unreachable` words the failure for the caller when there is no gateway to
 * talk to (not running, wrong URL or token), because what to do about it
 * depends on what was being attempted.
 */
export async function callGatewayViaCli(
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  unreachable: (cause: string) => string,
): Promise<Record<string, unknown>> {
  const gateway = await import("openclaw/plugin-sdk/gateway-runtime");
  try {
    return await gateway.callGatewayFromCli(
      method,
      { timeout: String(timeoutMs) },
      params,
      { progress: false },
    );
  } catch (err) {
    if (gateway.isGatewayTransportError(err)) throw new Error(unreachable(errMessage(err)));
    throw err;
  }
}

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The CLI half of the pairing affordance, against the SDK's own gateway client
 * (mocked): the channel's `auth.login` is what `openclaw channels login` calls,
 * and it must reach the gateway the way every other CLI command does.
 */
const callGatewayFromCli = vi.fn();
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: (...args: unknown[]) => callGatewayFromCli(...args),
  isGatewayTransportError: (err: unknown) => (err as { name?: string })?.name === "GatewayTransportError",
}));

import { azulaAuth } from "./login.js";

beforeEach(() => callGatewayFromCli.mockReset());

const runtime = () => {
  const lines: string[] = [];
  return { lines, runtime: { log: (...a: unknown[]) => void lines.push(a.join(" ")), error: () => {}, exit: () => {} } };
};

describe("channels login (auth.login)", () => {
  it("asks the running gateway for the invite through the SDK's CLI gateway client", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ connected: true, message: "INVITE" });
    const out = runtime();

    await azulaAuth.login!({ cfg: {} as never, accountId: "work", runtime: out.runtime as never });

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [method, opts, params, extra] = callGatewayFromCli.mock.calls[0]!;
    expect(method).toBe("web.login.start");
    expect(params).toEqual({ channel: "azula", accountId: "work", timeoutMs: 60_000 });
    // The request must be allowed to outlast the work it asks for, and must not draw a spinner over the QR.
    expect(Number((opts as { timeout: string }).timeout)).toBeGreaterThan(60_000);
    expect(extra).toEqual({ progress: false });
    expect(out.lines).toEqual(["INVITE"]);
  });

  it("uses the default account when none is given", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ connected: true, message: "x" });
    await azulaAuth.login!({ cfg: {} as never, accountId: null, runtime: runtime().runtime as never });
    expect(callGatewayFromCli.mock.calls[0]![2]).toMatchObject({ accountId: "default" });
  });

  it("explains why a gateway is needed, and the offline alternative, when none can be reached", async () => {
    callGatewayFromCli.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18789"), { name: "GatewayTransportError" }),
    );

    const failure = azulaAuth.login!({ cfg: {} as never, accountId: "default", runtime: runtime().runtime as never });

    await expect(failure).rejects.toThrow(/could not reach the OpenClaw gateway \(connect ECONNREFUSED/);
    await expect(failure).rejects.toThrow(/only the gateway's account can hold it[\s\S]*openclaw gateway[\s\S]*scripts\/pair\.mjs/);
  });

  it("passes the gateway's own refusal through untouched", async () => {
    callGatewayFromCli.mockRejectedValueOnce(new Error("azula account 'default' is disabled; enable it before pairing a phone"));
    await expect(
      azulaAuth.login!({ cfg: {} as never, accountId: "default", runtime: runtime().runtime as never }),
    ).rejects.toThrow("azula account 'default' is disabled; enable it before pairing a phone");
  });
});

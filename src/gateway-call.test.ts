import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn();
const isGatewayTransportError = vi.fn();
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({ callGatewayFromCli, isGatewayTransportError }));

const { callGatewayViaCli } = await import("./gateway-call.js");

beforeEach(() => {
  callGatewayFromCli.mockReset();
  isGatewayTransportError.mockReset();
  isGatewayTransportError.mockReturnValue(false);
});

describe("callGatewayViaCli", () => {
  it("makes the call the way every CLI command does, with the method, a timeout and the params", async () => {
    callGatewayFromCli.mockResolvedValue({ ok: true });
    const result = await callGatewayViaCli("send", { to: "azula:phone" }, 45_000, () => "unreachable");

    expect(result).toEqual({ ok: true });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "send",
      { timeout: "45000" },
      { to: "azula:phone" },
      { progress: false },
    );
  });

  it("explains an unreachable gateway in the caller's words, with the cause", async () => {
    callGatewayFromCli.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:18789"));
    isGatewayTransportError.mockReturnValue(true);
    await expect(
      callGatewayViaCli("send", {}, 1000, (cause) => `no gateway (${cause}); start it`),
    ).rejects.toThrow("no gateway (ECONNREFUSED 127.0.0.1:18789); start it");
  });

  it("passes the gateway's own refusal through untouched", async () => {
    const refusal = new Error("the azula channel has no running bridge for account 'default'");
    callGatewayFromCli.mockRejectedValue(refusal);
    await expect(callGatewayViaCli("send", {}, 1000, () => "unreachable")).rejects.toBe(refusal);
  });
});

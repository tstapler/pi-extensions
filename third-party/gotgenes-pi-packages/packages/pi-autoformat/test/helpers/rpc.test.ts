import { describe, expect, it } from "vitest";

import { resolveRpcTimeoutMs, rpcVitestTimeoutMs } from "./rpc";

describe("resolveRpcTimeoutMs", () => {
  it("defaults to 30000 when the env var is unset", () => {
    expect(resolveRpcTimeoutMs({})).toBe(30_000);
  });

  it("honors a valid positive integer override", () => {
    expect(resolveRpcTimeoutMs({ PI_AUTOFORMAT_RPC_TIMEOUT_MS: "60000" })).toBe(
      60_000,
    );
  });

  it.each([
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-5000"],
    ["empty string", ""],
    ["non-integer", "30s"],
  ])("falls back to the default on an invalid value (%s)", (_label, raw) => {
    expect(resolveRpcTimeoutMs({ PI_AUTOFORMAT_RPC_TIMEOUT_MS: raw })).toBe(
      30_000,
    );
  });
});

describe("rpcVitestTimeoutMs", () => {
  it("is the resolved harness timeout plus the margin by default", () => {
    expect(rpcVitestTimeoutMs({})).toBe(35_000);
  });

  it("reflects an env override", () => {
    expect(rpcVitestTimeoutMs({ PI_AUTOFORMAT_RPC_TIMEOUT_MS: "60000" })).toBe(
      65_000,
    );
  });

  it("is always strictly greater than the resolved harness timeout", () => {
    const envs = [
      {},
      { PI_AUTOFORMAT_RPC_TIMEOUT_MS: "60000" },
      { PI_AUTOFORMAT_RPC_TIMEOUT_MS: "invalid" },
    ];
    for (const env of envs) {
      expect(rpcVitestTimeoutMs(env)).toBeGreaterThan(resolveRpcTimeoutMs(env));
    }
  });
});

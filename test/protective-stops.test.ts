import { describe, expect, it } from "vitest";
import { OkxExecutor } from "../src/exec/executor.js";
import type { OkxCli } from "../src/okx/cli.js";
import { coin, view } from "./fixtures.js";

describe("OKX native protective stops", () => {
  it("reports a canceled order with confirmed quantity as partial", async () => {
    const cli: OkxCli = { async run() { return [{ state: "canceled", ordId: "order-1", accFillSz: "1", avgPx: "100", fee: "-0.1", uTime: "1000" }] as never; } };
    const market = view([coin("BTC")]);
    const inst = market.instruments.values().next().value!;
    const exec = new OkxExecutor(cli, { bee1: { apiKey: "k", secretKey: "s", passphrase: "p" } }, false, (id) => market.instruments.get(id), 2);

    await expect(exec.orderByClientId("bee1", inst.instId, "partial", 2)).resolves.toMatchObject({ ok: true, state: "partial", contracts: 1 });
  });

  it("places, tightens, resizes, and cancels a reduce-only conditional stop", async () => {
    const calls: string[][] = [];
    const cli: OkxCli = { async run(call) {
      calls.push(call.args);
      if (call.args.includes("place")) return [{ algoId: "algo-1", sCode: "0" }] as never;
      if (call.args.includes("fills")) return [
        { side: "sell", fillSz: "2", fillPx: "98", fee: "-0.10", ts: "900", ordId: "old-trim" },
        { side: "sell", fillSz: "2", fillPx: "99", fee: "-0.10", ts: "1000", ordId: "stop-order" },
      ] as never;
      if (call.args.includes("orders")) return [{ algoId: "algo-1", state: "live", side: "sell", sz: "2", slTriggerPx: "100", slTriggerPxType: "mark", slOrdPx: "-1", reduceOnly: "true" }] as never;
      if (call.args.includes("balance")) return [{ details: [{ ccy: "USDC", eq: "333" }] }] as never;
      if (call.args.includes("config")) return [{ uid: "account-1" }] as never;
      return [{ algoId: "algo-1", sCode: "0" }] as never;
    } };
    const market = view([coin("BTC")]);
    const inst = market.instruments.values().next().value!;
    const exec = new OkxExecutor(cli, { bee1: { apiKey: "k", secretKey: "s", passphrase: "p" } }, false, (id) => market.instruments.get(id), 2);
    const placed = await exec.protect("bee1", { instId: inst.instId, closeSide: "sell", contracts: 2, triggerPx: 99.991 });
    expect(placed).toMatchObject({ ok: true, algoId: "algo-1", triggerPx: 100 });
    expect(calls[0]).toEqual(expect.arrayContaining(["place", "--reduceOnly", "--cxlOnClosePos", "--slTriggerPx", "100.00", "--slOrdPx=-1"]));

    await exec.protect("bee1", { instId: inst.instId, closeSide: "sell", contracts: 3, triggerPx: 101, algoId: "algo-1" });
    expect(calls[1]).toEqual(expect.arrayContaining(["amend", "--algoId", "algo-1", "--newSz", "3", "--newSlTriggerPx", "101.00"]));
    expect(await exec.cancelProtection("bee1", inst.instId, "algo-1")).toBe(true);
    expect(calls[2]).toEqual(expect.arrayContaining(["cancel", "--algoId", "algo-1"]));
    // The OKX CLI (node parseArgs) rejects a separate argument like "-1" as ambiguous: negatives must use --opt=-1.
    expect(calls.flat().filter((arg) => /^-\d/.test(arg))).toEqual([]);
    await expect(exec.externalClose("bee1", inst.instId, "sell", 500, 2, new Set(["old-trim"]))).resolves.toEqual({ ordId: "stop-order", avgPx: 99, feeUsd: 0.1, ts: 1000 });
    await expect(exec.protectionMatches("bee1", { instId: inst.instId, closeSide: "sell", contracts: 2, triggerPx: 100, algoId: "algo-1" })).resolves.toBe(true);
    await expect(exec.protectionMatches("bee1", { instId: inst.instId, closeSide: "sell", contracts: 3, triggerPx: 100, algoId: "algo-1" })).resolves.toBe(false);
    await expect(exec.accountEquity("bee1")).resolves.toBe(333);
    await expect(exec.accountId("bee1")).resolves.toBe("account-1");
  });

  it("does not accept non-mark or non-market protection", async () => {
    const cli: OkxCli = { async run() { return [{ algoId: "algo-1", state: "live", side: "sell", sz: "2", slTriggerPx: "100", slTriggerPxType: "last", slOrdPx: "99", reduceOnly: "true" }] as never; } };
    const market = view([coin("BTC")]);
    const inst = market.instruments.values().next().value!;
    const exec = new OkxExecutor(cli, { bee1: { apiKey: "k", secretKey: "s", passphrase: "p" } }, false, (id) => market.instruments.get(id), 2);
    await expect(exec.protectionMatches("bee1", { instId: inst.instId, closeSide: "sell", contracts: 2, triggerPx: 100, algoId: "algo-1" })).resolves.toBe(false);
  });
});

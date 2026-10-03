import { describe, expect, it } from "vitest";
import { OkxExecutor } from "../src/exec/executor.js";
import type { OkxCli } from "../src/okx/cli.js";
import { coin, view } from "./fixtures.js";

describe("opening execution bounds", () => {
  it("refuses unbounded OKX exposure while allowing reduce-only exits", async () => {
    const calls: string[][] = [];
    const cli: OkxCli = { async run(call) { calls.push(call.args); return [{ sCode: "0", ordId: "x" }] as never; } };
    const market = view([coin("BTC")]);
    const inst = market.instruments.values().next().value!;
    const exec = new OkxExecutor(cli, { bee1: { apiKey: "k", secretKey: "s", passphrase: "p" } }, false, (id) => market.instruments.get(id), 2);
    await expect(exec.market("bee1", { instId: inst.instId, side: "buy", contracts: 1, reduceOnly: false, clOrdId: "open" })).resolves.toMatchObject({ ok: false, error: { code: "NO_PRICE_BOUND" } });
    expect(calls).toEqual([]);
  });

  it("uses a limit order when exposure has a price guard", async () => {
    const calls: string[][] = [];
    const cli: OkxCli = { async run(call) { calls.push(call.args); return [{ state: "filled", ordId: "x", accFillSz: "1", avgPx: "100", fee: "0" }] as never; } };
    const market = view([coin("BTC")]);
    const inst = market.instruments.values().next().value!;
    const exec = new OkxExecutor(cli, { bee1: { apiKey: "k", secretKey: "s", passphrase: "p" } }, false, (id) => market.instruments.get(id), 2);
    await exec.market("bee1", { instId: inst.instId, side: "buy", contracts: 1, reduceOnly: false, clOrdId: "open", limitPx: 101 });
    expect(calls.at(-2)).toEqual(expect.arrayContaining(["--ordType", "ioc", "--px", "101"]));
  });
});

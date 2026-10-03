// 27 Sep 2026: bizzy's 2x breakout was rejected by OKX (51008) and resent every tick: 98 orders in 40 minutes.
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine, ORDER_REJECT_PAUSE_MS } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import type { Executor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import type { MarketFeed } from "../src/market/data.js";
import { parseCliError } from "../src/okx/cli.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

describe("OKX error text", () => {
  it("takes OKX's own sMsg when the CLI prints the JSON response, not the first line '['", () => {
    const e = parseCliError("", '[\n  {\n    "sCode": "51008",\n    "sMsg": "Order failed. Insufficient USDC margin in account"\n  }\n]');
    expect(e.code).toBe("51008");
    expect(e.message).toBe("Order failed. Insufficient USDC margin in account");
  });
});

describe("a rejected new order pauses that bee's new orders", () => {
  it("one order, then nothing new for the pause window, then it may try again", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const v = view([coin("ENA", { ret24hPct: 25, ret7dPct: 43 }), coin("SUI", { ret24hPct: 12, ret7dPct: 40 })]);
    let now = NOW;
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, get lastRefreshAt() { return now; } } as unknown as MarketFeed;
    const client: SystemOne = {
      async systemOne() {
        return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: "APE_ENA", confidence: 0.9, probabilities: { APE_ENA: 0.9, APE_SUI: 0.1 } }, conviction: { type: "score", score: 3, confidence: 1, legend: {}, probabilities: {} } } } as never;
      },
    };
    const sent: string[] = [];
    const exec: Executor = {
      kind: "sim",
      async init() {},
      async market(bee, req) {
        sent.push(`${bee}:${req.instId}:${req.reduceOnly}`);
        return { ok: false, state: "unknown", error: { code: "51008", message: "insufficient margin" } } as never;
      },
      async positions() { return []; },
      async fundingBills() { return []; },
      async feesFor() { return new Map(); },
      async protect(_bee, req) { return { ok: true, algoId: null, triggerPx: req.triggerPx }; },
      async cancelProtection() { return true; },
      async externalClose() { return null; },
      async protectionMatches() { return true; },
      async accountEquity() { return null; },
      async accountId() { return null; },
      async accountInfo() { return null; },
      async pendingOrders() { return null; },
      async conditionalOrders() { return null; },
    };
    const alerts: string[] = [];
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => now }), exec, bus: new EventBus(db), alerts: { send: (t: string) => alerts.push(t) } as unknown as Alerts, now: () => now });
    await engine.start();
    engine.stop();
    for (const id of ["bee1", "bee2"] as const) engine.bees[id].cap = "trade_cap"; // only the Momentum bee acts
    engine.bees.bee3.flatSince = now - 60 * 60_000;
    await engine.tick();
    const first = sent.filter((s) => s.startsWith("bee3")).length;
    expect(first).toBe(1);
    for (let i = 0; i < 20; i++) {
      now += 5_000;
      await engine.tick();
    }
    expect(sent.filter((s) => s.startsWith("bee3")).length).toBe(1);
    expect(alerts.filter((a) => a.includes("rejected")).length).toBe(1);
    now += ORDER_REJECT_PAUSE_MS;
    await engine.tick();
    expect(sent.filter((s) => s.startsWith("bee3")).length).toBe(2);
  });
});

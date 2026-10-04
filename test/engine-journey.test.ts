import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor, type Executor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import type { MarketFeed } from "../src/market/data.js";
import { NOW, coin, testConfig, view } from "./fixtures.js";

type EngineOrders = { order(id: "bee1", decision: number, inst: string, side: "buy" | "sell", qty: number, reduceOnly: boolean, purpose: string): Promise<string>; syncProtection(id: "bee1"): Promise<boolean> };

function decision(db: Db, action: unknown) {
  return db.insertDecision({ bee: "bee1", ts: NOW, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null, conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null, action, vetoedBy: null, forcedBy: null, status: "journey" });
}

describe("launch engine journeys", () => {
  it("paper opens, adds, marks, and closes a persisted position", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const market = view([coin("ENA")]);
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed: { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed, exec: new SimExecutor(() => market, 0), bus: new EventBus(db), alerts: new Alerts(undefined), jev: new Jev({ ...cfg.jev, client: { async systemOne() { throw new Error("unused"); } }, now: () => NOW }), now: () => NOW, ids: ["bee1"] });
    await engine.start();
    const orders = engine as unknown as EngineOrders;
    const inst = market.stats.keys().next().value!;
    expect(await orders.order("bee1", decision(db, { kind: "open" }), inst, "buy", 2, false, "open")).toBe("complete");
    expect(await orders.order("bee1", decision(db, { kind: "add" }), inst, "buy", 1, false, "add")).toBe("complete");
    expect(engine.bees.bee1.position).toMatchObject({ contracts: 3 });
    expect(await orders.order("bee1", decision(db, { kind: "close" }), inst, "sell", 3, true, "close")).toBe("complete");
    expect(engine.bees.bee1.position).toBeNull();
    expect(db.recentEvents(20).join(" ")).toContain("fill");
  });

  it("fake OKX recovers an unknown order after a file-backed restart", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const market = view([coin("ENA")]);
    const path = join(mkdtempSync(join(tmpdir(), "beebots-launch-")), "bees.sqlite");
    const db = new Db(path);
    const exec: Executor = { kind: "okx", async init() {}, async market() { return { ok: false, state: "unknown", error: { code: "timeout", message: "lost" } }; }, async orderByClientId() { return { ok: true, ordId: "recovered", contracts: 1, avgPx: 100, feeUsd: 0, ts: NOW }; }, async positions() { return []; }, async fundingBills() { return []; }, async feesFor() { return new Map(); }, async protect() { return { ok: true, algoId: "stop", triggerPx: 90 }; }, async cancelProtection() { return true; }, async externalClose() { return null; }, async protectionMatches() { return true; }, async accountInfo() { return null; }, async accountEquity() { return 333; }, async accountId() { return null; }, async pendingOrders() { return []; }, async conditionalOrders() { return []; }, async cancelPendingOrders() { return true; }, async cancelConditionalOrders() { return true; } };
    const engine = new Engine({ cfg, db, feed: { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed, exec, bus: new EventBus(db), alerts: new Alerts(undefined), jev: new Jev({ ...cfg.jev, client: { async systemOne() { throw new Error("unused"); } }, now: () => NOW }), now: () => NOW, ids: ["bee1"] });
    await engine.start();
    const inst = market.stats.keys().next().value!;
    await (engine as unknown as EngineOrders).order("bee1", decision(db, { kind: "open" }), inst, "buy", 1, false, "open");
    await engine.reconcile();
    engine.stop();
    db.close();
    const restarted = new Db(path);
    expect(restarted.raw.prepare("SELECT state FROM orders").get()).toEqual({ state: "filled" });
    expect(restarted.raw.prepare("SELECT COUNT(*) AS n FROM fills").get()).toEqual({ n: 1 });
    restarted.close();
  });
});

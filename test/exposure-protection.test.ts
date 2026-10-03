import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import type { Executor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import { freshBee } from "../src/ledger.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

const silentJev = (cfg: ReturnType<typeof testConfig>) => new Jev({ ...cfg.jev, client: { async systemOne() { throw new Error("not used"); } }, now: () => NOW });

function executor(kind: "sim" | "okx", market: Executor["market"], protect: Executor["protect"] = async (_bee, req) => ({ ok: true, algoId: "stop", triggerPx: req.triggerPx })): Executor {
  return {
    kind, market, protect, async init() {}, async orderByClientId() { return null; }, async positions() { return []; }, async fundingBills() { return []; },
    async feesFor() { return new Map(); }, async cancelProtection() { return true; }, async externalClose() { return null; }, async protectionMatches() { return true; },
    async accountInfo() { return null; }, async accountEquity() { return 333; }, async accountId() { return null; }, async pendingOrders() { return []; }, async conditionalOrders() { return []; },
  };
}

describe("post-fill exposure and protection", () => {
  it("trims an excessive fill to the initial-stop loss budget", async () => {
    const cfg = testConfig({ MAX_INITIAL_STOP_LOSS_USD: "25" });
    const market = view([coin("ENA")]);
    const db = new Db(":memory:");
    const exec = executor("sim", async (_bee, req) => ({ ok: true, ordId: null, contracts: req.contracts, avgPx: 100, feeUsd: 0, ts: NOW }));
    const engine = new Engine({ cfg, db, feed: { view: () => market } as MarketFeed, jev: silentJev(cfg), exec, bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW, ids: ["bee1"] });
    const p = freshBee("bee1", 333, NOW);
    p.position = { instId: "ENA-USD_UM_XPERP-310404", coin: "ENA", side: "long", contracts: 1_000, entryPx: 100, openedAt: NOW, stopPx: 90, initialStopPx: 90, riskUsd: 100 };
    p.flatSince = null;
    engine.bees.bee1 = p;
    const decisionId = db.insertDecision({ bee: "bee1", ts: NOW, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null, conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null, action: { kind: "trim", fraction: 1 }, vetoedBy: null, forcedBy: null, status: "test" });

    await (engine as unknown as { enforceExposure(id: "bee1", decisionId: number, purpose: string): Promise<boolean> }).enforceExposure("bee1", decisionId, "fill_excess");

    expect(engine.bees.bee1.position?.contracts).toBe(250);
  });

  it("emits a critical event and flattens when native protection fails", async () => {
    const cfg = testConfig();
    const market = view([coin("ENA")]);
    const db = new Db(":memory:");
    const sent: boolean[] = [];
    const exec = executor("okx", async (_bee, req) => { sent.push(req.reduceOnly); return { ok: true, ordId: "close", contracts: req.contracts, avgPx: 100, feeUsd: 0, ts: NOW }; }, async () => ({ ok: false, error: { code: "STOP", message: "rejected" } }));
    exec.positions = async () => [{ instId: "ENA-USD_UM_XPERP-310404", pos: 10, avgPx: 100 }];
    const events: Array<Record<string, unknown>> = [];
    const bus = new EventBus(db);
    bus.subscribe((_line, event) => events.push(event));
    const bee = freshBee("bee1", 333, NOW);
    bee.position = { instId: "ENA-USD_UM_XPERP-310404", coin: "ENA", side: "long", contracts: 10, entryPx: 100, openedAt: NOW, stopPx: 90, initialStopPx: 90, riskUsd: 10 };
    bee.flatSince = null;
    db.saveBee(bee, NOW);
    const engine = new Engine({ cfg, db, feed: { view: () => market, refresh: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed, jev: silentJev(cfg), exec, bus, alerts: new Alerts(undefined), now: () => NOW, ids: ["bee1"] });

    await engine.start();
    engine.stop();

    expect(sent).toEqual([true]);
    expect(engine.bees.bee1.position).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({ type: "status", event: "critical", severity: "critical" }));
  });
});

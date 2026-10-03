import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import type { ExchangePosition, Executor, FundingBill, FundingBillPage } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import { freshBee } from "../src/ledger.js";
import type { MarketFeed } from "../src/market/data.js";
import { coin, NOW, testConfig, view } from "./fixtures.js";

function fakeExchange(positions: () => ExchangePosition[] | null, sent: string[], externalClose: { ordId: string; avgPx: number; feeUsd: number; ts: number } | null = null): Executor {
  return {
    kind: "okx",
    async init() {},
    async market(_bee, req) {
      sent.push(req.clOrdId);
      return { ok: true, ordId: "order-1", contracts: req.contracts, avgPx: 100, feeUsd: 0, ts: NOW };
    },
    async positions() { return positions(); },
    async fundingBills() { return []; },
    async feesFor() { return new Map(); },
    async protect(_bee, req) { return { ok: true, algoId: "stop-1", triggerPx: req.triggerPx }; },
    async cancelProtection() { return true; },
    async externalClose() { return externalClose; },
    async protectionMatches() { return true; },
    async accountInfo() { return null; },
    async accountEquity() { return 333; },
    async accountId() { return null; },
    async pendingOrders() { return []; },
    async conditionalOrders() { return []; },
  };
}

function openingJev(): SystemOne {
  return { async systemOne() {
    return { model: "fake", usage: { input_tokens: 1, output_tokens: 0 }, answers: { action: { type: "choice", choice: "APE_ENA", confidence: 1, probabilities: { APE_ENA: 1 } }, conviction: { type: "score", score: 3, confidence: 1, legend: {}, probabilities: {} } } } as never;
  } };
}

function fundingPages(bills: FundingBill[]): Map<string, FundingBillPage> {
  return new Map([
    ["start", { items: bills.slice(0, 100), next: "page-2" }],
    ["page-2", { items: bills.slice(100), next: null }],
  ]);
}

describe("exchange reconciliation readiness", () => {
  it("blocks opening decisions until unreadable exchange state recovers", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const market = view([coin("ENA", { ret24hPct: 25, ret7dPct: 43 }), coin("SUI", { ret24hPct: 12, ret7dPct: 40 })]);
    const feed = { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    let exchangePositions: ExchangePosition[] | null = null;
    const sent: string[] = [];
    const engine = new Engine({ cfg, db: new Db(":memory:"), feed, jev: new Jev({ ...cfg.jev, client: openingJev(), now: () => NOW }), exec: fakeExchange(() => exchangePositions, sent), bus: new EventBus(new Db(":memory:")), alerts: { send() {} } as unknown as Alerts, now: () => NOW });
    await engine.start();
    engine.stop();
    engine.bees.bee1.cap = "trade_cap";
    engine.bees.bee2.cap = "trade_cap";
    engine.bees.bee3.flatSince = NOW - 60 * 60_000;

    await engine.tick();
    expect(sent).toEqual([]);
    expect(engine.snapshot().recon.ok).toBe(false);

    exchangePositions = [];
    await engine.reconcile();
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(engine.snapshot().recon.ok).toBe(true);
  });

  it("treats every exchange position as authoritative", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const market = view([coin("ENA"), coin("SUI")]);
    const feed = { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const engine = new Engine({ cfg, db: new Db(":memory:"), feed, jev: new Jev({ ...cfg.jev, client: openingJev(), now: () => NOW }), exec: fakeExchange(() => [{ instId: "ENA-USD_UM_XPERP-310404", pos: 1, avgPx: 100 }, { instId: "SUI-USD_UM_XPERP-310404", pos: 1, avgPx: 100 }], []), bus: new EventBus(new Db(":memory:")), alerts: { send() {} } as unknown as Alerts, now: () => NOW });
    await engine.start();
    engine.stop();

    expect(engine.snapshot().recon).toMatchObject({ ok: false, detail: expect.stringContaining("multiple OKX positions") });
  });

  it("rejects an average-entry mismatch and adopts an external reduction without invented P&L", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const market = view([coin("ENA")]);
    const feed = { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const db = new Db(":memory:");
    const bee = freshBee("bee1", 333, NOW);
    bee.position = { instId: "ENA-USD_UM_XPERP-310404", coin: "ENA", side: "long", contracts: 10, entryPx: 100, openedAt: NOW - 1_000, stopPx: 90, riskUsd: 10 };
    bee.flatSince = null;
    db.saveBee(bee, NOW);
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client: openingJev(), now: () => NOW }), exec: fakeExchange(() => [{ instId: bee.position!.instId, pos: 5, avgPx: 101 }], [], { ordId: "external-close", avgPx: 101, feeUsd: 0.5, ts: NOW }), bus: new EventBus(db), alerts: { send() {} } as unknown as Alerts, now: () => NOW, ids: ["bee1"] });
    await engine.start();
    engine.stop();

    expect(engine.snapshot().recon).toMatchObject({ ok: false, detail: expect.stringContaining("average entry") });
    expect(engine.bees.bee1.position).toMatchObject({ contracts: 5, entryPx: 100 });
    expect(engine.bees.bee1.totals.realisedUsd).toBe(0.05);
    expect(engine.bees.bee1.totals.feesUsd).toBe(0.5);
  });

  it("recovers every funding page before advancing its durable cursor", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const market = view([coin("ENA")]);
    const feed = { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const db = new Db(":memory:");
    const pages = fundingPages(Array.from({ length: 101 }, (_, n) => ({ billId: `bill-${n}`, instId: "ENA-USD_UM_XPERP-310404", amountUsd: 1, ts: NOW + n })));
    const exec = fakeExchange(() => [], []);
    exec.fundingBills = async (_bee, after) => pages.get(after ?? "start") ?? null;
    exec.accountEquity = async () => 434;
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client: openingJev(), now: () => NOW }), exec, bus: new EventBus(db), alerts: { send() {} } as unknown as Alerts, now: () => NOW, ids: ["bee1"] });
    await engine.start();
    engine.stop();

    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM funding").get()).toEqual({ n: 101 });
    expect(db.getMeta("funding_cursor_bee1")).toBe("bill-0");
  });

  it("stays unreconciled when a saved funding cursor is absent from history", async () => {
    const cfg = testConfig({ DRY_RUN: "true" });
    const market = view([coin("ENA")]);
    const feed = { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const db = new Db(":memory:");
    db.setMeta("funding_cursor_bee1", "missing-bill");
    const exec = fakeExchange(() => [], []);
    exec.fundingBills = async () => [];
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client: openingJev(), now: () => NOW }), exec, bus: new EventBus(db), alerts: { send() {} } as unknown as Alerts, now: () => NOW, ids: ["bee1"] });
    await engine.start();
    engine.stop();

    expect(engine.snapshot().recon).toMatchObject({ ok: false, detail: expect.stringContaining("could not read OKX funding") });
    expect(db.getMeta("funding_cursor_bee1")).toBe("missing-bill");
  });
});

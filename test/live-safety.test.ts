import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { aggregateCompetitionHealth } from "../src/competition-app.js";
import { Db } from "../src/db.js";
import { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor } from "../src/exec/executor.js";
import { Jev } from "../src/jev.js";
import type { MarketFeed } from "../src/market/data.js";
import { NOW, coin, testConfig, view } from "./fixtures.js";

describe("live safety health", () => {
  it("turns unhealthy when safety goes stale and recovers after a completed tick", async () => {
    let now = NOW;
    const market = view([coin("ENA")]);
    const feed = { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const cfg = testConfig({ DRY_RUN: "true", SAFETY_TICK_MS: "1000" });
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, exec: new SimExecutor(() => market, 0), bus: new EventBus(db), alerts: new Alerts(undefined), jev: new Jev({ ...cfg.jev, client: { async systemOne() { throw new Error("unused"); } }, now: () => now }), now: () => now });

    await engine.start();
    await engine.tick();
    expect(engine.health()).toMatchObject({ ok: true, release: "dev" });
    now += 5 * cfg.safetyTickMs;
    expect(engine.health()).toMatchObject({ ok: false, reasons: expect.arrayContaining(["safety loop stale"]) });
    await engine.tick();
    expect(engine.health().ok).toBe(true);
    engine.stop();
  });

  it("reports to the dead-man monitor unless a competition paper engine could mask live", async () => {
    const market = view([coin("ENA")]);
    const feed = { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const beats = async (env: Record<string, string>) => {
      const cfg = testConfig({ DRY_RUN: "true", ...env });
      const db = new Db(":memory:");
      let n = 0;
      const alerts = new Alerts(undefined, "https://monitor.test/ping");
      alerts.heartbeat = async () => (n++, true);
      const engine = new Engine({ cfg, db, feed, exec: new SimExecutor(() => market, 0), bus: new EventBus(db), alerts, jev: new Jev({ ...cfg.jev, client: { async systemOne() { throw new Error("unused"); } }, now: () => NOW }), now: () => NOW });
      await engine.start();
      await engine.tick();
      engine.stop();
      return n;
    };

    expect(await beats({})).toBeGreaterThan(0);
    expect(await beats({ COMPETITION_MODE: "true" })).toBe(0);
  });

  it("fails competition health when live is unsafe despite healthy paper", () => {
    const paper = { ok: true, reasons: [], release: "test", mode: "dry" as const, closed: false, flat: true, marketAgeMs: 0, safetyAgeMs: 0, reconciliationAgeMs: null, exchangeReadAgeMs: null, uptimeS: 1 };
    const live = { ...paper, ok: false, reasons: ["exchange reads stale"], mode: "live" as const };
    expect(aggregateCompetitionHealth(paper, live)).toMatchObject({ ok: false, reasons: ["exchange reads stale"], live });
  });

  it("reports a failed backup as unsafe", async () => {
    const market = view([coin("ENA")]);
    const status = join(mkdtempSync(join(tmpdir(), "beebots-backup-")), "status.json");
    writeFileSync(status, JSON.stringify({ ok: false, completedAt: NOW, error: "upload failed" }));
    const cfg = testConfig({ DRY_RUN: "true", BACKUP_STATUS_PATH: status });
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed: { view: () => market, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed, exec: new SimExecutor(() => market, 0), bus: new EventBus(db), alerts: new Alerts(undefined), jev: new Jev({ ...cfg.jev, client: { async systemOne() { throw new Error("unused"); } }, now: () => NOW }), now: () => NOW });
    await engine.start();
    expect(engine.health()).toMatchObject({ ok: false, reasons: expect.arrayContaining(["backup failed: upload failed"]) });
    engine.stop();
  });
});

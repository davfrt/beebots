import { describe, expect, it } from "vitest";
import type { BeeId } from "../src/config.js";
import type { Competition, RankedStrategy } from "../src/competition.js";
import { CompetitionManager } from "../src/competition-manager.js";
import { Db } from "../src/db.js";
import type { Engine } from "../src/engine.js";
import { EventBus } from "../src/events.js";

const DAY = 86_400_000;
const END = Date.UTC(2026, 8, 30);

function strategy(sourceId: string, returnPct: number): RankedStrategy {
  return { sourceId, fingerprint: sourceId, returnPct, source: "online", name: sourceId, tagline: "", style: "bizzy", rules: "Trade breakouts.", coins: ["BTC"], img: "/bees/bizzy.jpg", trades: 2, official: false };
}

describe("competition manager regressions", () => {
  it("refreshes the active live bee's copied name and portrait when its strategy is unchanged", async () => {
    const db = new Db(":memory:");
    const incumbent = strategy("same", 1);
    db.setMeta("competition_manager", JSON.stringify({
      selectedDay: "2026-09-29", activeSlot: "bee1", champion: incumbent, championSince: END - DAY,
      liveSlots: { bee1: incumbent }, paper: [], lastRanking: [], lastReason: "old", pendingHandoff: null,
    }));
    const renamed = { ...incumbent, name: "Exact Hive Name", img: "/hive/portrait/abcdef.jpg" };
    const installed: string[] = [];
    const live = {
      exclusive: async (fn: () => Promise<void>) => fn(),
      setProfile: (_id: BeeId, p: { name: string }) => installed.push(p.name),
      lastDayReturn: () => null,
    } as unknown as Engine;
    const paper = {
      exclusive: async (fn: () => Promise<void>) => fn(), slotIds: () => [] as BeeId[],
    } as unknown as Engine;
    const competition = { ingest: async () => 0, dailyOnline: () => [renamed], status: () => ({}) } as unknown as Competition;
    const manager = new CompetitionManager({ db, competition, paper, live, bus: new EventBus(db), now: () => END + 60_000 });

    await manager.select();

    expect(installed).toEqual(["Exact Hive Name"]);
    expect(manager.status().liveSlots.bee1).toMatchObject({ name: "Exact Hive Name", img: "/hive/portrait/abcdef.jpg" });
  });

  it("uses a runner only after it has completed a full local UTC day", async () => {
    const db = new Db(":memory:");
    let now = END + 60_000;
    let online = [strategy("winner", 2), strategy("runner", 1)];
    const returns: Array<[BeeId, string]> = [];
    const competition = { ingest: async () => 0, dailyOnline: () => online } as unknown as Competition;
    const paper = {
      exclusive: async (fn: () => Promise<void>) => fn(),
      slotIds: () => ["bee1", "bee2", "bee3"] as const,
      replacePaperProfile: async () => {},
      closeNow: async () => ({ ok: true, costPct: 0 }),
      lastDayReturn: (id: BeeId, day: string) => (returns.push([id, day]), 3),
      handoffCostPct: () => 0,
    } as unknown as Engine;
    const manager = new CompetitionManager({ db, competition, paper, bus: new EventBus(db), now: () => now });

    await manager.select();
    const stored = JSON.parse(db.getMeta("competition_manager")!);
    expect(stored.paper[0].startedAt).toBe(END + 60_000);
    expect(manager.portrait("runner")).toBe("/bees/bizzy.jpg");

    now += DAY * 2;
    online = [];
    await manager.select();
    expect(returns).toEqual([["bee1", "2026-10-01"], ["bee2", "2026-10-01"]]);
  });

  it("keeps a cold-start winner paper-only until its observation and approval match", async () => {
    const db = new Db(":memory:");
    let now = END + 60_000;
    const winner = strategy("winner", 2);
    const installed: BeeId[] = [];
    const live = {
      bees: { bee1: { equityUsd: 333, totals: {}, dayKey: "2026-09-30", tradesToday: 0, feesTodayUsd: 0 } },
      exclusive: async (fn: () => Promise<void>) => fn(),
      isFlat: () => true,
      setProfile: (id: BeeId) => installed.push(id),
      lastDayReturn: () => null,
    } as unknown as Engine;
    const paper = {
      exclusive: async (fn: () => Promise<void>) => fn(),
      slotIds: () => ["bee1", "bee2", "bee3"] as const,
      replacePaperProfile: async () => {},
      closeNow: async () => ({ ok: true, costPct: 0 }),
      lastDayReturn: () => 1,
      handoffCostPct: () => 0,
    } as unknown as Engine;
    const competition = { ingest: async () => 0, weeklyOnline: () => [winner], dailyOnline: () => [winner], status: () => ({}) } as unknown as Competition;
    const manager = new CompetitionManager({
      db, competition, paper, live, bus: new EventBus(db), now: () => now,
      promotion: { observeMs: DAY, approval: { fingerprint: "winner", release: "v1" }, release: "v1" },
    });

    await manager.select(true);
    expect(manager.status().champion).toBeNull();
    expect(installed).toEqual([]);

    now += DAY * 2;
    await manager.select();
    expect(manager.status().champion?.fingerprint).toBe("winner");
    expect(installed).toEqual(["bee1"]);
  });

  it("rejects an approval from a different release", async () => {
    const db = new Db(":memory:");
    const winner = strategy("winner", 2);
    db.setMeta("competition_manager", JSON.stringify({
      selectedDay: "2026-09-29", activeSlot: null, champion: null, championSince: null, liveSlots: {}, liveInstalls: {},
      paper: [{ slot: "bee1", strategy: winner, startedAt: END - DAY }], lastRanking: [], lastReason: "old", pendingHandoff: null,
    }));
    const installed: BeeId[] = [];
    const live = {
      bees: { bee1: { equityUsd: 333, totals: {}, dayKey: "2026-09-30", tradesToday: 0, feesTodayUsd: 0 } },
      exclusive: async (fn: () => Promise<void>) => fn(), isFlat: () => true,
      setProfile: (id: BeeId) => installed.push(id), lastDayReturn: () => null,
    } as unknown as Engine;
    const paper = { exclusive: async (fn: () => Promise<void>) => fn(), slotIds: () => [] as BeeId[], lastDayReturn: () => 1, handoffCostPct: () => 0 } as unknown as Engine;
    const competition = { ingest: async () => 0, dailyOnline: () => [winner], status: () => ({}) } as unknown as Competition;
    const manager = new CompetitionManager({
      db, competition, paper, live, bus: new EventBus(db), now: () => END,
      promotion: { observeMs: DAY, approval: { fingerprint: "winner", release: "v0" }, release: "v1" },
    });

    await manager.select();
    expect(manager.status().champion).toBeNull();
    expect(installed).toEqual([]);
    expect(manager.status().reason).toMatch(/release/);
  });

  it("revokes entry authority when a saved champion's execution identity changes", () => {
    const db = new Db(":memory:");
    const champion = strategy("winner", 2);
    db.setMeta("competition_manager", JSON.stringify({
      selectedDay: "2026-09-29", activeSlot: "bee1", champion, championSince: END - DAY,
      liveSlots: { bee1: champion }, liveInstalls: {}, paper: [], lastRanking: [], lastReason: "old", pendingHandoff: null,
    }));
    const manager = new CompetitionManager({
      db, competition: { status: () => ({}) } as Competition, paper: {} as Engine, live: {} as Engine, bus: new EventBus(db),
      promotion: { observeMs: DAY, release: "v2", identity: { release: "v2", risk: { maxLeverage: 1 } } },
    });

    expect(manager.entriesAllowed("bee1")).toBe(false);
    expect(manager.status().champion).toBeNull();
    expect(manager.status().reason).toMatch(/stale/);
  });

  it("holds an approved challenger during restricted live observation", async () => {
    const db = new Db(":memory:");
    const incumbent = strategy("incumbent", 1);
    const challenger = strategy("challenger", 2);
    db.setMeta("competition_manager", JSON.stringify({
      selectedDay: "2026-09-29", activeSlot: "bee1", champion: incumbent, championSince: END - 60_000,
      liveSlots: { bee1: incumbent }, liveInstalls: {}, paper: [{ slot: "bee2", strategy: challenger, startedAt: END - DAY }], lastRanking: [], lastReason: "old", pendingHandoff: null,
    }));
    const live = { exclusive: async (fn: () => Promise<void>) => fn(), isFlat: () => true, setProfile: () => {}, lastDayReturn: () => null } as unknown as Engine;
    const paper = { exclusive: async (fn: () => Promise<void>) => fn(), slotIds: () => [] as BeeId[], lastDayReturn: () => 1, handoffCostPct: () => 0 } as unknown as Engine;
    const competition = { ingest: async () => 0, dailyOnline: () => [challenger], status: () => ({}) } as unknown as Competition;
    const manager = new CompetitionManager({
      db, competition, paper, live, bus: new EventBus(db), now: () => END,
      promotion: { observeMs: DAY, restrictedLiveMs: DAY, approval: { fingerprint: "challenger", release: "v1" }, release: "v1" },
    });

    await manager.select();
    expect(manager.status().champion?.fingerprint).toBe("incumbent");
    expect(manager.status().reason).toMatch(/restricted/);
  });

  it("records the live champion's exact installation equity and totals", async () => {
    const db = new Db(":memory:");
    const incumbent = strategy("incumbent", 1);
    const winner = strategy("winner", 2);
    db.setMeta("competition_manager", JSON.stringify({
      selectedDay: "2026-09-29", activeSlot: "bee1", champion: incumbent, championSince: END - DAY,
      liveSlots: { bee1: incumbent }, paper: [{ slot: "bee2", strategy: winner, startedAt: END - DAY }], lastRanking: [], lastReason: "old", pendingHandoff: null,
    }));
    const totals = { feesUsd: 1.2, fundingUsd: -0.4, jevUsd: 0.03, realisedUsd: 8, decisions: 12, orders: 3 };
    const live = {
      bees: { bee1: { equityUsd: 412.34, totals, dayKey: "2026-09-30", tradesToday: 2, feesTodayUsd: 0.8 } },
      exclusive: async (fn: () => Promise<void>) => fn(),
      isFlat: () => true,
      setProfile: () => {},
      lastDayReturn: () => 1,
    } as unknown as Engine;
    const paper = { exclusive: async (fn: () => Promise<void>) => fn(), slotIds: () => [] as BeeId[], lastDayReturn: () => 1, handoffCostPct: () => 0 } as unknown as Engine;
    const competition = { ingest: async () => 0, dailyOnline: () => [winner, incumbent], status: () => ({}) } as unknown as Competition;
    const now = END + 60_000;
    const manager = new CompetitionManager({ db, competition, paper, live, bus: new EventBus(db), now: () => now, promotion: { observeMs: DAY, approval: { fingerprint: "winner", release: "v1" }, release: "v1" } });

    await manager.select();

    expect(manager.status().liveInstalls.bee1).toEqual({ fingerprint: "winner", installedAt: now, baselineEquityUsd: 412.34, baselineTotals: totals, baselineDay: "2026-09-30", baselineTradesToday: 2, baselineFeesTodayUsd: 0.8 });
  });

  it.each([
    ["flat", true, false, true],
    ["occupied", false, false, false],
    ["flat after a forced close", true, true, false],
  ] as const)("recovers a persisted handoff when the target is %s", async (_label, targetFlat, forced, installsWinner) => {
    const db = new Db(":memory:");
    const incumbent = strategy("incumbent", 1);
    const winner = strategy("winner", 2);
    db.setMeta("competition_manager", JSON.stringify({
      selectedDay: "2026-09-30",
      activeSlot: "bee1",
      champion: incumbent,
      championSince: END - DAY,
      liveSlots: { bee1: incumbent },
      paper: [{ slot: "bee3", strategy: incumbent, startedAt: END - DAY }],
      lastRanking: [],
      lastReason: "previous UTC day net return",
      pendingHandoff: { target: "bee2", winner, startedAt: END, selectedDay: "2026-09-30", forced },
    }));
    const installed: BeeId[] = [];
    const live = {
      exclusive: async (fn: () => Promise<void>) => fn(),
      reconcile: async () => {},
      isFlat: (id: BeeId) => id === "bee2" && targetFlat,
      setProfile: (id: BeeId) => installed.push(id),
    } as unknown as Engine;
    const manager = new CompetitionManager({
      db,
      competition: {} as Competition,
      paper: {} as Engine,
      live,
      bus: new EventBus(db),
      now: () => END + 12 * 60 * 60_000,
    });

    expect(manager.entriesAllowed("bee1")).toBe(false);
    expect(manager.paperEntriesAllowed("bee3")).toBe(false);
    await manager.select();

    const stored = JSON.parse(db.getMeta("competition_manager")!);
    expect(stored.pendingHandoff).toBeNull();
    expect(stored.activeSlot).toBe(installsWinner ? "bee2" : "bee1");
    expect(stored.champion.fingerprint).toBe(installsWinner ? "winner" : "incumbent");
    expect(installed).toEqual(installsWinner ? ["bee2"] : []);
    expect(manager.entriesAllowed(installsWinner ? "bee2" : "bee1")).toBe(true);
  });
});

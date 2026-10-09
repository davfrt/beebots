import { describe, expect, it } from "vitest";
import { Competition, executionFingerprint, pickRunners, rankStrategies, strategyFingerprint, type RankedStrategy } from "../src/competition.js";
import { winnerAfterHandoffCost } from "../src/competition-manager.js";
import { Db } from "../src/db.js";

const DAY = 86_400_000;
const END = Date.UTC(2026, 8, 29);

function bee(over: Record<string, unknown> = {}) {
  return {
    id: "hive-a:bee1", name: "Alpha", tagline: "", style: "bizzy", pnlPct: 10, weekPct: 3, trades: 2,
    verified: true, official: false, retired: false, lastSeen: END, instructions: "Trade breakouts.", coins: ["BTC"], img: "/hive/portrait/abcdef123456.jpg", ...over,
  };
}

function response(bees: unknown[]) {
  return new Response(JSON.stringify({ total: bees.length, page: 1, per: 50, bees }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("competition observer", () => {
  it("requires a complete day with the same strategy and computes net return", async () => {
    const db = new Db(":memory:");
    let now = END - DAY;
    let body = [bee({ pnlPct: 10, lastSeen: now })];
    const c = new Competition({ db, url: "https://hive.test", now: () => now, fetch: async () => response(body) });
    for (let hour = 0; hour <= 24; hour++) {
      now = END - DAY + hour * 3_600_000;
      body = [bee({ pnlPct: hour === 24 ? 21 : 10, lastSeen: now })];
      await c.ingest();
    }
    const [winner] = c.dailyOnline(END);
    expect(winner).toMatchObject({ sourceId: "hive-a:bee1", img: "/hive/portrait/abcdef123456.jpg" });
    expect(winner!.returnPct).toBeCloseTo(10);

    const changed = strategyFingerprint({ style: "bizzy", instructions: "Different rules.", coins: ["BTC"] });
    db.raw.prepare("UPDATE hive_observations SET fingerprint=? WHERE bucket_ts=?").run(changed, END);
    expect(c.dailyOnline(END)).toEqual([]);
  });

  it("filters unverified, stale, retired, uncopiable, and one-trade bots", async () => {
    const db = new Db(":memory:");
    const bees = [
      bee(),
      bee({ id: "bad-verified", verified: false }),
      bee({ id: "bad-stale", lastSeen: END - DAY - 1 }),
      bee({ id: "bad-retired", retired: true }),
      bee({ id: "bad-rules", instructions: null }),
      bee({ id: "bad-trades", trades: 1 }),
      bee({ id: "bad-oversized", instructions: "x".repeat(601) }),
    ];
    const c = new Competition({ db, url: "https://hive.test", now: () => END, fetch: async () => response(bees) });
    expect(await c.ingest()).toBe(1);
    expect(c.status()).toMatchObject({ observed: 1, observedAt: END });
  });

  it("deduplicates configurations and uses deterministic ranking", () => {
    const row = (sourceId: string, fingerprint: string, returnPct: number): RankedStrategy => ({
      sourceId, fingerprint, returnPct, source: "online", name: sourceId, tagline: "", style: "bizzy", rules: "x", coins: [], img: "/bees/bizzy.jpg", trades: 2, official: false,
    });
    expect(rankStrategies([row("b", "same", 2), row("a", "same", 2), row("c", "other", 3)]).map((r) => r.sourceId)).toEqual(["c", "a"]);
    const twin = (id: string, style: RankedStrategy["style"], coins: string[]) => ({ ...row(id, id, 0), style, coins });
    expect(pickRunners([twin("a", "breezy", ["BTC", "ETH"]), twin("b", "breezy", ["eth", "btc"]), twin("c", "bizzy", []), twin("d", "breezy", ["SOL"])], 3).map((r) => r.sourceId)).toEqual(["a", "c", "d"]);
    expect(pickRunners([twin("a", "breezy", ["BTC"]), twin("b", "breezy", ["BTC"])], 3).map((r) => r.sourceId)).toEqual(["a", "b"]);
    const ranked = rankStrategies([row("incumbent", "old", 2), row("challenger", "new", 2.1)]);
    expect(winnerAfterHandoffCost(ranked, "old", 0.15)?.sourceId).toBe("incumbent");
    expect(winnerAfterHandoffCost(ranked, "old", 0.05)?.sourceId).toBe("challenger");
  });

  it("changes the live-authority identity when the release or risk policy changes", () => {
    const candidate = { style: "bizzy" as const, rules: "Trade breakouts.", coins: ["BTC"] };
    const v1 = executionFingerprint(candidate, { release: "v1", risk: { maxLeverage: 2 } });
    expect(executionFingerprint(candidate, { release: "v2", risk: { maxLeverage: 2 } })).not.toBe(v1);
    expect(executionFingerprint(candidate, { release: "v1", risk: { maxLeverage: 1 } })).not.toBe(v1);
  });
});

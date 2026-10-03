import { describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import type { BeeId } from "../src/config.js";
import type { Executor } from "../src/exec/executor.js";
import { preflightLiveAccounts } from "../src/live-preflight.js";
import { testConfig } from "./fixtures.js";

type Account = {
  uid: string;
  mainUid: string;
  permissions: readonly string[];
  ipBound: boolean;
  equity: number;
  positions: number | null;
  orders: number | null;
  conditionalOrders: number | null;
};

function fakeAccounts(over: Partial<Record<BeeId, Partial<Account>>> = {}): Executor {
  const accounts = Object.fromEntries((["bee1", "bee2", "bee3"] as BeeId[]).map((bee, index) => [bee, {
    uid: `sub-${index}`, mainUid: "master", permissions: ["read", "trade"], ipBound: true, equity: 333,
    positions: 0, orders: 0, conditionalOrders: 0, ...over[bee],
  }])) as Record<BeeId, Account>;
  return {
    kind: "okx", async init() {}, async market() { throw new Error("not used"); }, async fundingBills() { return []; }, async feesFor() { return new Map(); },
    async protect() { throw new Error("not used"); }, async cancelProtection() { return true; }, async externalClose() { return null; }, async protectionMatches() { return true; },
    async accountInfo(bee) { const a = accounts[bee]; return { uid: a.uid, mainUid: a.mainUid, permissions: a.permissions, ipBound: a.ipBound }; },
    async accountId(bee) { return accounts[bee].uid; },
    async accountEquity(bee) { return accounts[bee].equity; },
    async positions(bee) { const n = accounts[bee].positions; return n === null ? null : Array.from({ length: n }, () => ({ instId: "BTC", pos: 1, avgPx: 1 })); },
    async pendingOrders(bee) { const n = accounts[bee].orders; return n === null ? null : Array.from({ length: n }, () => ({})); },
    async conditionalOrders(bee) { const n = accounts[bee].conditionalOrders; return n === null ? null : Array.from({ length: n }, () => ({})); },
  };
}

describe("live account preflight", () => {
  const cfg = () => testConfig();
  it.each([
    ["master account", { bee1: { uid: "master" } }, "subaccount"],
    ["duplicate account", { bee2: { uid: "sub-0" } }, "distinct"],
    ["withdrawal key", { bee1: { permissions: ["read", "trade", "withdraw"] } }, "withdraw"],
    ["transfer key", { bee1: { permissions: ["read", "trade", "transfer"] } }, "transfer"],
    ["unbound key", { bee1: { ipBound: false } }, "IP-bound"],
    ["missing read permission", { bee1: { permissions: ["trade"] } }, "read"],
    ["missing trade permission", { bee1: { permissions: ["read"] } }, "trade"],
    ["unexpected equity", { bee1: { equity: 300 } }, "equity"],
    ["unreadable positions", { bee1: { positions: null } }, "positions"],
    ["pending order", { bee1: { orders: 1 } }, "pending orders"],
    ["conditional order", { bee1: { conditionalOrders: 1 } }, "conditional orders"],
  ] as const)("refuses a %s", async (_name, account, refusal) => {
    await expect(preflightLiveAccounts({ cfg: cfg(), db: new Db(":memory:"), exec: fakeAccounts(account), ids: ["bee1", "bee2"] })).rejects.toThrow(refusal);
  });

  it("requires flat accounts only on first startup", async () => {
    const db = new Db(":memory:");
    await expect(preflightLiveAccounts({ cfg: cfg(), db, exec: fakeAccounts({ bee1: { positions: 1 } }), ids: ["bee1", "bee2"] })).rejects.toThrow("flat");
    db.setMeta("live_started_at", "1");
    await expect(preflightLiveAccounts({ cfg: cfg(), db, exec: fakeAccounts({ bee1: { positions: 1 } }), ids: ["bee1", "bee2"] })).resolves.toMatchObject({ slots: [{ slot: "bee1" }, { slot: "bee2" }] });
    await expect(preflightLiveAccounts({ cfg: cfg(), db, exec: fakeAccounts({ bee1: { orders: 1 } }), ids: ["bee1", "bee2"] })).rejects.toThrow("pending orders");
  });

  it("returns redacted evidence for two distinct competition subaccounts", async () => {
    const result = await preflightLiveAccounts({ cfg: cfg(), db: new Db(":memory:"), exec: fakeAccounts(), ids: ["bee1", "bee2"] });
    expect(result).toEqual({ firstStart: true, slots: [{ slot: "bee1", equityUsd: 333, flat: true }, { slot: "bee2", equityUsd: 333, flat: true }] });
    expect(JSON.stringify(result)).not.toContain("sub-");
  });
});

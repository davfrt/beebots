import type { BeeId, Config } from "./config.js";
import type { Executor, ExchangePosition } from "./exec/executor.js";

type MetaStore = {
  getMeta(key: string): string | null;
  loadBee(slot: BeeId): { position: { instId: string; side: "long" | "short"; contracts: number } | null } | null;
};

export interface LivePreflightResult {
  firstStart: boolean;
  slots: Array<{ slot: BeeId; equityUsd: number; flat: boolean }>;
}

/** Read-only account gate. It intentionally reveals no account identity or network information. */
export async function preflightLiveAccounts({ cfg, db, exec, ids }: { cfg: Config; db: MetaStore; exec: Executor; ids: readonly BeeId[] }): Promise<LivePreflightResult> {
  const firstStart = !db.getMeta("live_started_at");
  const checks = await Promise.all(ids.map(async (slot) => {
    const [account, equity, positions, orders, conditionalOrders] = await Promise.all([
      exec.accountInfo(slot), exec.accountEquity(slot), exec.positions(slot), exec.pendingOrders(slot), exec.conditionalOrders(slot),
    ]);
    if (!account) throw new Error(`live preflight: ${slot} account configuration is unreadable`);
    if (account.uid === account.mainUid) throw new Error(`live preflight: ${slot} must use an OKX EEA subaccount`);
    if (account.permissions.includes("withdraw")) throw new Error(`live preflight: ${slot} key has withdrawal permission`);
    if (account.permissions.includes("transfer")) throw new Error(`live preflight: ${slot} key has transfer permission`);
    if (!account.permissions.includes("read") || !account.permissions.includes("trade")) throw new Error(`live preflight: ${slot} key needs read and trade permissions`);
    if (!account.ipBound) throw new Error(`live preflight: ${slot} key must be IP-bound`);
    const tolerance = Math.max(1, cfg.risk.startEquityUsd * 0.02);
    if (equity === null || Math.abs(equity - cfg.risk.startEquityUsd) > tolerance) throw new Error(`live preflight: ${slot} equity differs from expected equity`);
    if (positions === null) throw new Error(`live preflight: ${slot} positions are unreadable`);
    if (orders === null) throw new Error(`live preflight: ${slot} pending orders are unreadable`);
    if (conditionalOrders === null) throw new Error(`live preflight: ${slot} conditional orders are unreadable`);
    if (firstStart && positions.length) throw new Error(`live preflight: ${slot} must be flat on first start (positions found)`);
    if (!firstStart && !matchesPersistedPosition(db.loadBee(slot)?.position ?? null, positions)) throw new Error(`live preflight: ${slot} exchange position does not match local recovery state`);
    if (orders.length) throw new Error(`live preflight: ${slot} must be flat (pending orders found)`);
    if (conditionalOrders.length) throw new Error(`live preflight: ${slot} must be flat (conditional orders found)`);
    return { account, slot, equityUsd: equity, flat: positions.length === 0 && orders.length === 0 && conditionalOrders.length === 0 };
  }));
  if (new Set(checks.map(({ account }) => account.uid)).size !== ids.length) throw new Error("live preflight: configured slots must use distinct subaccounts");
  return { firstStart, slots: checks.map(({ slot, equityUsd, flat }) => ({ slot, equityUsd, flat })) };
}

function matchesPersistedPosition(local: { instId: string; side: "long" | "short"; contracts: number } | null, exchange: ExchangePosition[]): boolean {
  if (exchange.length !== (local ? 1 : 0)) return false;
  if (!local) return true;
  const position = exchange[0]!;
  return position.instId === local.instId && Math.abs(position.pos) === local.contracts && (position.pos > 0 ? "long" : "short") === local.side;
}

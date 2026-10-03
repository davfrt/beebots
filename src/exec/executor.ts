import type { BeeId, OkxCreds } from "../config.js";
import { log } from "../log.js";
import type { Instrument, Ticker } from "../market/types.js";
import type { OkxCli } from "../okx/cli.js";
import { safeError } from "../redact.js";
import { formatStopPx, formatSz } from "./sizing.js";

export interface OrderReq {
  instId: string;
  side: "buy" | "sell";
  contracts: number;
  reduceOnly: boolean;
  clOrdId: string;
}

export type OrderResult =
  | { ok: true; ordId: string | null; contracts: number; avgPx: number; feeUsd: number; ts: number }
  | { ok: false; error: { code: string; message: string }; state: "rejected" | "unknown" };

export interface ExchangePosition {
  instId: string;
  /** Signed contracts (net mode): + long, - short. */
  pos: number;
  avgPx: number;
}

export interface FundingBill {
  billId: string;
  instId: string | null;
  amountUsd: number;
  ts: number;
}

export interface FundingBillPage {
  items: FundingBill[];
  /** Pass to the next request to continue toward older bills. */
  next: string | null;
}

export interface ExternalClose {
  ordId: string | null;
  avgPx: number;
  feeUsd: number;
  ts: number;
}

export interface AccountInfo {
  uid: string;
  mainUid: string;
  permissions: readonly string[];
  ipBound: boolean;
}

export interface ProtectiveStopReq {
  instId: string;
  closeSide: "buy" | "sell";
  contracts: number;
  triggerPx: number;
  algoId?: string;
}

export type ProtectiveStopResult = { ok: true; algoId: string | null; triggerPx: number } | { ok: false; error: { code: string; message: string } };

export interface Executor {
  readonly kind: "sim" | "okx";
  init(bee: BeeId): Promise<void>;
  market(bee: BeeId, req: OrderReq): Promise<OrderResult>;
  /** Final outcome for an order we submitted, or null while the exchange cannot establish it. */
  orderByClientId(bee: BeeId, instId: string, clOrdId: string): Promise<OrderResult | null>;
  positions(bee: BeeId): Promise<ExchangePosition[] | null>;
  fundingBills(bee: BeeId, after?: string): Promise<FundingBill[] | FundingBillPage | null>;
  /** Fees OKX charged for these order ids (USD, positive = paid). */
  feesFor(bee: BeeId, instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null>;
  protect(bee: BeeId, req: ProtectiveStopReq): Promise<ProtectiveStopResult>;
  cancelProtection(bee: BeeId, instId: string, algoId: string): Promise<boolean>;
  /** Exchange-side close not sent through market(), notably a native protective stop. */
  externalClose(bee: BeeId, instId: string, closeSide: "buy" | "sell", since: number, contracts: number, excludedOrdIds?: Set<string>): Promise<ExternalClose | null>;
  protectionMatches(bee: BeeId, req: ProtectiveStopReq & { algoId: string }): Promise<boolean>;
  accountInfo(bee: BeeId): Promise<AccountInfo | null>;
  accountEquity(bee: BeeId): Promise<number | null>;
  accountId(bee: BeeId): Promise<string | null>;
  pendingOrders(bee: BeeId): Promise<unknown[] | null>;
  conditionalOrders(bee: BeeId): Promise<unknown[] | null>;
}

/**
 * MODE=dry: real market data, simulated taker fills at the touch (mid +/- half spread), no OKX private calls.
 */
export class SimExecutor implements Executor {
  readonly kind = "sim" as const;
  constructor(
    private market_: () => { tickers: Map<string, Ticker>; instruments: Map<string, Instrument> },
    private takerFeeRate: number,
    private now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {}

  async market(_bee: BeeId, req: OrderReq): Promise<OrderResult> {
    const { tickers, instruments } = this.market_();
    const t = tickers.get(req.instId);
    const inst = instruments.get(req.instId);
    if (!t || !inst) return { ok: false, error: { code: "SIM", message: "no ticker" }, state: "rejected" };
    const px = req.side === "buy" ? (t.ask > 0 ? t.ask : t.last) : t.bid > 0 ? t.bid : t.last;
    const feeUsd = req.contracts * inst.ctVal * px * this.takerFeeRate;
    return { ok: true, ordId: null, contracts: req.contracts, avgPx: px, feeUsd, ts: this.now() };
  }

  async orderByClientId(): Promise<null> {
    return null;
  }

  async positions(): Promise<null> {
    return null;
  }
  async fundingBills(): Promise<null> {
    return null;
  }
  async feesFor(): Promise<null> {
    return null;
  }
  async protect(_bee: BeeId, req: ProtectiveStopReq): Promise<ProtectiveStopResult> {
    return { ok: true, algoId: null, triggerPx: req.triggerPx };
  }
  async cancelProtection(): Promise<boolean> {
    return true;
  }
  async externalClose(): Promise<null> {
    return null;
  }
  async protectionMatches(): Promise<boolean> {
    return true;
  }
  async accountEquity(): Promise<null> {
    return null;
  }
  async accountId(): Promise<null> {
    return null;
  }
  async accountInfo(): Promise<null> {
    return null;
  }
  async pendingOrders(): Promise<null> {
    return null;
  }
  async conditionalOrders(): Promise<null> {
    return null;
  }
}

type Row = Record<string, string>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * MODE=demo / live: market orders through the OKX Agent Trade Kit CLI, one profile per bee.
 * Isolated margin, net position mode, 2x leverage, reduceOnly on every close.
 */
export class OkxExecutor implements Executor {
  readonly kind = "okx" as const;
  private leverageSet = new Set<string>();

  constructor(
    private cli: OkxCli,
    private creds: Partial<Record<BeeId, OkxCreds>>,
    private demo: boolean,
    private instrument: (instId: string) => Instrument | undefined,
    private leverage: number,
  ) {}

  private run<T>(bee: BeeId, args: string[]): Promise<T> {
    const c = this.creds[bee];
    if (!c) throw new Error(`no OKX credentials for ${bee}`);
    return this.cli.run<T>({ args, bee, creds: c, demo: this.demo });
  }

  async init(bee: BeeId): Promise<void> {
    const [cfg] = await this.run<Row[]>(bee, ["account", "config"]);
    if (cfg?.posMode && cfg.posMode !== "net_mode") {
      log.info("setting net position mode", { bee });
      await this.run(bee, ["account", "set-position-mode", "--posMode", "net_mode"]);
    }
  }

  private async ensureLeverage(bee: BeeId, instId: string): Promise<void> {
    const key = `${bee}:${instId}`;
    if (this.leverageSet.has(key)) return;
    // /account/leverage-info 404s on EEA; set it and trust the positions read-back.
    await this.run(bee, ["futures", "leverage", "--instId", instId, "--lever", String(this.leverage), "--mgnMode", "isolated"]);
    this.leverageSet.add(key);
  }

  async market(bee: BeeId, req: OrderReq): Promise<OrderResult> {
    const inst = this.instrument(req.instId);
    if (!inst) return { ok: false, error: { code: "INST", message: "unknown instrument" }, state: "rejected" };
    try {
      if (!req.reduceOnly) await this.ensureLeverage(bee, req.instId);
      const args = ["futures", "place", "--instId", req.instId, "--side", req.side, "--ordType", "market", "--sz", formatSz(req.contracts, inst), "--tdMode", "isolated", "--clOrdId", req.clOrdId];
      if (req.reduceOnly) args.push("--reduceOnly");
      const [ack] = await this.run<Row[]>(bee, args);
      if (!ack || (ack.sCode && ack.sCode !== "0")) {
        return { ok: false, error: { code: ack?.sCode ?? "NOACK", message: ack?.sMsg ?? "no ack" }, state: "rejected" };
      }
      // Market orders fill at once; poll for the fill details. The order is already placed, so a transient
      // read error here (seen: 50004 on OKX demo) must not end the poll: keep trying before reporting "unknown".
      for (let i = 0; i < 12; i++) {
        let o: Row | undefined;
        try {
          [o] = await this.run<Row[]>(bee, ["futures", "get", "--instId", req.instId, "--clOrdId", req.clOrdId]);
        } catch (err) {
          log.warn("fill poll failed, retrying", { bee, err: safeError(err) });
          await sleep(Math.min(4000, 400 * 2 ** Math.min(i, 3)));
          continue;
        }
        if (o && (o.state === "filled" || ((o.state === "canceled" || o.state === "mmp_canceled") && Number(o.accFillSz) > 0))) {
          return { ok: true, ordId: o.ordId ?? ack.ordId ?? null, contracts: Number(o.accFillSz), avgPx: Number(o.avgPx), feeUsd: -Number(o.fee || 0), ts: Number(o.uTime || o.cTime || Date.now()) };
        }
        if (o && o.state === "canceled") return { ok: false, error: { code: "CANCELED", message: "order canceled unfilled" }, state: "rejected" };
        await sleep(300);
      }
      return { ok: false, error: { code: "UNCONFIRMED", message: "fill not confirmed; reconciliation will settle it" }, state: "unknown" };
    } catch (err) {
      return { ok: false, error: safeError(err), state: "unknown" };
    }
  }

  async positions(bee: BeeId): Promise<ExchangePosition[] | null> {
    try {
      const rows = await this.run<Row[]>(bee, ["futures", "positions"]);
      return rows.filter((r) => Number(r.pos) !== 0).map((r) => ({ instId: r.instId!, pos: Number(r.pos), avgPx: Number(r.avgPx) }));
    } catch (err) {
      log.warn("positions read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async fundingBills(bee: BeeId, after?: string): Promise<FundingBillPage | null> {
    try {
      const rows = await this.run<Row[]>(bee, ["account", "bills", "--instType", "FUTURES", "--limit", "100", ...(after ? ["--after", after] : [])]);
      // type 8 = funding fee
      return {
        items: rows.filter((r) => r.type === "8").map((r) => ({ billId: r.billId!, instId: r.instId || null, amountUsd: Number(r.balChg), ts: Number(r.ts) })),
        next: rows.length === 100 ? rows.at(-1)?.billId ?? null : null,
      };
    } catch (err) {
      log.warn("bills read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async feesFor(bee: BeeId, instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null> {
    try {
      const out = new Map<string, number>();
      for (const instId of instIds) {
        let after: string | undefined;
        for (;;) {
          const rows = await this.run<Row[]>(bee, ["futures", "fills", "--instId", instId, "--limit", "100", ...(after ? ["--after", after] : [])]);
          for (const r of rows) if (r.ordId && ordIds.has(r.ordId)) out.set(r.ordId, (out.get(r.ordId) ?? 0) - Number(r.fee || 0));
          if (out.size === ordIds.size || rows.length < 100) break;
          const next = rows.at(-1)?.tradeId;
          if (!next || next === after) break;
          after = next;
        }
      }
      return out;
    } catch (err) {
      log.warn("fills read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async orderByClientId(bee: BeeId, instId: string, clOrdId: string): Promise<OrderResult | null> {
    try {
      const [o] = await this.run<Row[]>(bee, ["futures", "get", "--instId", instId, "--clOrdId", clOrdId]);
      if (!o || o.state === "live" || o.state === "partially_filled") return null;
      if (o.state === "filled" || ((o.state === "canceled" || o.state === "mmp_canceled") && Number(o.accFillSz) > 0)) {
        return { ok: true, ordId: o.ordId ?? null, contracts: Number(o.accFillSz), avgPx: Number(o.avgPx), feeUsd: -Number(o.fee || 0), ts: Number(o.uTime || o.cTime || Date.now()) };
      }
      return { ok: false, error: { code: o.state === "canceled" ? "CANCELED" : "REJECTED", message: `order ${o.state ?? "not found"}` }, state: "rejected" };
    } catch (err) {
      log.warn("order recovery read failed", { bee, clOrdId, err: safeError(err) });
      return null;
    }
  }

  async protect(bee: BeeId, req: ProtectiveStopReq): Promise<ProtectiveStopResult> {
    const inst = this.instrument(req.instId);
    if (!inst) return { ok: false, error: { code: "INST", message: "unknown instrument" } };
    const trigger = formatStopPx(req.triggerPx, req.closeSide, inst);
    try {
      if (req.algoId) {
        const [ack] = await this.run<Row[]>(bee, [
          "futures", "algo", "amend", "--instId", req.instId, "--algoId", req.algoId,
          "--newSz", formatSz(req.contracts, inst), "--newSlTriggerPx", trigger, "--newSlOrdPx", "-1",
        ]);
        if (!ack || (ack.sCode && ack.sCode !== "0")) return { ok: false, error: { code: ack?.sCode ?? "NOACK", message: ack?.sMsg ?? "no protection amend ack" } };
        return { ok: true, algoId: req.algoId, triggerPx: Number(trigger) };
      }
      const [ack] = await this.run<Row[]>(bee, [
        "futures", "algo", "place", "--instId", req.instId, "--side", req.closeSide, "--sz", formatSz(req.contracts, inst),
        "--ordType", "conditional", "--slTriggerPx", trigger, "--slOrdPx", "-1", "--slTriggerPxType", "mark",
        "--posSide", "net", "--tdMode", "isolated", "--reduceOnly", "--cxlOnClosePos",
      ]);
      if (!ack || (ack.sCode && ack.sCode !== "0") || !ack.algoId) return { ok: false, error: { code: ack?.sCode ?? "NOACK", message: ack?.sMsg ?? "no protection algo id" } };
      return { ok: true, algoId: ack.algoId, triggerPx: Number(trigger) };
    } catch (err) {
      return { ok: false, error: safeError(err) };
    }
  }

  async cancelProtection(bee: BeeId, instId: string, algoId: string): Promise<boolean> {
    try {
      const [ack] = await this.run<Row[]>(bee, ["futures", "algo", "cancel", "--instId", instId, "--algoId", algoId]);
      return !!ack && (!ack.sCode || ack.sCode === "0");
    } catch (err) {
      log.warn("protective stop cancel failed", { bee, err: safeError(err) });
      return false;
    }
  }

  async externalClose(bee: BeeId, instId: string, closeSide: "buy" | "sell", since: number, contracts: number, excludedOrdIds = new Set<string>()): Promise<ExternalClose | null> {
    try {
      const rows = await this.run<Row[]>(bee, ["futures", "fills", "--instId", instId]);
      const fills = rows
        .filter((r) => r.side === closeSide && !excludedOrdIds.has(r.ordId ?? "") && Number(r.ts) >= since && Number(r.fillSz || r.sz) > 0 && Number(r.fillPx || r.px) > 0)
        .sort((a, b) => Number(b.ts) - Number(a.ts));
      let remaining = contracts;
      let qty = 0;
      let value = 0;
      let fee = 0;
      let ts = 0;
      let ordId: string | null = null;
      for (const row of fills) {
        const take = Math.min(remaining, Number(row.fillSz || row.sz));
        qty += take;
        value += take * Number(row.fillPx || row.px);
        fee += -Number(row.fee || 0) * (take / Number(row.fillSz || row.sz));
        ts = Math.max(ts, Number(row.ts));
        ordId ??= row.ordId || null;
        remaining -= take;
        if (remaining <= 1e-9) break;
      }
      return qty >= contracts - 1e-9 ? { ordId, avgPx: value / qty, feeUsd: fee, ts } : null;
    } catch (err) {
      log.warn("external close fill read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async protectionMatches(bee: BeeId, req: ProtectiveStopReq & { algoId: string }): Promise<boolean> {
    try {
      const inst = this.instrument(req.instId);
      if (!inst) return false;
      const trigger = Number(formatStopPx(req.triggerPx, req.closeSide, inst));
      const rows = await this.run<Row[]>(bee, ["futures", "algo", "orders", "--instId", req.instId, "--ordType", "conditional"]);
      return rows.some((r) => r.algoId === req.algoId && (!r.state || r.state === "live") && r.side === req.closeSide && Math.abs(Number(r.sz) - req.contracts) < 1e-9 && Number(r.slTriggerPx) === trigger && /^(true|1)$/i.test(r.reduceOnly ?? ""));
    } catch (err) {
      log.warn("protective stop verification failed", { bee, err: safeError(err) });
      return false;
    }
  }

  async accountEquity(bee: BeeId): Promise<number | null> {
    try {
      const [balance] = await this.run<Array<{ details?: Row[] }>>(bee, ["account", "balance", "USDC"]);
      const usdc = balance?.details?.find((r) => r.ccy === "USDC");
      const equity = Number(usdc?.eq);
      return Number.isFinite(equity) ? equity : null;
    } catch (err) {
      log.warn("account equity read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async accountInfo(bee: BeeId): Promise<AccountInfo | null> {
    try {
      const [cfg] = await this.run<Row[]>(bee, ["account", "config"]);
      if (!cfg?.uid || !cfg.mainUid) return null;
      return {
        uid: cfg.uid,
        mainUid: cfg.mainUid,
        permissions: (cfg.perm ?? "").split(",").map((permission) => permission.trim().toLowerCase()).filter(Boolean),
        ipBound: (cfg.ip ?? "").split(",").some((ip) => ip.trim() !== ""),
      };
    } catch (err) {
      log.warn("account config read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async accountId(bee: BeeId): Promise<string | null> {
    try {
      const [cfg] = await this.run<Row[]>(bee, ["account", "config"]);
      return cfg?.uid || null;
    } catch (err) {
      log.warn("account id read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async pendingOrders(bee: BeeId): Promise<unknown[] | null> {
    try {
      return await this.run<Row[]>(bee, ["futures", "orders"]);
    } catch (err) {
      log.warn("pending orders read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async conditionalOrders(bee: BeeId): Promise<unknown[] | null> {
    try {
      return await this.run<Row[]>(bee, ["futures", "algo", "orders", "--ordType", "conditional"]);
    } catch (err) {
      log.warn("conditional orders read failed", { bee, err: safeError(err) });
      return null;
    }
  }
}

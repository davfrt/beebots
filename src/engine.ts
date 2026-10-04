import { customBrain } from "./bees/custom.js";
import { backupHealth } from "./backup.js";
import { BRAINS } from "./bees/index.js";
import { maxNotionalUsd, minutesSince, positionNotional, profitLockStop } from "./bees/common.js";
import { coinOf, type Action, type BeeBrain, type BeeContext, type BeeState, type Position, type Side } from "./bees/types.js";
import { BEES, type BeeId, type Config, type SlotProfile } from "./config.js";
import type { Alerts } from "./alerts.js";
import type { Db, StoredOrder } from "./db.js";
import type { EventBus } from "./events.js";
import type { Executor, OrderResult } from "./exec/executor.js";
import { contractsFor, formatStopPx, roundToLot } from "./exec/sizing.js";
import type { Jev, JevAnswer, JevResult } from "./jev.js";
import { applyFill, applyFunding, freshBee, mark, rollDay, sizedRiskUsd } from "./ledger.js";
import { log } from "./log.js";
import type { MarketFeed } from "./market/data.js";
import { safeError } from "./redact.js";
import { applyRisk, applySafetyRisk, type JevStatus, type Proposal } from "./risk.js";
import { buildSnapshot } from "./snapshot.js";

const FUNDING_HOURS_UTC = [0, 8, 16];
const RECON_MS = 5 * 60_000;
/** How often a benched bee gets a live P&L row in the stream. */
const PULSE_MS = 4_000;
/** How long a bee opens nothing after the exchange rejects one of its new orders. */
export const ORDER_REJECT_PAUSE_MS = 10 * 60_000;
const EQUITY_SNAPSHOT_MS = 10_000;

export interface EngineDeps {
  cfg: Config;
  db: Db;
  feed: MarketFeed;
  jev: Jev;
  exec: Executor;
  bus: EventBus;
  alerts: Alerts;
  now?: () => number;
  /** True once someone asked to end the experiment (deploy/close.sh drops a flag file in the data volume). */
  closeRequested?: () => boolean;
  /** Dry run only: consume a one-shot "resume last position" request (flag file). */
  takeResumeRequest?: () => boolean;
  /** A pool may retire a slot: it manages its position but may not add/open another one. */
  entriesAllowed?: (id: BeeId) => boolean;
  /** Combined daily loss breaker for this engine's slots. Omit for paper pools. */
  portfolioLossStopPct?: number;
  ids?: readonly BeeId[];
  /** False when another engine sharing the same feed owns refresh scheduling. */
  manageFeed?: boolean;
}

interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
  /** The rules made the call (one legal move, a hold); Jev was not asked. */
  required?: boolean;
}

/** Move a stop only in the position's favour. */
function ratchetStop(p: Position, cand: number): void {
  if (p.stopPx === null) p.stopPx = cand;
  else p.stopPx = p.side === "long" ? Math.max(p.stopPx, cand) : Math.min(p.stopPx, cand);
}

/** The answer when the menu leaves one legal hold: no Jev call, no cost. */
function requiredAnswer(label: string): JevAnswer {
  return { ok: true, choice: label, probabilities: { [label]: 1 }, confidence: 1, conviction: 0, convictionRaw: 0, inputTokens: 0, costUsd: 0, latencyMs: 0, model: "rules" };
}

export class Engine {
  readonly bees = {} as Record<BeeId, BeeState>;
  private last = {} as Partial<Record<BeeId, LastDecision>>;
  private orderPauseUntil = {} as Partial<Record<BeeId, number>>;
  private now: () => number;
  private ticking = false;
  private stopped = false;
  private refreshing = false;
  private timers: NodeJS.Timeout[] = [];
  private lastEquityAt = 0;
  private lastReconAt = 0;
  private lastSafetyAt = 0;
  private lastExchangeReadAt = 0;
  private dbWritable = true;
  private lastFundingSlot: number;
  private seq = 0;
  private jevDownAlerted = false;
  private recon: { ok: boolean | null; detail: string; ts: number } = { ok: null, detail: "not run yet", ts: 0 };
  private liveStartedAt: number | null = null;
  private lastPulseAt: Partial<Record<BeeId, number>> = {};
  private lastChipUsd: Partial<Record<BeeId, number>> = {};
  startedAt: number;
  private experimentStartedAt = 0;
  /** Experiment closed: no Jev calls, no new positions; open positions are closed, then the engine only marks and reconciles. */
  private closedAt: number | null = null;
  private closeRetryAt: Partial<Record<BeeId, number>> = {};
  private closeProven: Partial<Record<BeeId, boolean>> = {};
  private closeAnnounced = false;
  private ids: readonly BeeId[];
  private lastDecisionAt = 0;
  private portfolioDay = "";
  private portfolioDayStartUsd = 0;
  private portfolioTrippedAt: number | null = null;
  private protectionVerified = new Set<BeeId>();
  private lastBackupIssue: string | null | undefined;

  constructor(private d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    this.lastFundingSlot = fundingSlot(this.startedAt);
    this.ids = d.ids ?? BEES;
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const { cfg, db } = this.d;
    const storedMode = db.getMeta("mode");
    if (storedMode && storedMode !== cfg.mode) {
      throw new Error(`This database was used for MODE=${storedMode}. Point DB_PATH at a separate file for MODE=${cfg.mode}.`);
    }
    db.setMeta("mode", cfg.mode);
    if (cfg.mode === "live") {
      const s = db.getMeta("live_started_at");
      this.liveStartedAt = s ? Number(s) : this.now();
      if (!s) db.setMeta("live_started_at", String(this.liveStartedAt));
    }
    if (!db.getMeta("funding_since")) db.setMeta("funding_since", String(this.now()));
    if (!db.getMeta("experiment_started_at")) db.setMeta("experiment_started_at", String(this.now()));
    this.experimentStartedAt = Number(db.getMeta("experiment_started_at"));
    const closed = db.getMeta("experiment_closed_at");
    if (closed) {
      this.closedAt = Number(closed);
      this.closeAnnounced = db.getMeta("experiment_flat_at") !== null;
    }

    for (const id of this.ids) {
      this.bees[id] = db.loadBee(id) ?? freshBee(id, cfg.risk.startEquityUsd, this.now());
      await this.d.exec.init(id);
    }
    this.restorePortfolioBreaker();

    if (this.d.manageFeed !== false) await this.refreshMarket();
    if (this.d.exec.kind === "okx") {
      await this.reconcile();
      for (const id of this.ids) {
        if (this.bees[id].position && !(await this.syncProtection(id)) && !(await this.forceProtectionClose(id, this.now()))) {
          throw new Error(`${id} has an unprotected position that could not be closed`);
        }
      }
    }

    if (cfg.mode === "live" && (!cfg.alertWebhookUrl || !cfg.deadManUrl || !(await this.d.alerts.send("live engine startup test")))) throw new Error("live alert startup test failed");
    this.d.bus.emit("status", { event: "engine_start", mode: cfg.mode, tickMs: cfg.tickMs });
    void this.d.alerts.send(`engine started (MODE=${cfg.mode})`);

    this.loop(() => this.safetyTick(), cfg.safetyTickMs);
    if (this.d.manageFeed !== false) this.loop(() => this.refreshMarket(), cfg.dataRefreshMs);
    else if (this.d.exec.kind === "okx") this.loop(() => this.pollFunding(), cfg.dataRefreshMs);
    this.timers.push(setInterval(() => this.d.bus.emit("heartbeat", {}), 15_000));
    this.timers.push(setInterval(() => this.d.db.pruneEvents(this.now() - 3 * 86_400_000), 3_600_000));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    for (const id of this.ids) this.d.db.saveBee(this.bees[id], this.now());
  }

  async shutdown(deadlineMs = 10_000): Promise<void> {
    this.stopped = true;
    this.stop();
    const deadline = Date.now() + deadlineMs;
    while ((this.ticking || this.refreshing) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (this.ticking || this.refreshing) {
      // The submitted order row is the durable recovery record for interrupted exchange work.
      log.warn("engine shutdown deadline expired; recovery will resolve in-flight exchange work");
    }
    for (const id of this.ids) this.d.db.saveBee(this.bees[id], this.now());
  }

  private loop(fn: () => Promise<void>, everyMs: number) {
    const slot = this.timers.length;
    const run = async () => {
      const t0 = this.now();
      try {
        await fn();
      } catch (err) {
        log.error("loop error", { err: safeError(err) });
      }
      if (!this.stopped) this.timers[slot] = setTimeout(run, Math.max(0, everyMs - (this.now() - t0)));
    };
    this.timers[slot] = setTimeout(run, everyMs);
  }

  async refreshMarket(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.d.feed.refresh(this.now());
      this.rankBoozyHourly();
      if (this.d.exec.kind === "okx") await this.pollFunding();
    } catch (err) {
      log.warn("market refresh failed", { err: safeError(err) });
    } finally {
      this.refreshing = false;
    }
  }

  // ---------- the tick ----------

  async tick(): Promise<void> {
    await this.cycle(true);
  }

  async safetyTick(): Promise<void> {
    await this.cycle(false);
  }

  private async cycle(forceDecision: boolean): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      let tickersFresh = true;
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        tickersFresh = false;
        log.warn("ticker refresh failed", { err: safeError(err) });
      }
      const now = this.now();
      try {
        this.d.db.healthProbe(now);
        this.dbWritable = true;
      } catch (err) {
        this.dbWritable = false;
        log.error("database health write failed", { err: safeError(err) });
        return;
      }
      this.monitorBackup(now);
      for (const id of this.ids) this.markBee(id, now);
      if (this.d.feed.lastRefreshAt === 0) return; // no market data yet
      if (this.d.exec.kind === "sim") this.simulateFunding(now);

      this.updatePortfolioBreaker(now);
      let safetyFailed = false;
      const safetyResults = await Promise.all(this.ids.map((id) => this.runSafety(id, now).catch((err) => {
        safetyFailed = true;
        log.error("safety check failed", { bee: id, err: safeError(err) });
        return false;
      })));
      const safetyActed = new Set(this.ids.filter((_, i) => safetyResults[i]));
      if (this.d.exec.kind === "okx") {
        for (const id of this.ids.filter((x) => !safetyActed.has(x))) {
          if (!(await this.syncProtection(id))) await this.forceProtectionClose(id, now);
        }
      }

      if (this.stopped) return;
      if (this.closedAt === null && this.d.closeRequested?.()) this.beginClose(now);
      if (this.closedAt === null && this.d.takeResumeRequest?.()) await this.resumeLast(now);
      if (this.closedAt !== null) await this.windDown(now);
      else if (forceDecision || now - this.lastDecisionAt >= this.d.cfg.tickMs) {
        this.lastDecisionAt = now;
        await Promise.all(this.ids.filter((id) => !safetyActed.has(id)).map((id) => this.decide(id, now).catch((err) => log.error("decision failed", { bee: id, err: safeError(err) }))));
      }

      if (now - this.lastEquityAt >= EQUITY_SNAPSHOT_MS) {
        this.lastEquityAt = now;
        for (const id of this.ids) {
          const b = this.bees[id];
          this.d.db.insertEquity(id, now, b.equityUsd, b.cashUsd, b.uplUsd);
        }
      }
      this.d.bus.emit("equity", { bees: this.ids.map((id) => this.publicBee(id)) }, now);
      if (this.d.exec.kind === "okx" && now - this.lastReconAt >= RECON_MS) await this.reconcile();
      this.checkJevOutage(now);
      if (tickersFresh && !safetyFailed) {
        this.lastSafetyAt = now;
        if (this.d.cfg.mode === "live") void this.d.alerts.heartbeat(now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Serialize an external roster/handoff mutation against decisions and safety checks. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 10));
    this.ticking = true;
    try {
      return await fn();
    } finally {
      this.ticking = false;
    }
  }

  private async runSafety(id: BeeId, now: number): Promise<boolean> {
    const bee = this.bees[id];
    const risk = applySafetyRisk(this.ctx(id, now), this.brain(id));
    bee.cap = risk.cap;
    if (risk.capTripped) {
      this.d.db.insertCap(id, now, risk.capTripped, risk.status);
      this.d.bus.emit("cap", { bee: id, cap: risk.capTripped, detail: risk.status }, now);
    }
    const portfolioClose = this.portfolioTrippedAt !== null && !!bee.position;
    if (risk.action.kind !== "close" && !portfolioClose) return false;
    const action: Action = portfolioClose ? { kind: "close", reason: "portfolio_loss_stop" } : risk.action;
    const status = portfolioClose ? "combined portfolio daily loss stop" : risk.status;
    const decisionId = this.d.db.insertDecision({
      bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null,
      confidence: null, conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
      action, vetoedBy: null, forcedBy: portfolioClose ? "portfolio_loss_stop" : risk.forcedBy, status,
    });
    this.d.bus.emit("decision", {
      bee: id, choice: null, probabilities: [], confidence: null, conviction: null, latencyMs: null, tokens: null,
      jevUsd: 0, action: describeAction(action), vetoedBy: null, forcedBy: portfolioClose ? "portfolio_loss_stop" : risk.forcedBy,
      status, jev: "safety",
    }, now);
    await this.execute(id, action, decisionId, this.ctx(id, now), 0);
    this.d.db.saveBee(bee, now);
    return true;
  }

  private ctx(id: BeeId, now: number): BeeContext {
    const bee = this.bees[id];
    const p = bee.position;
    return {
      bee,
      view: this.d.feed.view(),
      cfg: this.d.cfg,
      knobs: this.knobs(id),
      now,
      uplR: p && p.riskUsd > 0 ? bee.uplUsd / p.riskUsd : null,
    };
  }

  private markBee(id: BeeId, now: number) {
    const bee = this.bees[id];
    const view = this.d.feed.view();
    const p = bee.position;
    const t = p ? view.tickers.get(p.instId) : undefined;
    const ctVal = p ? view.instruments.get(p.instId)?.ctVal : undefined;
    mark(bee, t?.mid, ctVal);
    // Positions opened before initialStopPx existed: their stop has never trailed past entry, so it is the entry stop.
    // Re-size R once from it (R used to stay at the first fill's risk after adds).
    if (p && p.initialStopPx === undefined && p.stopPx !== null && ctVal) {
      const lossSide = p.side === "long" ? p.stopPx < p.entryPx : p.stopPx > p.entryPx;
      p.initialStopPx = lossSide ? p.stopPx : null;
      if (lossSide) p.riskUsd = sizedRiskUsd(p.contracts, ctVal, p.entryPx, p.stopPx);
    }
    if (rollDay(bee, now)) {
      this.d.bus.emit("cap", { bee: id, cap: null, detail: "new UTC day: counters and caps reset" }, now);
    }
    // Trailing stop: only ever ratchets in the position's favour.
    const brain = this.brain(id);
    if (p && brain.trail) {
      const cand = brain.trail(this.ctx(id, now));
      if (cand !== null && Number.isFinite(cand)) ratchetStop(p, cand);
    }
    // Profit lock: track the best price since entry; past a rung the stop keeps part of that move.
    if (p && brain.profitLock && t?.mid) {
      const better = p.peakPx == null || (p.side === "long" ? t.mid > p.peakPx : t.mid < p.peakPx);
      if (better) p.peakPx = t.mid;
      const cand = profitLockStop(p.side, p.entryPx, p.peakPx!, brain.profitLock);
      if (cand !== null && Number.isFinite(cand)) ratchetStop(p, cand);
    }
  }

  private async decide(id: BeeId, now: number): Promise<void> {
    const { cfg, db, bus, jev } = this.d;
    const brain = this.brain(id);
    const bee = this.bees[id];
    if (!this.entriesAllowed(id) && !bee.position) return;
    // Benched (trade cap or fee budget): the bee rides whatever it holds. Jev is not asked, because nothing it
    // chose could be acted on; only code can close the position (stop, time stop, loss stop) until 00:00 UTC.
    if (bee.cap === "trade_cap" || bee.cap === "fee_budget") return this.decideBenched(id, now);
    const ctx = this.ctx(id, now);
    const menu = brain.menu(ctx);
    const snap = buildSnapshot(brain, ctx);
    if (brain.id === "boozy" && bee.top1.coin) snap.state.top1 = `${bee.top1.coin} x${bee.top1.streak}`;

    let jevStatus: JevStatus = "ok";
    let r: JevResult | null = null;
    // One legal move and it is "keep what you hold" (a Momentum bee inside its 24h lock): asking Jev buys nothing, so
    // the rules make the call. Only for a hold: a lone open or close still goes to Jev.
    const labels = Object.keys(menu);
    const required = labels.length === 1 && menu[labels[0]!]!.intent.kind === "hold";
    if (jev.capTripped) jevStatus = "daily_cap";
    else if (labels.length === 0) jevStatus = "no_options";
    else if (required) r = requiredAnswer(labels[0]!);
    else {
      r = await jev.decide({ strategy: brain.strategy, state: snap.state, menu, convictionLabels: brain.convictionLabels });
      if (!r.ok) jevStatus = r.reason === "daily_cap" ? "daily_cap" : "unreachable";
    }
    const proposal: Proposal | null =
      r && r.ok ? { label: r.choice, intent: menu[r.choice]!.intent, prob: r.probabilities[r.choice] ?? 0, conviction: r.conviction } : null;

    let risk = applyRisk({
      ctx,
      brain,
      proposal,
      jev: jevStatus,
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * cfg.dataRefreshMs + 30_000,
    });
    if (!this.entriesAllowed(id) && (risk.action.kind === "open" || risk.action.kind === "add" || risk.action.kind === "switch")) {
      risk = risk.action.kind === "switch"
        ? { ...risk, action: { kind: "close", reason: "slot_retiring" }, vetoedBy: "slot_retiring", status: "retiring slot: close without reopening" }
        : { ...risk, action: { kind: "none" }, vetoedBy: "slot_retiring", status: "retiring slot: no new exposure" };
    }
    if (this.d.exec.kind === "okx" && this.recon.ok !== true && (risk.action.kind === "open" || risk.action.kind === "add" || risk.action.kind === "switch")) {
      risk = { ...risk, action: { kind: "none" }, vetoedBy: "exchange_unreconciled", status: `exchange unreconciled: ${this.recon.detail}` };
    }

    if (risk.capTripped) {
      const detail = risk.status;
      db.insertCap(id, now, risk.capTripped, detail);
      bus.emit("cap", { bee: id, cap: risk.capTripped, detail }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    bee.cap = risk.cap;
    // A rules-only hold that the risk layer left alone (a stop or cap still overrides it and shows as usual).
    const ruled = required && risk.action.kind === "none" && !risk.forcedBy;
    const status = ruled ? `${labels[0]}: required by rules, Jev not asked` : risk.status;

    // Hard rule 10: recorded before it is acted on.
    const costUsd = r && r.ok ? r.costUsd : 0;
    const decisionId = db.insertDecision({
      bee: id,
      ts: now,
      stateHash: snap.hash,
      stateJson: JSON.stringify(snap.state),
      menuJson: JSON.stringify(Object.keys(menu)),
      choice: r && r.ok ? r.choice : null,
      probabilities: r && r.ok ? r.probabilities : null,
      confidence: r && r.ok ? r.confidence : null,
      conviction: r && r.ok ? r.convictionRaw : null,
      latencyMs: r ? r.latencyMs : null,
      inputTokens: r && r.ok ? r.inputTokens : null,
      jevCostUsd: costUsd,
      jevError: r && !r.ok ? `${r.reason}${r.error ? `: ${r.error.code} ${r.error.message}` : ""}` : null,
      action: risk.action,
      vetoedBy: risk.vetoedBy,
      forcedBy: risk.forcedBy,
      status,
    });
    bee.totals.jevUsd += costUsd;
    bee.totals.decisions++;

    const top3 = r && r.ok ? (Object.entries(r.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3) as Array<[string, number]>) : [];
    this.last[id] = { choice: r && r.ok ? r.choice : null, top3: ruled ? [] : top3, confidence: r && r.ok && !ruled ? r.confidence : null, latencyMs: ruled ? null : r ? r.latencyMs : null, status, ts: now, ...(ruled ? { required: true } : {}) };
    // Flat and nothing to ask Jev (bizzy waiting for her breakout): a live "watching" row every PULSE_MS instead of a
    // "no call" row every tick, so the stream shows how close the trigger is.
    const watching = jevStatus === "no_options" && !bee.position && !!brain.idleStatus && risk.action.kind === "none";
    // Same for a rules-only hold: a row every PULSE_MS, not every tick.
    if ((watching || ruled) && now - (this.lastPulseAt[id] ?? 0) < PULSE_MS) {
      db.saveBee(bee, now);
      return;
    }
    if (watching || ruled) this.lastPulseAt[id] = now;
    bus.emit(
      "decision",
      {
        bee: id,
        choice: r && r.ok ? r.choice : watching ? "WATCHING" : null,
        ...(watching ? { watch: risk.status } : {}),
        probabilities: ruled ? [] : top3.map(([label, p]) => ({ label, p: Number(p.toFixed(3)) })),
        ...(ruled ? { required: true } : {}),
        confidence: r && r.ok && !ruled ? Number(r.confidence.toFixed(3)) : null,
        conviction: r && r.ok && !ruled ? brain.convictionLabels[r.conviction] : null,
        latencyMs: ruled ? null : r ? r.latencyMs : null,
        tokens: r && r.ok && !ruled ? r.inputTokens : null,
        jevUsd: Number(costUsd.toFixed(6)),
        action: describeAction(risk.action),
        vetoedBy: risk.vetoedBy,
        forcedBy: risk.forcedBy,
        status,
        jev: jevStatus,
        ...this.liveChip(id),
      },
      now,
    );

    if (risk.action.kind !== "none") await this.execute(id, risk.action, decisionId, ctx, proposal?.conviction ?? 0);
    db.saveBee(bee, now);
  }

  // ---------- benched: ride the position ----------

  private async decideBenched(id: BeeId, now: number): Promise<void> {
    const { db } = this.d;
    const bee = this.bees[id];
    const ctx = this.ctx(id, now);
    const risk = applyRisk({
      ctx,
      brain: this.brain(id),
      proposal: null,
      jev: "no_options",
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs + 30_000,
    });
    if (risk.capTripped) {
      db.insertCap(id, now, risk.capTripped, risk.status);
      this.d.bus.emit("cap", { bee: id, cap: risk.capTripped, detail: risk.status }, now);
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${risk.status}`);
    }
    bee.cap = risk.cap;
    const prev = this.last[id];
    this.last[id] = { choice: null, top3: prev?.top3 ?? [], confidence: null, latencyMs: null, status: risk.status, ts: now };
    if (risk.action.kind !== "none") {
      const decisionId = db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: risk.action, vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status,
      });
      this.d.bus.emit("decision", {
        bee: id, choice: null, probabilities: [], confidence: null, conviction: null, latencyMs: null, tokens: null,
        jevUsd: 0, action: describeAction(risk.action), vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status, jev: "no_options",
        ...this.liveChip(id),
      }, now);
      await this.execute(id, risk.action, decisionId, ctx, 0);
    } else if (now - (this.lastPulseAt[id] ?? 0) >= PULSE_MS) {
      // Keep benched bees in the stream: a live row with the position's P&L ticking, no Jev call behind it.
      this.lastPulseAt[id] = now;
      const p = bee.position;
      this.d.bus.emit("decision", {
        bee: id, choice: p ? `RIDING ${p.coin}` : "BENCHED", probabilities: [], confidence: null, conviction: null, latencyMs: null,
        tokens: null, jevUsd: 0, action: "hold", vetoedBy: null, forcedBy: null, status: risk.status, jev: "benched", pulse: true,
        ...this.liveChip(id),
      }, now);
    }
    db.saveBee(bee, now);
  }

  /** The bee's money right now, for the stream: open P&L (or total P&L when flat) and how it moved since its last row. */
  private liveChip(id: BeeId) {
    const b = this.bees[id];
    const p = b.position;
    const value = p ? b.uplUsd : b.equityUsd - this.d.cfg.risk.startEquityUsd;
    const prev = this.lastChipUsd[id];
    this.lastChipUsd[id] = value;
    return {
      live: {
        coin: p?.coin ?? null,
        side: p?.side ?? null,
        valueUsd: Number(value.toFixed(2)),
        kind: p ? "open" : "total",
        deltaUsd: prev === undefined ? 0 : Number((value - prev).toFixed(2)),
      },
    };
  }

  /**
   * DRY RUN ONLY, one-shot (flag file `resume-last-dry` in the data volume): a benched bee that is sitting flat
   * re-opens the last position it held (same coin, side and size, at today's price) and rides it. Not a trade
   * toward its cap. Refused outright in demo/live.
   */
  private async resumeLast(now: number): Promise<void> {
    if (this.d.cfg.mode !== "dry") return;
    for (const id of this.ids) {
      const bee = this.bees[id];
      if (bee.position || (bee.cap !== "trade_cap" && bee.cap !== "fee_budget")) continue;
      const last = this.d.db.raw
        .prepare(`SELECT inst_id AS instId, side, contracts FROM orders WHERE bee = ? AND reduce_only = 0 AND state = 'filled' ORDER BY id DESC LIMIT 1`)
        .get(id) as { instId: string; side: "buy" | "sell"; contracts: number } | undefined;
      if (!last) continue;
      const decisionId = this.d.db.insertDecision({
        bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
        conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
        action: { kind: "open", instId: last.instId, side: last.side === "buy" ? "long" : "short" }, vetoedBy: null, forcedBy: "resume_last",
        status: "benched: back into its last position to ride it",
      });
      const ok = await this.order(id, decisionId, last.instId, last.side, last.contracts, false, "resume_last");
      const p = (this.bees[id] as BeeState).position; // re-read: order() just filled it
      if (!ok || !p) continue;
      const ctx = this.ctx(id, this.now());
      const inst = ctx.view.instruments.get(last.instId);
      p.stopPx = this.brain(id).stopFor(last.instId, p.side, p.entryPx, ctx);
      p.initialStopPx = p.stopPx;
      const notional = inst ? positionNotional(p, p.entryPx, inst.ctVal) : 0;
      p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
      this.d.db.saveBee(bee, now);
      log.info("resumed last position", { bee: id, coin: p.coin, side: p.side });
    }
  }

  // ---------- closing the experiment ----------

  private beginClose(now: number) {
    this.closedAt = now;
    this.d.db.setMeta("experiment_closed_at", String(now));
    log.info("experiment close requested: closing every position, no more Jev calls");
    this.d.bus.emit("status", { event: "experiment_closing" }, now);
    this.d.alerts.send("experiment close requested: closing all positions");
  }

  /** Cancel exposure first, then close every exchange position and require an exchange-confirmed flat account. */
  private async windDown(now: number): Promise<void> {
    await Promise.all(
      this.ids.map(async (id) => {
        const bee = this.bees[id];
        if (this.d.exec.kind === "okx") {
          this.closeProven[id] = false;
          if (!(await this.d.exec.cancelPendingOrders?.(id)) || !(await this.d.exec.cancelConditionalOrders?.(id))) return;
          const positions = await this.d.exec.positions(id);
          if (positions === null) return;
          for (const p of positions) {
            const decisionId = this.d.db.insertDecision({
              bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
              conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
              action: { kind: "close", reason: "experiment_closed" }, vetoedBy: null, forcedBy: "experiment_closed", status: "emergency flatten: reduce-only close",
            });
            const outcome = await this.order(id, decisionId, p.instId, p.pos > 0 ? "sell" : "buy", Math.abs(p.pos), true, "emergency_flatten");
            if (outcome !== "complete") this.closeRetryAt[id] = now + 10_000;
          }
          const [proofPositions, orders, conditionals] = await Promise.all([this.d.exec.positions(id), this.d.exec.pendingOrders(id), this.d.exec.conditionalOrders(id)]);
          if (proofPositions === null || orders === null || conditionals === null || proofPositions.length || orders.length || conditionals.length) return;
          if (bee.position) await this.reconcile();
          this.closeProven[id] = true;
          return;
        }
        const p = bee.position;
        if (!p || now < (this.closeRetryAt[id] ?? 0)) return;
        const decisionId = this.d.db.insertDecision({
          bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null,
          conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
          action: { kind: "close", reason: "experiment_closed" }, vetoedBy: null, forcedBy: "experiment_closed", status: "experiment closed: closing position",
        });
        const outcome = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "experiment_close");
        if (outcome !== "complete") this.closeRetryAt[id] = now + 10_000;
        if (outcome === "partial") await this.syncProtection(id);
        this.d.db.saveBee(bee, now);
      }),
    ).catch((err) => log.error("close failed", { err: safeError(err) }));
    if (!this.closeAnnounced && (this.d.exec.kind === "okx" ? this.ids.every((id) => this.closeProven[id]) : this.ids.every((id) => !this.bees[id].position))) {
      this.closeAnnounced = true;
      this.d.db.setMeta("experiment_flat_at", String(now));
      this.lastReconAt = 0; // confirm flat against OKX on the next tick
      this.d.bus.emit("status", { event: "experiment_closed" }, now);
      this.d.alerts.send("experiment closed: every bee is flat");
    }
  }

  // ---------- execution ----------

  private async execute(id: BeeId, action: Action, decisionId: number, ctx: BeeContext, _conviction: number): Promise<void> {
    const bee = this.bees[id];
    const p = bee.position;
    switch (action.kind) {
      case "close":
        if (p) await this.closePosition(id, decisionId, action.reason);
        return;
      case "trim": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const n = inst ? roundToLot(p.contracts * action.fraction, inst) : 0;
        if (n > 0 && inst && n >= inst.minSz) {
          await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", n, true, "trim");
          await this.syncProtection(id);
        }
        else log.info("trim rounds to zero, skipped", { bee: id });
        return;
      }
      case "add": {
        if (!p) return;
        const inst = ctx.view.instruments.get(p.instId);
        const s = ctx.view.stats.get(p.instId);
        const n = inst && s ? contractsFor(action.notionalUsd, inst, s.mid) : 0;
        if (n > 0) {
          const outcome = await this.order(id, decisionId, p.instId, p.side === "long" ? "buy" : "sell", n, false, "add");
          const q = this.bees[id].position;
          // An add raises the average entry; don't let it turn the position into a loser: stop to at least the new average.
          if (outcome !== "failed" && q && this.brain(id).protectAdds) ratchetStop(q, q.entryPx);
          if (outcome !== "failed" && !(await this.enforceExposure(id, decisionId, "fill_excess"))) return;
          if (outcome !== "failed" && !(await this.syncProtection(id))) await this.forceProtectionClose(id, this.now());
        } else log.info("add rounds to zero contracts, skipped", { bee: id });
        return;
      }
      case "switch":
        if (p) {
          const ok = await this.closePosition(id, decisionId, "switch_close");
          if (!ok) return;
        }
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
      case "open":
        await this.openPosition(id, decisionId, action.instId, action.side, action.notionalUsd);
        return;
    }
  }

  private async openPosition(id: BeeId, decisionId: number, instId: string, side: Side, notionalUsd: number): Promise<void> {
    const view = this.d.feed.view();
    const inst = view.instruments.get(instId);
    const s = view.stats.get(instId);
    if (!inst || !s) return;
    const contracts = contractsFor(notionalUsd, inst, s.mid);
    if (contracts <= 0) {
      log.info("order rounds to zero contracts, skipped", { bee: id, coin: inst.coin, notionalUsd });
      return;
    }
    const outcome = await this.order(id, decisionId, instId, side === "long" ? "buy" : "sell", contracts, false, "open");
    const bee = this.bees[id];
    if (outcome === "failed" || !bee.position) return;
    const ctx = this.ctx(id, this.now());
    const p = bee.position;
    p.stopPx = this.brain(id).stopFor(instId, side, p.entryPx, ctx);
    p.initialStopPx = p.stopPx;
    const notional = positionNotional(p, p.entryPx, inst.ctVal);
    p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
    if (s.trend) p.entryScore = s.trend.score;
    if (!(await this.enforceExposure(id, decisionId, "fill_excess"))) return;
    if (!(await this.syncProtection(id))) await this.forceProtectionClose(id, this.now());
  }

  /** A gap can make a confirmed fill exceed the approved notional or initial-stop budget. */
  private async enforceExposure(id: BeeId, decisionId: number, purpose: string): Promise<boolean> {
    const p = this.bees[id].position;
    if (!p) return true;
    const ctx = this.ctx(id, this.now());
    const inst = ctx.view.instruments.get(p.instId);
    const stop = p.initialStopPx ?? p.stopPx;
    if (!inst || stop === null) return this.closePosition(id, decisionId, purpose);
    const lossPerContract = inst.ctVal * Math.abs(p.entryPx - stop);
    const byNotional = Math.floor(maxNotionalUsd(ctx) / (inst.ctVal * p.entryPx));
    const byRisk = lossPerContract > 0 ? Math.floor(ctx.cfg.risk.maxInitialStopLossUsd / lossPerContract) : 0;
    const safe = roundToLot(Math.min(byNotional, byRisk), inst);
    if (safe >= p.contracts) return true;
    if (safe < inst.minSz) return this.closePosition(id, decisionId, purpose);
    const outcome = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts - safe, true, purpose);
    const remaining = this.bees[id].position;
    return outcome !== "failed" && !!remaining && remaining.contracts <= safe || await this.closePosition(id, decisionId, purpose);
  }

  private async closePosition(id: BeeId, decisionId: number, purpose: string): Promise<boolean> {
    const p = this.bees[id].position;
    if (!p) return true;
    const protection = p.protection;
    const outcome = await this.order(id, decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, purpose);
    if (outcome !== "complete" || this.bees[id].position) {
      await this.syncProtection(id);
      return false;
    }
    if (purpose === "switch_close" && this.d.exec.kind === "okx") {
      await this.reconcile();
      if (!this.recon.ok || this.bees[id].position) return false;
    }
    if (protection?.algoId) await this.d.exec.cancelProtection(id, p.instId, protection.algoId);
    return true;
  }

  private async syncProtection(id: BeeId): Promise<boolean> {
    if (this.d.exec.kind !== "okx") return true;
    const p = this.bees[id].position;
    if (!p || p.stopPx === null) return !p;
    const inst = this.d.feed.view().instruments.get(p.instId);
    if (!inst) return false;
    const canonicalStop = Number(formatStopPx(p.stopPx, p.side === "long" ? "sell" : "buy", inst));
    if (p.protection && !this.protectionVerified.has(id)) {
      const matches = await this.d.exec.protectionMatches(id, {
        instId: p.instId,
        closeSide: p.side === "long" ? "sell" : "buy",
        contracts: p.contracts,
        triggerPx: canonicalStop,
        algoId: p.protection.algoId,
      });
      if (matches) this.protectionVerified.add(id);
      else {
        if (!(await this.d.exec.cancelProtection(id, p.instId, p.protection.algoId))) return false;
        p.protection = undefined;
      }
    }
    if (p.protection && p.protection.stopPx === canonicalStop && p.protection.contracts === p.contracts) return true;
    const res = await this.d.exec.protect(id, {
      instId: p.instId,
      closeSide: p.side === "long" ? "sell" : "buy",
      contracts: p.contracts,
      triggerPx: p.stopPx,
      ...(p.protection?.algoId ? { algoId: p.protection.algoId } : {}),
    });
    if (!res.ok || !res.algoId) {
      const detail = res.ok ? "OKX returned no protective algo id" : `${res.error.code} ${res.error.message}`;
      log.error("position is not protected at OKX", { bee: id, detail });
      this.d.alerts.send(`${this.d.cfg.slots[id].name}: native stop failed; closing position (${detail})`);
      return false;
    }
    p.protection = { algoId: res.algoId, stopPx: res.triggerPx, contracts: p.contracts };
    if (!(await this.d.exec.protectionMatches(id, { instId: p.instId, closeSide: p.side === "long" ? "sell" : "buy", contracts: p.contracts, triggerPx: canonicalStop, algoId: res.algoId }))) return false;
    this.protectionVerified.add(id);
    this.d.db.saveBee(this.bees[id], this.now());
    return true;
  }

  private async forceProtectionClose(id: BeeId, now: number): Promise<boolean> {
    const p = this.bees[id].position;
    if (!p) return true;
    this.d.bus.emit("status", { event: "critical", severity: "critical", bee: id, detail: "exchange protection failed; flattening position" }, now);
    this.d.alerts.send(`${this.d.cfg.slots[id].name}: critical protection failure; flattening position`);
    const decisionId = this.d.db.insertDecision({
      bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null,
      confidence: null, conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
      action: { kind: "close", reason: "native_stop_failed" }, vetoedBy: null, forcedBy: "native_stop_failed", status: "native stop failed: closing unprotected position",
    });
    const ok = await this.closePosition(id, decisionId, "native_stop_failed");
    this.d.db.saveBee(this.bees[id], now);
    return ok;
  }

  /** Record the order, send it, and apply confirmed quantity. */
  private async order(id: BeeId, decisionId: number, instId: string, side: "buy" | "sell", contracts: number, reduceOnly: boolean, purpose: string): Promise<"failed" | "partial" | "complete"> {
    const { db, bus, exec } = this.d;
    const now = this.now();
    if (this.stopped) return "failed";
    const inst = this.d.feed.view().instruments.get(instId);
    if (!inst) return "failed";
    // After the exchange rejects a new order, this bee opens nothing for ORDER_REJECT_PAUSE_MS (it used to resend
    // every tick). Closes (reduceOnly) are never paused: stops must always try.
    if (!reduceOnly && now < (this.orderPauseUntil[id] ?? 0)) {
      log.info("new orders paused after an exchange rejection", { bee: id, coin: inst.coin, purpose, untilS: Math.round(((this.orderPauseUntil[id] ?? 0) - now) / 1000) });
      return "failed";
    }
    if (!reduceOnly && db.hasUnresolvedExposureOrder(id)) {
      log.warn("new order blocked by unresolved exposure", { bee: id, purpose });
      return "failed";
    }
    const clOrdId = `${id.slice(0, 2)}${now.toString(36)}${(this.seq++ % 1296).toString(36).padStart(2, "0")}`;
    const orderId = db.insertOrder({ decisionId, bee: id, ts: now, clOrdId, instId, side, contracts, reduceOnly, purpose });
    bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, clOrdId, state: "sent" }, now);
    const ticker = this.d.feed.view().tickers.get(instId);
    const limitPx = !reduceOnly && ticker ? side === "buy" ? ticker.ask * 1.005 : ticker.bid * 0.995 : undefined;
    const res = await exec.market(id, { instId, side, contracts, reduceOnly, clOrdId, ...(limitPx ? { limitPx } : {}) });
    if (!res.ok) {
      db.updateOrder(orderId, res.state, null, `${res.error.code} ${res.error.message}`);
      bus.emit("order", { bee: id, coin: inst.coin, side, contracts, purpose, state: res.state, error: res.error });
      log.warn("order failed", { bee: id, coin: inst.coin, purpose, err: res.error });
      if (res.state === "unknown") this.lastReconAt = 0; // reconcile on the next tick
      if (!reduceOnly) {
        this.orderPauseUntil[id] = now + ORDER_REJECT_PAUSE_MS;
        this.d.alerts.send(`${this.d.cfg.slots[id].name}: ${inst.coin} ${purpose} order rejected (${res.error.code} ${res.error.message}); new orders paused ${ORDER_REJECT_PAUSE_MS / 60_000} min`);
      }
      return "failed";
    }
    return this.applyOrderFill({ id: orderId, bee: id, instId, side, contracts, reduceOnly, purpose }, res) ? (res.state === "partial" ? "partial" : "complete") : "failed";
  }

  private applyOrderFill(order: Pick<StoredOrder, "id" | "bee" | "instId" | "side" | "contracts" | "reduceOnly" | "purpose">, res: Extract<OrderResult, { ok: true }>): boolean {
    const inst = this.d.feed.view().instruments.get(order.instId);
    if (!inst || !Number.isFinite(res.contracts) || !(res.contracts > 0) || !Number.isFinite(res.avgPx) || !(res.avgPx > 0) || !Number.isFinite(res.feeUsd)) return false;
    const bee = this.bees[order.bee];
    const opening = !bee.position && !order.reduceOnly;
    const realised = applyFill(bee, { instId: order.instId, coin: inst.coin, side: order.side, contracts: res.contracts, px: res.avgPx, feeUsd: res.feeUsd, ctVal: inst.ctVal, ts: res.ts });
    if (opening && bee.position) {
      const p = bee.position;
      p.stopPx = this.brain(order.bee).stopFor(order.instId, p.side, p.entryPx, this.ctx(order.bee, res.ts));
      p.initialStopPx = p.stopPx;
      const notional = positionNotional(p, p.entryPx, inst.ctVal);
      p.riskUsd = p.stopPx !== null ? (notional * Math.abs(p.entryPx - p.stopPx)) / p.entryPx : notional * 0.01;
      if (order.purpose === "open") bee.tradesToday++;
    }
    const notionalUsd = res.contracts * inst.ctVal * res.avgPx;
    mark(bee, res.avgPx, inst.ctVal);
    const inserted = this.d.db.settleOrder(order.id, res.ordId, res.state === "partial" ? "partial" : "filled", { orderId: order.id, bee: order.bee, ts: res.ts, instId: order.instId, side: order.side, contracts: res.contracts, px: res.avgPx, notionalUsd, feeUsd: res.feeUsd, realisedUsd: realised }, bee);
    if (!inserted) return true;
    const dir = order.reduceOnly ? "CLOSE" : order.side === "buy" ? "LONG" : "SHORT";
    this.d.bus.emit("fill", { bee: order.bee, coin: inst.coin, side: order.side, purpose: order.purpose, contracts: res.contracts, px: res.avgPx, notionalUsd: Number(notionalUsd.toFixed(2)), feeUsd: Number(res.feeUsd.toFixed(4)), realisedUsd: Number(realised.toFixed(2)), label: `${this.d.cfg.slots[order.bee].name} ${dir} ${inst.coin} $${notionalUsd.toFixed(0)}` });
    return true;
  }

  // ---------- funding, reconciliation, ranks ----------

  /** MODE=dry: charge funding at 00/08/16 UTC using the current rate (long pays a positive rate). */
  private simulateFunding(now: number) {
    const slot = fundingSlot(now);
    if (slot === this.lastFundingSlot) return;
    this.lastFundingSlot = slot;
    const view = this.d.feed.view();
    for (const id of this.ids) {
      const bee = this.bees[id];
      const p = bee.position;
      const s = p ? view.stats.get(p.instId) : undefined;
      const inst = p ? view.instruments.get(p.instId) : undefined;
      if (!p || !s || !inst || s.fundingPct === null) continue;
      const amount = -(p.side === "long" ? 1 : -1) * (s.fundingPct / 100) * positionNotional(p, s.mid, inst.ctVal);
      if (this.d.db.insertFunding(id, now, p.instId, amount, `sim-${id}-${slot}`)) {
        applyFunding(bee, amount);
        this.d.bus.emit("funding", { bee: id, coin: p.coin, amountUsd: Number(amount.toFixed(4)) }, now);
      }
    }
  }

  /** MODE=demo/live: record funding bills (type 8) as their own ledger rows. */
  private async pollFunding() {
    for (const id of this.ids) {
      if (!(await this.recoverFunding(id))) throw new Error(`could not read OKX funding for ${id}`);
    }
  }

  /** Walk every page back to the durable cursor; a 100-row outage window must not discard older bills. */
  private async recoverFunding(id: BeeId): Promise<boolean> {
    const cursorKey = `funding_cursor_${id}`;
    const cursor = this.d.db.getMeta(cursorKey);
    const since = Number(this.d.db.getMeta("funding_since") ?? 0);
    const recovered = [] as import("./exec/executor.js").FundingBill[];
    let after: string | undefined;
    let newest: string | null = null;
    let reached = false;
    for (;;) {
      const page = await this.d.exec.fundingBills(id, after);
      if (page === null) return false;
      const items = Array.isArray(page) ? page : page.items;
      if (!newest && items[0]) newest = items[0].billId;
      recovered.push(...items);
      if (items.some((bill) => bill.billId === cursor) || (!cursor && items.every((bill) => bill.ts < since))) {
        reached = true;
        break;
      }
      const next = Array.isArray(page) ? null : page.next;
      if (!next) {
        if (!cursor) {
          reached = true;
          break;
        }
        return false;
      }
      if (next === after) return false;
      after = next;
    }
    if (!reached) return false;
    for (const bill of recovered.reverse()) {
      if (bill.ts < since) continue;
      if (this.d.db.insertFunding(id, bill.ts, bill.instId, bill.amountUsd, bill.billId)) {
        applyFunding(this.bees[id], bill.amountUsd);
        this.d.bus.emit("funding", { bee: id, coin: bill.instId?.split("-")[0] ?? null, amountUsd: bill.amountUsd }, bill.ts);
      }
    }
    if (newest) this.d.db.setMeta(cursorKey, newest);
    return true;
  }

  /** Every 5 min (demo/live): our position and fees vs OKX. On mismatch, adopt OKX's position and go red. */
  async reconcile(): Promise<void> {
    const now = this.now();
    if (this.stopped) return;
    this.lastReconAt = now;
    this.protectionVerified.clear();
    const view = this.d.feed.view();
    const diffs: string[] = [];
    for (const id of this.ids) {
      const bee = this.bees[id];
      if (!(await this.recoverOrders(id))) {
        diffs.push(`${this.d.cfg.slots[id].name}: unresolved submitted order`);
        continue;
      }
      const ex = await this.d.exec.positions(id);
      if (ex === null) {
        diffs.push(`${this.d.cfg.slots[id].name}: could not read OKX positions`);
        continue;
      }
      if (ex.length > 1) {
        const detail = `multiple OKX positions: ${ex.map((p) => `${p.pos} ${p.instId.split("-")[0]}`).join(", ")}`;
        this.d.db.insertRecon(id, now, false, { detail });
        diffs.push(`${this.d.cfg.slots[id].name}: ${detail}`);
        continue;
      }
      const pending = await this.d.exec.pendingOrders(id);
      if (pending === null) {
        diffs.push(`${this.d.cfg.slots[id].name}: could not read OKX pending orders`);
        continue;
      }
      if (pending.length) {
        const detail = `${pending.length} pending OKX order${pending.length === 1 ? "" : "s"}`;
        this.d.db.insertRecon(id, now, false, { detail });
        diffs.push(`${this.d.cfg.slots[id].name}: ${detail}`);
        continue;
      }
      if (!(await this.recoverFunding(id))) {
        diffs.push(`${this.d.cfg.slots[id].name}: could not read OKX funding`);
        continue;
      }
      const equity = await this.d.exec.accountEquity(id);
      if (equity === null || !Number.isFinite(equity)) {
        diffs.push(`${this.d.cfg.slots[id].name}: could not read OKX equity`);
        continue;
      }
      const theirs = ex[0];
      const ours = bee.position;
      const oursSigned = ours ? (ours.side === "long" ? 1 : -1) * ours.contracts : 0;
      const theirSigned = theirs?.pos ?? 0;
      const sameInst = (ours?.instId ?? null) === (theirs?.instId ?? null);
      const sameEntry = !ours || !theirs || Math.abs(ours.entryPx - theirs.avgPx) < 1e-8;
      let ok = sameInst && Math.abs(oursSigned - theirSigned) < 1e-9 && sameEntry && Math.abs(bee.equityUsd - equity) < 0.01;
      let detail = ok ? "match" : `ours ${ours ? `${ours.side} ${ours.contracts} ${ours.coin}` : "flat"} vs OKX ${theirs ? `${theirs.pos} ${theirs.instId.split("-")[0]}` : "flat"}`;
      if (!sameEntry) detail += `; average entry ours ${ours!.entryPx} vs OKX ${theirs!.avgPx}`;
      if (Math.abs(bee.equityUsd - equity) >= 0.01) detail += `; equity ours $${bee.equityUsd.toFixed(2)} vs OKX $${equity.toFixed(2)}`;

      // Fees to the cent on our recent filled orders.
      const rows = this.d.db.raw
        .prepare(`SELECT o.ord_id AS ordId, o.inst_id AS instId, f.fee_usd AS fee FROM orders o JOIN fills f ON f.order_id = o.id WHERE o.bee = ? AND o.ord_id IS NOT NULL ORDER BY o.id DESC LIMIT 50`)
        .all(id) as Array<{ ordId: string; instId: string; fee: number }>;
      const theirFees = await this.d.exec.feesFor(id, [...new Set(rows.map((r) => r.instId))], new Set(rows.map((r) => r.ordId)));
      if (theirFees) {
        if (rows.length) {
          const requested = new Set(rows.map((row) => row.ordId));
          if ([...requested].some((ordId) => !theirFees.has(ordId))) {
            ok = false;
            detail += "; incomplete OKX fee history";
          }
          const ourSum = rows.filter((r) => theirFees.has(r.ordId)).reduce((a, r) => a + r.fee, 0);
          const theirSum = [...theirFees.values()].reduce((a, b) => a + b, 0);
          if (Math.abs(ourSum - theirSum) >= 0.005) {
            ok = false;
            detail += `; fees ours $${ourSum.toFixed(2)} vs OKX $${theirSum.toFixed(2)}`;
          }
        }
      } else {
        ok = false;
        detail += "; could not read OKX fees";
      }

      const externalReduction = ours && theirs && sameInst && ours.side === (theirs.pos > 0 ? "long" : "short") && Math.abs(theirs.pos) < ours.contracts;
      if (externalReduction) {
        // Do not alter the ledger until the exchange fill supplies the actual fee and exit price.
        await this.importExternalClose(id, ours, now, ours.contracts - Math.abs(theirs.pos));
      } else if (!sameInst || Math.abs(oursSigned - theirSigned) >= 1e-9 || !sameEntry) {
        // OKX is the truth: rebuild the position from it.
        if (!theirs) {
          if (ours) await this.importExternalClose(id, ours, now);
          else bee.flatSince ??= now;
        } else {
          const inst = view.instruments.get(theirs.instId);
          const side: Side = theirs.pos > 0 ? "long" : "short";
          const keepStop = ours && sameInst && ours.side === side ? ours.stopPx : null;
          bee.position = {
            instId: theirs.instId,
            coin: theirs.instId.split("-")[0]!,
            side,
            contracts: Math.abs(theirs.pos),
            entryPx: theirs.avgPx,
            openedAt: ours?.openedAt ?? now,
            stopPx: keepStop ?? this.brain(id).stopFor(theirs.instId, side, theirs.avgPx, this.ctx(id, now)),
            riskUsd: ours?.riskUsd ?? (inst ? Math.abs(theirs.pos) * inst.ctVal * theirs.avgPx * 0.01 : 0),
          };
          const np = bee.position;
          np.initialStopPx = keepStop !== null && ours ? (ours.initialStopPx ?? ours.stopPx) : np.stopPx;
          np.peakPx = keepStop !== null && ours ? (ours.peakPx ?? null) : null;
          if (inst && np.initialStopPx !== null && np.initialStopPx !== undefined) np.riskUsd = sizedRiskUsd(np.contracts, inst.ctVal, np.entryPx, np.initialStopPx);
          bee.flatSince = null;
        }
      }
      this.d.db.saveBee(bee, now);
      this.d.db.insertRecon(id, now, ok, { detail });
      if (!ok) diffs.push(`${this.d.cfg.slots[id].name}: ${detail}`);
    }
    const ok = diffs.length === 0;
    const was = this.recon.ok;
    this.recon = { ok, detail: ok ? "books match OKX" : diffs.join(" | "), ts: now };
    if (ok) this.lastExchangeReadAt = now;
    this.d.db.setMeta("reconciliation_ready", ok ? "true" : "false");
    this.d.bus.emit("recon", { ok, detail: this.recon.detail }, now);
    if (!ok && was !== false) this.d.alerts.send(`reconciliation mismatch: ${this.recon.detail}`);
  }

  private async recoverOrders(id: BeeId): Promise<boolean> {
    for (const order of this.d.db.unresolvedOrders(id)) {
      const res = await this.d.exec.orderByClientId(id, order.instId, order.clOrdId, order.contracts);
      if (res === null || (!res.ok && res.state === "unknown")) return false;
      if (!res.ok) {
        this.d.db.updateOrder(order.id, "rejected", null, `${res.error.code} ${res.error.message}`);
        continue;
      }
      if (!this.applyOrderFill(order, res)) return false;
    }
    return true;
  }

  /** Momentum bees: who is #1 on the hourly rank, and for how many ranks in a row. */
  private rankBoozyHourly() {
    const now = this.now();
    for (const id of this.ids) {
      if (this.d.cfg.slots[id].style !== "boozy") continue;
      const bee = this.bees[id];
      if (Math.floor(now / 3_600_000) === Math.floor(bee.top1.rankedAt / 3_600_000)) continue;
      // Each Momentum bee's own ranking: a coin-restricted bee only ranks its own coins.
      const topId = this.brain(id).universe(this.ctx(id, now))[0];
      if (!topId) continue;
      const coin = coinOf(topId);
      bee.top1 = { coin, streak: coin === bee.top1.coin ? bee.top1.streak + 1 : 1, rankedAt: now };
    }
  }

  private brains = {} as Record<BeeId, BeeBrain>;

  setProfile(id: BeeId, profile: SlotProfile, restore = false): void {
    if (!this.ids.includes(id)) throw new Error(`${id} is not in this engine`);
    if (!restore && this.bees[id]?.position) throw new Error(`${id} must be flat before changing strategy`);
    this.d.cfg.slots[id] = profile;
    delete this.brains[id];
  }

  /** Bring a native stop/manual exchange close into the local ledger instead of silently dropping its P&L. */
  private async importExternalClose(id: BeeId, p: Position, now: number, contracts = p.contracts): Promise<boolean> {
    const inst = this.d.feed.view().instruments.get(p.instId);
    if (!inst) {
      this.bees[id].position = null;
      this.bees[id].flatSince = now;
      return false;
    }
    const side = p.side === "long" ? "sell" : "buy";
    const recorded = this.d.db.raw
      .prepare(`SELECT ord_id AS ordId FROM orders WHERE bee = ? AND inst_id = ? AND ord_id IS NOT NULL AND ts <= COALESCE((SELECT updated_ts FROM bee_state WHERE bee = ?), 0)`)
      .all(id, p.instId, id) as Array<{ ordId: string }>;
    const fill = await this.d.exec.externalClose(id, p.instId, side, p.openedAt, contracts, new Set(recorded.map((r) => r.ordId)));
    if (!fill) return false;
    const { avgPx: px, feeUsd, ts } = fill;
    const decisionId = this.d.db.insertDecision({
      bee: id, ts, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null,
      confidence: null, conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
      action: { kind: "close", reason: "exchange_reconcile" }, vetoedBy: null, forcedBy: "exchange_reconcile", status: "exchange close imported",
    });
    const clOrdId = `rx${ts.toString(36)}${(this.seq++ % 1296).toString(36).padStart(2, "0")}`;
    const orderId = this.d.db.insertOrder({ decisionId, bee: id, ts, clOrdId, instId: p.instId, side, contracts: p.contracts, reduceOnly: true, purpose: "exchange_reconcile" });
    this.d.db.updateOrder(orderId, "filled", fill.ordId, null);
    const realised = applyFill(this.bees[id], { instId: p.instId, coin: p.coin, side, contracts, px, feeUsd, ctVal: inst.ctVal, ts });
    this.d.db.insertFill({ orderId, bee: id, ts, instId: p.instId, side, contracts, px, notionalUsd: contracts * inst.ctVal * px, feeUsd, realisedUsd: realised });
    mark(this.bees[id], px, inst.ctVal);
    this.d.bus.emit("fill", { bee: id, coin: p.coin, side, purpose: "exchange_reconcile", contracts, px, notionalUsd: contracts * inst.ctVal * px, feeUsd, realisedUsd: realised, label: `${this.d.cfg.slots[id].name} EXCHANGE CLOSE ${p.coin}` }, ts);
    return true;
  }

  profile(id: BeeId): SlotProfile {
    return this.d.cfg.slots[id];
  }

  slotIds(): readonly BeeId[] {
    return this.ids;
  }

  isFlat(id: BeeId): boolean {
    return !this.bees[id].position;
  }

  positionOpenedAt(id: BeeId): number | null {
    return this.bees[id].position?.openedAt ?? null;
  }

  lastDayReturn(id: BeeId, day: string): number | null {
    const b = this.bees[id];
    if (b.lastDayKey === day) return b.lastDayReturnPct ?? null;
    if (b.dayKey === day && b.dayStartEquityUsd > 0) return ((b.equityUsd - b.dayStartEquityUsd) / b.dayStartEquityUsd) * 100;
    return null;
  }

  /** Close/reset a paper slot so every daily runner starts with equal capital. */
  async replacePaperProfile(id: BeeId, profile: SlotProfile, now = this.now()): Promise<void> {
    if (this.d.exec.kind !== "sim") throw new Error("paper profile reset requires the simulator");
    if (this.bees[id].position && !(await this.closeNow(id, "daily_roster_reset", now)).ok) throw new Error(`${id} could not close for its daily roster reset`);
    this.bees[id] = freshBee(id, this.d.cfg.risk.startEquityUsd, now);
    this.setProfile(id, profile);
    this.d.db.saveBee(this.bees[id], now);
  }

  async closeNow(id: BeeId, reason: string, now = this.now()): Promise<{ ok: boolean; costPct: number }> {
    if (!this.bees[id].position) return { ok: true, costPct: 0 };
    this.markBee(id, now);
    const before = this.bees[id].equityUsd;
    const decisionId = this.d.db.insertDecision({
      bee: id, ts: now, stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null,
      confidence: null, conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null,
      action: { kind: "close", reason }, vetoedBy: null, forcedBy: reason, status: reason,
    });
    const ok = await this.closePosition(id, decisionId, reason);
    this.d.db.saveBee(this.bees[id], now);
    return { ok, costPct: ok && before > 0 ? Math.max(0, ((before - this.bees[id].equityUsd) / before) * 100) : 0 };
  }

  /** One-way close fee plus half-spread, as percentage points of this slot's equity. */
  handoffCostPct(id: BeeId): number {
    const b = this.bees[id];
    const p = b.position;
    if (!p || b.equityUsd <= 0) return 0;
    const view = this.d.feed.view();
    const inst = view.instruments.get(p.instId);
    const s = view.stats.get(p.instId);
    if (!inst || !s) return Number.POSITIVE_INFINITY;
    const notional = positionNotional(p, s.mid, inst.ctVal);
    return (notional / b.equityUsd) * (this.d.cfg.risk.takerFeeRate * 100 + s.spreadBp / 200);
  }

  private entriesAllowed(id: BeeId): boolean {
    return this.portfolioTrippedAt === null && (this.d.entriesAllowed?.(id) ?? true);
  }

  private restorePortfolioBreaker(): void {
    this.portfolioDay = this.d.db.getMeta("portfolio_day") ?? "";
    this.portfolioDayStartUsd = Number(this.d.db.getMeta("portfolio_day_start_usd")) || 0;
    this.portfolioTrippedAt = Number(this.d.db.getMeta("portfolio_tripped_at")) || null;
  }

  private updatePortfolioBreaker(now: number): void {
    if (!this.d.portfolioLossStopPct) return;
    const day = new Date(now).toISOString().slice(0, 10);
    const equity = this.ids.reduce((sum, id) => sum + this.bees[id].equityUsd, 0);
    if (day !== this.portfolioDay) {
      this.portfolioDay = day;
      this.portfolioDayStartUsd = equity;
      this.portfolioTrippedAt = null;
      this.d.db.setMeta("portfolio_day", day);
      this.d.db.setMeta("portfolio_day_start_usd", String(equity));
      this.d.db.setMeta("portfolio_tripped_at", "0");
      return;
    }
    if (this.portfolioTrippedAt !== null || equity > this.portfolioDayStartUsd * (1 - this.d.portfolioLossStopPct / 100)) return;
    this.portfolioTrippedAt = now;
    this.d.db.setMeta("portfolio_tripped_at", String(now));
    this.d.bus.emit("cap", { bee: "portfolio", cap: "loss_stop", detail: `combined portfolio lost ${this.d.portfolioLossStopPct}% today` }, now);
    this.d.alerts.send(`combined portfolio daily loss stop (${this.d.portfolioLossStopPct}%): closing live exposure`);
  }

  /** The slot's style brain, narrowed to the owner's coins and carrying the owner's rules (bees/custom.ts). */
  private brain(id: BeeId): BeeBrain {
    const s = this.d.cfg.slots[id];
    return (this.brains[id] ??= customBrain(BRAINS[s.style], { coins: s.coins, rules: s.rules }));
  }

  private knobs(id: BeeId) {
    return this.d.cfg.bees[this.d.cfg.slots[id].style];
  }

  private checkJevOutage(now: number) {
    const since = this.d.jev.downSince;
    if (since === null) {
      if (this.jevDownAlerted) this.d.alerts.send("Jev is back");
      this.jevDownAlerted = false;
    } else if (!this.jevDownAlerted && now - since > 5 * 60_000) {
      this.jevDownAlerted = true;
      this.d.alerts.send("Jev unreachable for over 5 minutes: all bees holding");
    }
  }

  private sizeMult(now: number): number {
    const { cfg } = this.d;
    if (cfg.mode !== "live" || this.liveStartedAt === null) return 1;
    return now - this.liveStartedAt < cfg.risk.liveRampHours * 3_600_000 ? cfg.risk.liveSizeMultiplier : 1;
  }

  // ---------- read-only views for the dashboard ----------

  private publicBee(id: BeeId) {
    const b = this.bees[id];
    const view = this.d.feed.view();
    const p = b.position;
    const inst = p ? view.instruments.get(p.instId) : undefined;
    const mid = p ? view.tickers.get(p.instId)?.mid : undefined;
    const start = this.d.cfg.risk.startEquityUsd;
    const knobs = this.knobs(id);
    const r2 = (x: number) => Number(x.toFixed(2));
    return {
      bee: id,
      equityUsd: r2(b.equityUsd),
      pnlUsd: r2(b.equityUsd - start),
      pnlPct: r2(((b.equityUsd - start) / start) * 100),
      position: p
        ? {
            coin: p.coin,
            side: p.side,
            sizeUsd: inst && mid ? r2(positionNotional(p, mid, inst.ctVal)) : null,
            entryPx: p.entryPx,
            markPx: mid ?? null,
            stopPx: p.stopPx,
            protected: this.d.exec.kind !== "okx" || this.protectionVerified.has(id),
            uplUsd: r2(b.uplUsd),
            minutesHeld: Math.round(minutesSince(p.openedAt, this.now())),
          }
        : null,
      flatMinutes: p ? null : Math.round(minutesSince(b.flatSince, this.now())),
      tradesToday: b.tradesToday,
      maxTradesPerDay: knobs.maxTradesPerDay,
      feesTodayUsd: r2(b.feesTodayUsd),
      feeBudgetUsd: knobs.feeBudgetUsdDay,
      cap: b.cap,
      totals: { feesUsd: r2(b.totals.feesUsd), fundingUsd: r2(b.totals.fundingUsd), jevUsd: Number(b.totals.jevUsd.toFixed(4)), realisedUsd: r2(b.totals.realisedUsd), decisions: b.totals.decisions, orders: b.totals.orders },
      maxNotionalUsd: r2(maxNotionalUsd(this.ctx(id, this.now()))),
      last: this.last[id] ?? null,
    };
  }

  snapshot() {
    const bees = this.ids.map((id) => this.publicBee(id));
    const sum = (f: (b: (typeof bees)[number]) => number) => Number(bees.reduce((a, b) => a + f(b), 0).toFixed(4));
    const view = this.d.feed.view();
    return {
      ts: this.now(),
      release: this.d.cfg.update.version,
      mode: this.d.cfg.mode,
      startedAt: this.experimentStartedAt,
      closed: this.closedAt === null ? null : { at: this.closedAt, flat: this.ids.every((id) => !this.bees[id].position) },
      startEquityUsd: this.d.cfg.risk.startEquityUsd,
      tickMs: this.d.cfg.tickMs,
      safetyTickMs: this.d.cfg.safetyTickMs,
      bees,
      leaderboard: [...bees].sort((a, b) => b.equityUsd - a.equityUsd).map((b) => ({ bee: b.bee, equityUsd: b.equityUsd })),
      totals: { feesUsd: sum((b) => b.totals.feesUsd), fundingUsd: sum((b) => b.totals.fundingUsd), jevUsd: sum((b) => b.totals.jevUsd), pnlUsd: sum((b) => b.pnlUsd) },
      jev: { spentTodayUsd: Number(this.d.jev.spentTodayUsd.toFixed(4)), dailyCapUsd: this.d.cfg.jev.dailyUsdCap, capTripped: this.d.jev.capTripped, down: this.d.jev.downSince !== null },
      recon: this.recon,
      portfolioBreaker: { dayStartEquityUsd: this.portfolioDayStartUsd, trippedAt: this.portfolioTrippedAt, lossStopPct: this.d.portfolioLossStopPct ?? null },
      risk: { takerFeeRate: this.d.cfg.risk.takerFeeRate },
      market: {
        refreshedAt: view.ts,
        universe: view.gated.map((i) => i.split("-")[0]),
        spreadBlocked: view.spreadBlocked.map((i) => ({ coin: i.split("-")[0], spreadBp: Number((view.tickers.get(i)?.spreadBp ?? 0).toFixed(1)) })),
        attention: view.newsAvailable ? "news" : "volume",
      },
    };
  }

  health() {
    const age = this.now() - this.d.feed.lastRefreshAt;
    const now = this.now();
    const maxAge = 5 * this.d.cfg.safetyTickMs;
    const reasons: string[] = [];
    if (!this.d.feed.lastRefreshAt || age >= 5 * this.d.cfg.dataRefreshMs) reasons.push("market data stale");
    if (!this.lastSafetyAt || now - this.lastSafetyAt >= maxAge) reasons.push("safety loop stale");
    if (!this.dbWritable) reasons.push("database write failed");
    if (this.d.cfg.backup.statusPath) {
      const issue = backupHealth(this.d.cfg.backup.statusPath, now, this.d.cfg.backup.maxAgeMs);
      if (issue) reasons.push(issue);
    }
    if (this.d.exec.kind === "okx") {
      if (this.recon.ok !== true || now - this.recon.ts >= RECON_MS * 2) reasons.push("exchange reconciliation stale or failed");
      if (!this.lastExchangeReadAt || now - this.lastExchangeReadAt >= RECON_MS * 2) reasons.push("exchange reads stale");
      if (this.ids.some((id) => this.d.db.hasUnresolvedExposureOrder(id))) reasons.push("unresolved exchange order");
      if (this.ids.some((id) => this.bees[id].position && !this.protectionVerified.has(id))) reasons.push("position lacks verified native protection");
    }
    return { ok: reasons.length === 0, reasons, release: this.d.cfg.update.version, mode: this.d.cfg.mode, closed: this.closedAt !== null, flat: this.ids.every((id) => !this.bees[id].position), marketAgeMs: age, safetyAgeMs: this.lastSafetyAt ? now - this.lastSafetyAt : null, reconciliationAgeMs: this.recon.ts ? now - this.recon.ts : null, exchangeReadAgeMs: this.lastExchangeReadAt ? now - this.lastExchangeReadAt : null, uptimeS: Math.round((now - this.startedAt) / 1000) };
  }

  private monitorBackup(now: number): void {
    const path = this.d.cfg.backup.statusPath;
    if (!path) return;
    const issue = backupHealth(path, now, this.d.cfg.backup.maxAgeMs);
    if (issue && issue !== this.lastBackupIssue) void this.d.alerts.send(issue, now);
    this.lastBackupIssue = issue;
  }
}

function fundingSlot(ms: number): number {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const slotHour = [...FUNDING_HOURS_UTC].reverse().find((x) => h >= x) ?? 0;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slotHour);
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case "none":
      return "hold";
    case "close":
      return `close (${a.reason})`;
    case "trim":
      return `trim ${Math.round(a.fraction * 100)}%`;
    case "add":
      return `add $${a.notionalUsd.toFixed(0)}`;
    case "open":
      return `${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
    case "switch":
      return `switch to ${a.side} ${a.instId.split("-")[0]} $${a.notionalUsd.toFixed(0)}`;
  }
}

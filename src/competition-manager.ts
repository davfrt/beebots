import type { BeeId, SlotProfile } from "./config.js";
import type { BeeState } from "./bees/types.js";
import { executionFingerprint, type Competition, type RankedStrategy, rankStrategies } from "./competition.js";
import type { Db } from "./db.js";
import type { Engine } from "./engine.js";
import type { EventBus } from "./events.js";
import { log } from "./log.js";

const DAY_MS = 86_400_000;
const LIVE_IDS = ["bee1", "bee2"] as const;

interface Installation {
  fingerprint: string;
  installedAt: number;
  baselineEquityUsd: number;
  baselineTotals: BeeState["totals"];
  baselineDay: string;
  baselineTradesToday: number;
  baselineFeesTodayUsd: number;
}

interface ManagerState {
  selectedDay: string | null;
  activeSlot: BeeId | null;
  champion: RankedStrategy | null;
  championSince: number | null;
  liveSlots: Partial<Record<BeeId, RankedStrategy>>;
  liveInstalls: Partial<Record<BeeId, Installation>>;
  paper: Array<{ slot: BeeId; strategy: RankedStrategy; startedAt: number; install?: Installation }>;
  lastRanking: RankedStrategy[];
  lastReason: string;
  pendingHandoff: { target: BeeId; winner: RankedStrategy; startedAt: number; selectedDay: string; forced: boolean } | null;
}

interface ManagerOpts {
  db: Db;
  competition: Competition;
  paper: Engine;
  live?: Engine;
  bus: EventBus;
  now?: () => number;
  promotion?: { observeMs: number; restrictedLiveMs?: number; approval?: { fingerprint: string; release: string }; release: string; identity?: unknown };
}

const emptyState = (): ManagerState => ({ selectedDay: null, activeSlot: null, champion: null, championSince: null, liveSlots: {}, liveInstalls: {}, paper: [], lastRanking: [], lastReason: "collecting first Hive snapshot", pendingHandoff: null });

const profile = (s: RankedStrategy): SlotProfile => ({ style: s.style, name: s.name, tagline: s.tagline, rules: s.rules, coins: s.coins, customImage: false, fromSetup: true });

export function winnerAfterHandoffCost(ranked: RankedStrategy[], incumbentFingerprint: string | null, costPct: number): RankedStrategy | null {
  const winner = ranked[0];
  if (!winner || !incumbentFingerprint || winner.fingerprint === incumbentFingerprint) return winner ?? null;
  const incumbent = ranked.find((r) => r.fingerprint === incumbentFingerprint);
  return incumbent && winner.returnPct - costPct <= incumbent.returnPct ? incumbent : winner;
}

export class CompetitionManager {
  private state: ManagerState;
  private timer: NodeJS.Timeout | null = null;
  private now: () => number;
  private selecting = false;

  constructor(private o: ManagerOpts) {
    this.now = o.now ?? Date.now;
    try {
      this.state = JSON.parse(o.db.getMeta("competition_manager") ?? "null") as ManagerState ?? emptyState();
      this.state.liveSlots ??= {};
      this.state.liveInstalls ??= {};
      this.state.championSince ??= null;
      this.state.pendingHandoff ??= null;
      this.state.paper = (this.state.paper ?? []).map((row) => ({ ...row, startedAt: row.startedAt ?? 0 }));
      const promotion = o.promotion;
      if (promotion?.identity !== undefined) {
        this.state.paper = this.state.paper.map((row) => {
          const strategy = this.candidate(row.strategy);
          return strategy.fingerprint === row.strategy.fingerprint ? row : { ...row, strategy, startedAt: this.now() };
        });
        if (this.state.champion && (this.candidate(this.state.champion).fingerprint !== this.state.champion.fingerprint
          || promotion.approval?.fingerprint !== this.state.champion.fingerprint
          || promotion.approval.release !== promotion.release)) {
          this.state.activeSlot = null;
          this.state.champion = null;
          this.state.championSince = null;
          this.state.lastReason = "live approval is stale after a release or risk-policy change";
        }
      }
    } catch {
      this.state = emptyState();
    }
  }

  private candidate(s: RankedStrategy): RankedStrategy {
    return this.o.promotion?.identity === undefined ? s : { ...s, fingerprint: executionFingerprint(s, this.o.promotion.identity) };
  }

  private promotionReason(candidate: RankedStrategy, now: number, observed: boolean): string | null {
    const promotion = this.o.promotion;
    if (!promotion) return "live promotion needs an explicit approval";
    const paper = this.state.paper.find((row) => row.strategy.fingerprint === candidate.fingerprint);
    if (!paper || now - paper.startedAt < promotion.observeMs) return "candidate is still in local paper observation";
    if (!observed) return "candidate has no completed local paper result";
    if (!promotion.approval) return "candidate needs explicit owner approval";
    if (promotion.approval.release !== promotion.release) return "candidate approval belongs to a different release";
    if (promotion.approval.fingerprint !== candidate.fingerprint) return "candidate approval belongs to a different strategy";
    if (this.state.champion && candidate.fingerprint !== this.state.champion.fingerprint && now - (this.state.championSince ?? now) < (promotion.restrictedLiveMs ?? 0)) return "automatic rotation is disabled during restricted live observation";
    return null;
  }

  entriesAllowed = (id: BeeId): boolean => !this.selecting && !this.state.pendingHandoff && this.state.activeSlot === id;
  paperEntriesAllowed = (id: BeeId): boolean => !this.selecting && !this.state.pendingHandoff && this.state.paper.some((row) => row.slot === id);

  private installation(engine: Engine, id: BeeId, strategy: RankedStrategy, installedAt: number): Installation | undefined {
    const bee = engine.bees?.[id];
    return bee ? {
      fingerprint: strategy.fingerprint,
      installedAt,
      baselineEquityUsd: bee.equityUsd,
      baselineTotals: { ...bee.totals },
      baselineDay: bee.dayKey,
      baselineTradesToday: bee.tradesToday,
      baselineFeesTodayUsd: bee.feesTodayUsd,
    } : undefined;
  }

  restoreProfiles(): void {
    for (const row of this.state.paper) {
      this.o.paper.setProfile(row.slot, profile(row.strategy), true);
      if (!row.install?.baselineDay) row.install = this.installation(this.o.paper, row.slot, row.strategy, this.now());
    }
    if (this.o.live) {
      if (this.state.champion) {
        this.state.activeSlot ??= "bee1";
        this.state.liveSlots[this.state.activeSlot] ??= this.state.champion;
      }
      for (const [id, strategy] of Object.entries(this.state.liveSlots) as Array<[BeeId, RankedStrategy]>) {
        this.o.live.setProfile(id, profile(strategy), true);
        if (!this.state.liveInstalls[id]?.baselineDay) this.state.liveInstalls[id] = this.installation(this.o.live, id, strategy, this.now())!;
      }
    }
    this.save();
  }

  async start(): Promise<void> {
    await this.recoverPendingHandoff();
    await this.o.competition.ingest().catch(() => 0);
    if (!this.state.champion?.img) await this.select(true);
    this.timer = setInterval(() => void this.select(false).catch((err) => log.warn("daily competition selection failed", { err: err instanceof Error ? err.message : String(err) })), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  portrait(fingerprint: string): string | null {
    const strategies = [this.state.champion, ...this.state.paper.map((row) => row.strategy), ...Object.values(this.state.liveSlots), ...this.state.lastRanking];
    return strategies.find((strategy) => strategy?.fingerprint === fingerprint)?.img ?? null;
  }

  async select(coldStart = false): Promise<void> {
    if (this.selecting) return;
    this.selecting = true;
    try {
      await this.recoverPendingHandoff();
      await this.selectOnce(coldStart);
    } finally {
      this.selecting = false;
    }
  }

  private async selectOnce(coldStart: boolean): Promise<void> {
    const now = this.now();
    const end = Math.floor(now / DAY_MS) * DAY_MS;
    const startedAt = now;
    const selectedDay = new Date(end).toISOString().slice(0, 10);
    if (!coldStart && this.state.selectedDay === selectedDay) return;
    if (!coldStart) await this.o.competition.ingest();
    const priorDay = new Date(end - DAY_MS).toISOString().slice(0, 10);
    const online = coldStart ? this.o.competition.weeklyOnline(now) : this.o.competition.dailyOnline(end);
    const local: RankedStrategy[] = [];
    for (const row of this.state.paper) {
      if (row.startedAt > end - DAY_MS) continue;
      const value = this.o.paper.lastDayReturn(row.slot, priorDay);
      if (value !== null) local.push({ ...row.strategy, source: "paper", returnPct: value - this.o.paper.handoffCostPct(row.slot) });
    }
    if (this.o.live && this.state.activeSlot && this.state.champion) {
      if ((this.state.championSince ?? now) > end - DAY_MS) {
        // It did not run for the complete UTC day.
      } else {
      const value = this.o.live.lastDayReturn(this.state.activeSlot, priorDay);
      if (value !== null) local.push({ ...this.state.champion, source: "live", returnPct: value });
      }
    }
    const observed = local.map((strategy) => this.candidate(strategy));
    const ranked = rankStrategies([...online, ...observed].map((strategy) => this.candidate(strategy)));
    if (!ranked.length) {
      this.state.lastReason = "no complete eligible results; keeping current roster";
      if (this.state.champion) this.state.selectedDay = selectedDay;
      return this.save();
    }

    let winner = ranked[0]!;
    const promotionReason = this.promotionReason(winner, now, observed.some((strategy) => strategy.fingerprint === winner.fingerprint));
    const incumbent = this.state.champion && ranked.find((r) => r.fingerprint === this.state.champion!.fingerprint);
    const existingWinnerSlot = (Object.entries(this.state.liveSlots) as Array<[BeeId, RankedStrategy]>).find(([, strategy]) => strategy.fingerprint === winner.fingerprint)?.[0] ?? null;
    let forcedClose: BeeId | null = null;
    let handoffCostPct = 0;
    if (!promotionReason && this.o.live && !existingWinnerSlot && winner.fingerprint !== this.state.champion?.fingerprint && LIVE_IDS.every((id) => !this.o.live!.isFlat(id))) {
      if (!incumbent) {
        if (!this.state.champion) {
          this.state.lastReason = "both live slots occupied without a complete incumbent result; keeping current roster";
          this.state.selectedDay = selectedDay;
          return this.save();
        }
        winner = this.state.champion;
      } else {
        forcedClose = [...LIVE_IDS].sort((a, b) => (this.o.live!.positionOpenedAt(a) ?? 0) - (this.o.live!.positionOpenedAt(b) ?? 0))[0]!;
        handoffCostPct = this.o.live.handoffCostPct(forcedClose);
        winner = winnerAfterHandoffCost(ranked, incumbent.fingerprint, handoffCostPct) ?? incumbent;
      }
    }

    if (!promotionReason && this.o.live && winner.fingerprint !== this.state.champion?.fingerprint) {
      await this.o.live.exclusive(async () => {
        const existing = (Object.entries(this.state.liveSlots) as Array<[BeeId, RankedStrategy]>).find(([, strategy]) => strategy.fingerprint === winner.fingerprint)?.[0];
        if (existing) {
          this.o.live!.setProfile(existing, profile(winner), true);
          this.state.activeSlot = existing;
          this.state.liveSlots[existing] = winner;
          this.state.liveInstalls[existing] ??= this.installation(this.o.live!, existing, winner, now);
        }
        else {
          const target = forcedClose ?? LIVE_IDS.find((id) => this.o.live!.isFlat(id));
          if (!target) throw new Error("no flat live slot after handoff close");
          this.state.pendingHandoff = { target, winner, startedAt, selectedDay, forced: !!forcedClose };
          this.save();
          if (forcedClose) {
            const closed = await this.o.live!.closeNow(forcedClose, "daily_handoff", now);
            if (!closed.ok) throw new Error("could not close the oldest live position for handoff");
            handoffCostPct = closed.costPct;
            if (incumbent && winner.returnPct - handoffCostPct <= incumbent.returnPct) {
              winner = incumbent;
              this.state.pendingHandoff = null;
              this.save();
              return;
            }
          }
          this.o.live!.setProfile(target, profile(winner));
          this.state.activeSlot = target;
          this.state.liveSlots[target] = winner;
          this.state.liveInstalls[target] = this.installation(this.o.live!, target, winner, now)!;
          this.state.champion = winner;
          this.state.championSince = startedAt;
          this.state.pendingHandoff = null;
          this.save();
        }
      });
      this.state.championSince ??= startedAt;
    } else if (this.o.live && this.state.activeSlot && winner.fingerprint === this.state.champion?.fingerprint) {
      await this.o.live.exclusive(async () => this.o.live!.setProfile(this.state.activeSlot!, profile(winner), true));
      this.state.liveSlots[this.state.activeSlot] = winner;
      this.state.liveInstalls[this.state.activeSlot] ??= this.installation(this.o.live, this.state.activeSlot, winner, now);
    }

    const runners = ranked.slice(0, 3);
    const paper = runners.map((strategy, i) => {
      const prior = this.state.paper.find((row) => row.strategy.fingerprint === strategy.fingerprint);
      return { slot: `bee${i + 1}` as BeeId, strategy, startedAt: prior?.startedAt ?? startedAt, install: undefined as Installation | undefined };
    });
    await this.o.paper.exclusive(async () => {
      for (let i = 0; i < this.o.paper.slotIds().length; i++) {
        const id = this.o.paper.slotIds()[i]!;
        const runner = runners[i];
        if (runner) {
          await this.o.paper.replacePaperProfile(id, profile(runner), now);
          paper[i]!.install = this.installation(this.o.paper, id, runner, now);
        }
        else await this.o.paper.closeNow(id, "no_daily_runner", now);
      }
    });
    this.state = {
      selectedDay,
      activeSlot: this.o.live ? this.state.activeSlot : null,
      champion: promotionReason && winner.fingerprint !== this.state.champion?.fingerprint ? this.state.champion : winner,
      championSince: promotionReason && winner.fingerprint !== this.state.champion?.fingerprint ? this.state.championSince : this.state.champion?.fingerprint === winner.fingerprint ? this.state.championSince : startedAt,
      liveSlots: this.state.liveSlots,
      liveInstalls: this.state.liveInstalls,
      paper,
      lastRanking: ranked.slice(0, 4),
      lastReason: promotionReason ?? (coldStart ? "cold start: public weekly return" : handoffCostPct ? `daily return; challenger charged ${handoffCostPct.toFixed(3)} points handoff cost` : "previous UTC day net return"),
      pendingHandoff: null,
    };
    this.save();
    this.o.bus.emit("competition", { champion: this.state.champion?.name ?? null, candidate: winner.name, source: winner.source, returnPct: winner.returnPct, paper: runners.map((r) => r.name), reason: this.state.lastReason }, now);
  }

  private save(): void {
    this.o.db.setMeta("competition_manager", JSON.stringify(this.state));
  }

  private async recoverPendingHandoff(): Promise<void> {
    const pending = this.state.pendingHandoff;
    if (!pending) return;
    if (!this.o.live) {
      this.state.pendingHandoff = null;
      return this.save();
    }
    await this.o.live.exclusive(async () => {
      await this.o.live!.reconcile();
      if (this.o.live!.isFlat(pending.target) && pending.forced === false) {
        this.o.live!.setProfile(pending.target, profile(pending.winner));
        this.state.activeSlot = pending.target;
        this.state.liveSlots[pending.target] = pending.winner;
        this.state.liveInstalls[pending.target] = this.installation(this.o.live!, pending.target, pending.winner, this.now())!;
        this.state.champion = pending.winner;
        this.state.championSince = pending.startedAt;
      } else if (pending.forced) {
        this.state.selectedDay = pending.selectedDay;
        this.state.lastReason = "interrupted forced handoff; keeping incumbent until the next daily selection";
      }
      this.state.pendingHandoff = null;
      this.save();
    });
  }

  status() {
    return {
      ...this.o.competition.status(),
      liveEnabled: !!this.o.live,
      selectedDay: this.state.selectedDay,
      champion: this.state.champion,
      activeSlot: this.state.activeSlot,
      liveSlots: this.state.liveSlots,
      liveInstalls: this.state.liveInstalls,
      championSince: this.state.championSince,
      paper: this.state.paper,
      ranking: this.state.lastRanking,
      reason: this.state.lastReason,
    };
  }
}

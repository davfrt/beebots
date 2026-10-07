import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "./db.js";
import { log } from "./log.js";
import { safeError } from "./redact.js";
import { STYLES, type StyleId } from "./settings.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BEES = 5_000;

const HiveBeeSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(100),
  tagline: z.string().max(200).default(""),
  style: z.enum(STYLES),
  pnlPct: z.number().finite(),
  weekPct: z.number().finite().nullable(),
  trades: z.number().int().nonnegative(),
  verified: z.boolean(),
  official: z.boolean(),
  retired: z.boolean(),
  lastSeen: z.number().int().nonnegative(),
  instructions: z.string().max(600).nullable(),
  coins: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,15}$/)).max(20),
  img: z.string().regex(/^\/(?:hive\/portrait\/[a-f0-9]+\.jpg|bees\/(?:bizzy|breezy|boozy)\.jpg)$/),
});

const BoardSchema = z.object({
  total: z.number().int().nonnegative().max(MAX_BEES),
  page: z.number().int().positive(),
  per: z.number().int().positive().max(50),
  // Checked one by one: a single malformed or oversized bot must not hide the rest of the board.
  bees: z.array(z.unknown()).max(50),
});

export type HiveBee = z.infer<typeof HiveBeeSchema>;

export interface CompetitionStrategy {
  fingerprint: string;
  sourceId: string;
  name: string;
  tagline: string;
  style: StyleId;
  rules: string;
  coins: string[];
  img: string;
  returnPct: number;
  trades: number;
  official: boolean;
}

export interface RankedStrategy extends CompetitionStrategy {
  source: "online" | "paper" | "live";
}

export function strategyFingerprint(s: { style: StyleId; instructions: string | null; coins: string[] }): string {
  const rules = (s.instructions ?? "").trim().replace(/\s+/g, " ");
  const coins = [...new Set(s.coins.map((c) => c.toUpperCase()))].sort();
  return createHash("sha256").update(JSON.stringify([s.style, rules, coins])).digest("hex").slice(0, 24);
}

/** A live-authority identity includes deployed behavior, not display metadata or source account IDs. */
export function executionFingerprint(s: { style: StyleId; rules: string; coins: string[] }, policy: unknown): string {
  return createHash("sha256").update(JSON.stringify([strategyFingerprint({ style: s.style, instructions: s.rules, coins: s.coins }), policy])).digest("hex").slice(0, 24);
}

/** Highest net return wins. One configuration may occupy only one rank. */
export function rankStrategies(rows: RankedStrategy[]): RankedStrategy[] {
  const byStrategy = new Map<string, RankedStrategy>();
  for (const row of rows) {
    const held = byStrategy.get(row.fingerprint);
    if (!held || row.returnPct > held.returnPct || (row.returnPct === held.returnPct && row.sourceId < held.sourceId)) byStrategy.set(row.fingerprint, row);
  }
  return [...byStrategy.values()].sort((a, b) => b.returnPct - a.returnPct || b.trades - a.trades || a.fingerprint.localeCompare(b.fingerprint));
}

export interface CompetitionOpts {
  db: Db;
  url: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface ObservationRow {
  bot_id: string;
  fingerprint: string;
  pnl_pct: number;
  week_pct: number | null;
  trades: number;
  official: number;
  profile_json: string;
}

/** Read-only observer for beebots.tech. It never reports local state and never places an order. */
export class Competition {
  private fetch: typeof fetch;
  private now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: string | null = null;
  private inFlight: Promise<number> | null = null;

  constructor(private o: CompetitionOpts) {
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    o.db.raw.exec(`
      CREATE TABLE IF NOT EXISTS hive_observations (
        bucket_ts INTEGER NOT NULL, bot_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        pnl_pct REAL NOT NULL, week_pct REAL, trades INTEGER NOT NULL, official INTEGER NOT NULL,
        profile_json TEXT NOT NULL, PRIMARY KEY (bucket_ts, bot_id)
      );
      CREATE INDEX IF NOT EXISTS hive_observations_bucket ON hive_observations(bucket_ts);
    `);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    const wait = HOUR_MS - (this.now() % HOUR_MS) + 1_000;
    this.timer = setTimeout(() => void this.poll(), wait);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    try {
      await this.ingest();
      this.lastError = null;
    } catch (err) {
      this.lastError = safeError(err).message;
      log.warn("Hive observation failed", { err: safeError(err) });
    } finally {
      this.schedule();
    }
  }

  async ingest(): Promise<number> {
    return (this.inFlight ??= this.ingestNow().finally(() => (this.inFlight = null)));
  }

  private async ingestNow(): Promise<number> {
    const all: HiveBee[] = [];
    let page = 1;
    let total = 1;
    while (all.length < total) {
      const r = await this.fetch(`${this.o.url}/hive/board?page=${page}&per=50&sort=pnl`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`Hive board HTTP ${r.status}`);
      const board = BoardSchema.parse(await r.json());
      if (board.page !== page) throw new Error("Hive board returned the wrong page");
      total = board.total;
      for (const raw of board.bees) {
        const bee = HiveBeeSchema.safeParse(raw);
        if (bee.success) all.push(bee.data);
      }
      if (board.bees.length === 0 || page * board.per >= total) break;
      page++;
    }

    const now = this.now();
    const bucket = Math.floor(now / HOUR_MS) * HOUR_MS;
    const insert = this.o.db.raw.prepare(
      `INSERT INTO hive_observations (bucket_ts, bot_id, fingerprint, pnl_pct, week_pct, trades, official, profile_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bucket_ts, bot_id) DO UPDATE SET fingerprint=excluded.fingerprint, pnl_pct=excluded.pnl_pct,
         week_pct=excluded.week_pct, trades=excluded.trades, official=excluded.official, profile_json=excluded.profile_json`,
    );
    let accepted = 0;
    this.o.db.raw.exec("BEGIN");
    try {
      for (const bee of all) {
        if (!bee.verified || bee.retired || now - bee.lastSeen > DAY_MS || !bee.instructions?.trim() || bee.trades < 2) continue;
        const coins = [...new Set(bee.coins)].sort();
        const fingerprint = strategyFingerprint({ ...bee, coins });
        insert.run(bucket, bee.id, fingerprint, bee.pnlPct, bee.weekPct, bee.trades, bee.official ? 1 : 0, JSON.stringify({ name: bee.name, tagline: bee.tagline, style: bee.style, rules: bee.instructions.trim(), coins, img: bee.img }));
        accepted++;
      }
      this.o.db.raw.exec("COMMIT");
    } catch (err) {
      this.o.db.raw.exec("ROLLBACK");
      throw err;
    }
    this.o.db.setMeta("competition_last_observed_at", String(now));
    this.o.db.setMeta("competition_last_observed_count", String(accepted));
    return accepted;
  }

  /** Public strategies observed at both UTC boundaries with an unchanged configuration. */
  dailyOnline(dayEnd: number): RankedStrategy[] {
    const end = Math.floor(dayEnd / DAY_MS) * DAY_MS;
    const start = end - DAY_MS;
    const rows = this.o.db.raw
      .prepare(
        `SELECT e.bot_id, e.fingerprint, e.pnl_pct, e.week_pct, e.trades, e.official, e.profile_json,
                s.pnl_pct AS start_pnl
         FROM hive_observations e JOIN hive_observations s
           ON s.bot_id=e.bot_id AND s.fingerprint=e.fingerprint AND s.bucket_ts=?
         WHERE e.bucket_ts=?
           AND (SELECT COUNT(*) FROM hive_observations h WHERE h.bot_id=e.bot_id AND h.bucket_ts BETWEEN ? AND ?) = 25
           AND (SELECT COUNT(DISTINCT h.fingerprint) FROM hive_observations h WHERE h.bot_id=e.bot_id AND h.bucket_ts BETWEEN ? AND ?) = 1`,
      )
      .all(start, end, start, end, start, end) as unknown as Array<ObservationRow & { start_pnl: number }>;
    return rankStrategies(rows.map((r) => this.toStrategy(r, ((1 + r.pnl_pct / 100) / (1 + r.start_pnl / 100) - 1) * 100)));
  }

  /** First-day fallback: current public week-to-date result. */
  weeklyOnline(at = this.now()): RankedStrategy[] {
    const bucket = Math.floor(at / HOUR_MS) * HOUR_MS;
    const rows = this.o.db.raw
      .prepare(`SELECT bot_id, fingerprint, pnl_pct, week_pct, trades, official, profile_json FROM hive_observations WHERE bucket_ts=? AND week_pct IS NOT NULL`)
      .all(bucket) as unknown as ObservationRow[];
    return rankStrategies(rows.map((r) => this.toStrategy(r, r.week_pct!)));
  }

  private toStrategy(r: ObservationRow, returnPct: number): RankedStrategy {
    const p = JSON.parse(r.profile_json) as { name: string; tagline: string; style: StyleId; rules: string; coins: string[]; img: string };
    return { fingerprint: r.fingerprint, sourceId: r.bot_id, name: p.name, tagline: p.tagline, style: p.style, rules: p.rules, coins: p.coins, img: p.img, returnPct, trades: r.trades, official: r.official === 1, source: "online" };
  }

  status() {
    const observedAt = Number(this.o.db.getMeta("competition_last_observed_at")) || null;
    return {
      observedAt,
      observed: Number(this.o.db.getMeta("competition_last_observed_count")) || 0,
      problem: this.lastError,
      nextSelectionAt: (Math.floor(this.now() / DAY_MS) + 1) * DAY_MS,
    };
  }
}

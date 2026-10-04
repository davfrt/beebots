import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Alerts } from "./alerts.js";
import { BREEZY_COINS } from "./bees/breezy.js";
import { BEES, STYLES, type Config } from "./config.js";
import { CompetitionManager } from "./competition-manager.js";
import { Competition } from "./competition.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { EventBus } from "./events.js";
import { OkxExecutor, SimExecutor } from "./exec/executor.js";
import { Jev } from "./jev.js";
import { log } from "./log.js";
import { preflightLiveAccounts } from "./live-preflight.js";
import { MarketFeed } from "./market/data.js";
import { createOkxCli } from "./okx/cli.js";
import { createNewsSource } from "./okx/news.js";
import { createPublicApi } from "./okx/public.js";
import { createOkxPublicRest } from "./okx/rest.js";
import { startServer } from "./server.js";
import { STYLE_INFO } from "./settings.js";
import { UpdateCheck } from "./update.js";
import { Visitors } from "./visitors.js";

const LIVE_IDS = ["bee1", "bee2"] as const;

const dbPath = (cfg: Config, name: string) => join(dirname(cfg.dbPath), `competition-${name}.sqlite`);

function publicProfile(cfg: Config) {
  return {
    setup: false,
    mode: cfg.mode,
    links: cfg.links,
    bees: BEES.map((id) => {
      const s = cfg.slots[id];
      return { id, name: s.name, tagline: s.tagline, style: s.style, styleLabel: STYLE_INFO[s.style].label, rules: s.rules, coins: s.coins, img: `/bees/${s.style}.jpg` };
    }),
  };
}

/** Opt-in runtime: three paper runners plus two isolated live handoff slots. */
export async function runCompetitionApp(cfg: Config): Promise<void> {
  const liveEnabled = cfg.mode === "live";
  const paperCfg: Config = { ...cfg, mode: "dry", dbPath: dbPath(cfg, "paper"), creds: {}, slots: structuredClone(cfg.slots) };
  const liveCfg: Config | null = liveEnabled ? { ...cfg, dbPath: dbPath(cfg, "live"), slots: structuredClone(cfg.slots) } : null;
  const paperDb = new Db(paperCfg.dbPath);
  const liveDb = liveCfg ? new Db(liveCfg.dbPath) : null;
  const bus = new EventBus(paperDb);
  const alerts = new Alerts(cfg.alertWebhookUrl, cfg.deadManUrl);
  const cli = createOkxCli({ site: cfg.okx.site, timeoutMs: cfg.okx.cliTimeoutMs });
  const api = createPublicApi(cfg.okx.apiBase, false, createOkxPublicRest({ apiBase: cfg.okx.apiBase, timeoutMs: cfg.okx.cliTimeoutMs }));
  let live: Engine | undefined;
  const runtime: { paper?: Engine; manager?: CompetitionManager } = {};
  const held = () => [runtime.paper, live].flatMap((e) => e ? e.slotIds().map((id) => e.bees[id]?.position?.instId).filter((x): x is string => !!x) : []);
  const newsCreds = liveEnabled ? LIVE_IDS.map((id) => cfg.creds[id]).find((c) => !!c) : undefined;
  const feed = new MarketFeed(api, {
    min24hVolUsd: cfg.universe.min24hVolUsd,
    allowNonCrypto: cfg.universe.allowNonCrypto,
    spreadGateBps: Math.max(...STYLES.map((s) => cfg.bees[s].spreadGateBps)),
    trendCoins: [...BREEZY_COINS],
  }, newsCreds ? createNewsSource(cli, newsCreds, false) : null, held);
  const startOfDay = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const spent = paperDb.jevSpendSince(startOfDay) + (liveDb?.jevSpendSince(startOfDay) ?? 0);
  const jev = new Jev({ ...cfg.jev, spentTodayUsd: spent });

  const closeDir = dirname(cfg.dbPath);
  const paper = new Engine({
    cfg: paperCfg, db: paperDb, feed, jev, exec: new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate), bus, alerts, ids: BEES,
    entriesAllowed: (id) => runtime.manager?.paperEntriesAllowed(id) ?? false,
    closeRequested: () => existsSync(join(closeDir, "close-dry")),
  });
  runtime.paper = paper;
  let liveExec: OkxExecutor | undefined;
  if (liveCfg && liveDb) {
    const liveBus = new EventBus(liveDb);
    liveExec = new OkxExecutor(cli, liveCfg.creds, false, (id) => feed.view().instruments.get(id), liveCfg.risk.maxLeverage);
    live = new Engine({
      cfg: liveCfg,
      db: liveDb,
      feed,
      jev,
      exec: liveExec,
      bus: liveBus,
      alerts,
      ids: LIVE_IDS,
      manageFeed: false,
      entriesAllowed: (id) => runtime.manager?.entriesAllowed(id) ?? false,
      portfolioLossStopPct: cfg.competition.portfolioDailyLossPct,
      closeRequested: () => existsSync(join(closeDir, "close-live")),
    });
  }

  const competition = new Competition({ db: paperDb, url: cfg.hive.url });
  const manager = new CompetitionManager({ db: paperDb, competition, paper, live, bus });
  runtime.manager = manager;
  manager.restoreProfiles();
  await paper.start();
  manager.restoreProfiles();
  if (live && liveDb && liveExec) {
    log.info("live account preflight passed", { preflight: await preflightLiveAccounts({ cfg: liveCfg!, db: liveDb, exec: liveExec, ids: LIVE_IDS }) });
    await live.start();
    // Engine state is loaded by start(); only now can legacy installs get an honest tracking baseline.
    manager.restoreProfiles();
  }
  await manager.start();
  competition.start();

  const updates = new UpdateCheck({ repo: cfg.update.repo, current: cfg.update.version, enabled: cfg.update.enabled });
  updates.start();
  const server = startServer({
    engine: {
      bus,
      db: paperDb,
      liveDb: liveDb ?? undefined,
      visitors: new Visitors(paperDb),
      snapshot: () => ({ ...paper.snapshot(), live: live?.snapshot() ?? null }),
      health: () => {
        const paperHealth = paper.health();
        const liveHealth = live?.health() ?? null;
        return { ...paperHealth, ok: paperHealth.ok && (liveHealth?.ok ?? true), reasons: [...paperHealth.reasons, ...(liveHealth?.reasons ?? [])], live: liveHealth };
      },
      update: () => updates.status(),
      competition: () => manager!.status(),
    },
    profile: () => publicProfile(paperCfg),
    beeImage: (fingerprint) => {
      const portrait = manager.portrait(fingerprint);
      return portrait ? new URL(portrait, cfg.hive.url) : null;
    },
  }, cfg.server.port, cfg.server.bind);

  const shutdown = async (sig: string) => {
    log.info("competition engine shutting down", { sig });
    manager?.stop();
    competition.stop();
    await Promise.all([paper.shutdown(), live?.shutdown()]);
    updates.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    liveDb?.close();
    paperDb.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

import { useEffect, useState } from "react";
import { BeeColumn } from "./BeeColumn";
import { Beekeeper } from "./Beekeeper";
import { CompetitionCard } from "./Competition";
import { Header } from "./Header";
import { unlockAudio } from "./sound";
import { Ticker } from "./Ticker";
import { Toasts } from "./Toasts";
import { BEE_META, BEE_NAMES, type BeeMeta, type BeeName, type CompetitionStrategy, type Installation, type PublicBee } from "./types";
import { type Curve, useFeed } from "./useFeed";

const r2 = (n: number) => Number(n.toFixed(2));

function sinceInstall(bee: PublicBee | undefined, install: Installation | undefined): PublicBee | undefined {
  if (!bee || !install) return bee;
  const pnlUsd = r2(bee.equityUsd - install.baselineEquityUsd);
  const sameDay = new Date().toISOString().slice(0, 10) === install.baselineDay;
  return {
    ...bee,
    pnlUsd,
    pnlPct: install.baselineEquityUsd > 0 ? r2((pnlUsd / install.baselineEquityUsd) * 100) : 0,
    tradesToday: Math.max(0, bee.tradesToday - (sameDay ? install.baselineTradesToday : 0)),
    feesTodayUsd: r2(Math.max(0, bee.feesTodayUsd - (sameDay ? install.baselineFeesTodayUsd : 0))),
    totals: {
      feesUsd: r2(bee.totals.feesUsd - install.baselineTotals.feesUsd),
      fundingUsd: r2(bee.totals.fundingUsd - install.baselineTotals.fundingUsd),
      jevUsd: Number((bee.totals.jevUsd - install.baselineTotals.jevUsd).toFixed(4)),
      realisedUsd: r2(bee.totals.realisedUsd - install.baselineTotals.realisedUsd),
      decisions: bee.totals.decisions - install.baselineTotals.decisions,
      orders: bee.totals.orders - install.baselineTotals.orders,
    },
  };
}

function installedCurve(curve: Curve | undefined, install: Installation | undefined, bee: PublicBee | undefined, now: number | undefined): Curve {
  if (!install) return [];
  const points: Curve = [[install.installedAt, install.baselineEquityUsd], ...(curve ?? []).filter(([ts]) => ts > install.installedAt)];
  if (bee && now && points[points.length - 1]?.[0] !== now) points.push([now, bee.equityUsd]);
  return points;
}

function readSoundPref(): boolean {
  try {
    return localStorage.getItem("bees.sound") === "on";
  } catch {
    return false;
  }
}

export function App() {
  const [soundOn, setSoundOn] = useState(false);
  const feed = useFeed(soundOn);
  const [, force] = useState(0);

  // Re-render every second so "ago" / flash windows expire even when the stream is quiet.
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Sound needs a click before the browser allows audio: one click anywhere turns on a saved preference.
  useEffect(() => {
    if (!readSoundPref()) return;
    const once = () => setSoundOn(unlockAudio());
    window.addEventListener("pointerdown", once, { once: true });
    return () => window.removeEventListener("pointerdown", once);
  }, []);

  const toggleSound = () => {
    const next = !soundOn && unlockAudio();
    setSoundOn(next);
    try {
      localStorage.setItem("bees.sound", next ? "on" : "off");
    } catch {
      /* private mode: fine */
    }
  };

  const competition = feed.snap?.competition;
  const visibleNames = competition ? competition.paper.map((row) => row.slot) : BEE_NAMES;
  const board = [...visibleNames].sort((a, b) => (feed.bees[b]?.equityUsd ?? 0) - (feed.bees[a]?.equityUsd ?? 0));
  const leaderEq = feed.bees[board[0]!]?.equityUsd ?? 0;
  const baseline = feed.snap?.startEquityUsd ?? 333;
  const stalled = feed.lastEventAt > 0 && Date.now() - feed.lastEventAt > 15_000;
  const blocked = feed.snap?.market.spreadBlocked ?? [];
  const strategyMeta = (slot: BeeName, strategy: CompetitionStrategy | undefined): BeeMeta => strategy ? {
    ...BEE_META[slot],
    title: strategy.name,
    short: strategy.name,
    tagline: strategy.tagline,
    styleLabel: strategy.style,
    rules: strategy.rules,
    coins: strategy.coins,
    img: `/bee-image/${strategy.fingerprint}`,
  } : BEE_META[slot];
  const paperMeta = (slot: BeeName) => strategyMeta(slot, competition?.paper.find((row) => row.slot === slot)?.strategy);
  const liveSlot = competition?.activeSlot;
  const liveStrategy = liveSlot ? competition?.champion ?? competition?.liveSlots[liveSlot] : undefined;
  const championStrategy = liveStrategy ?? competition?.champion ?? undefined;
  const championSlot = liveSlot ?? "bee1";
  const liveInstall = liveSlot ? competition?.liveInstalls[liveSlot] : undefined;
  const rawLiveBee = liveSlot ? feed.snap?.live?.bees.find((bee) => bee.bee === liveSlot) : undefined;
  const liveBee = liveInstall ? sinceInstall(rawLiveBee, liveInstall) : undefined;
  const liveCurve = installedCurve(liveSlot ? feed.liveCurves[liveSlot] : undefined, liveInstall, rawLiveBee, feed.snap?.live?.ts);

  return (
    <div className="app">
      <Header snap={feed.snap} focus={liveBee} focusStartedAt={liveInstall?.installedAt} connected={feed.connected} stalled={stalled} soundOn={soundOn} onSound={toggleSound} />
      <main className="command-grid">
        {championStrategy ? (
          <BeeColumn
            name={championSlot}
            bee={liveBee}
            curve={liveCurve}
            baseline={liveInstall?.baselineEquityUsd ?? feed.snap?.live?.startEquityUsd ?? baseline}
            rank={1}
            gap={null}
            flash={undefined}
            identity={strategyMeta(championSlot, championStrategy)}
            badge={liveBee ? "LIVE" : "CHAMPION"}
            chartId="live"
            variant="champion"
            installedAt={liveInstall?.installedAt}
          />
        ) : <section className="champion-empty"><span className="eyebrow">Live champion</span><strong>Collecting the first Hive winner</strong></section>}
        <aside className="paper-lab">
          <header className="paper-lab-head">
            <div><span className="eyebrow">Paper lab</span><strong>{visibleNames.length} challenger{visibleNames.length === 1 ? "" : "s"}</strong></div>
            <span className="dim">reset on assignment</span>
          </header>
          <Beekeeper keeper={feed.snap?.keeper} />
          <div className="paper-bees">
          {visibleNames.map((name) => {
            const row = competition?.paper.find((candidate) => candidate.slot === name);
            const install = row?.install;
            const rawBee = feed.bees[name];
            const bee = sinceInstall(rawBee, install);
          return (
            <BeeColumn
              key={name}
              name={name}
              bee={bee}
              curve={installedCurve(feed.curves[name], install, rawBee, feed.snap?.ts)}
              baseline={install?.baselineEquityUsd ?? baseline}
              rank={board.indexOf(name) + 1}
              gap={bee ? Math.max(0, leaderEq - bee.equityUsd) : null}
              flash={feed.flashes[name]}
              identity={paperMeta(name)}
              variant="compact"
              installedAt={install?.installedAt}
            />
          );
        })}
          </div>
          <CompetitionCard state={feed.snap?.competition} live={feed.snap?.live} decisions={feed.liveDecisions} events={feed.liveEvents} />
          <Ticker decisions={feed.decisions} perMin={feed.decisionTimes.length} />
          {blocked.length > 0 && (
            <section className="rail-card blocked">
              <span className="eyebrow">Spread gate says no</span>
              <div className="blocked-list num">
                {blocked.slice(0, 6).map((b) => (
                  <span key={b.coin}>
                    {b.coin} <span className="dim">{b.spreadBp}bp</span>
                  </span>
                ))}
              </div>
            </section>
          )}
        </aside>
      </main>
      <Toasts toasts={feed.toasts} keeper={feed.keeperToasts} />
    </div>
  );
}

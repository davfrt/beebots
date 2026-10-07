import type { AnyEvent, CompetitionStatus, DecisionEvent, Snapshot } from "./types";

const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;

export function CompetitionCard({ state, live, decisions = [], events = [] }: { state: CompetitionStatus | null | undefined; live?: Snapshot | null; decisions?: DecisionEvent[]; events?: AnyEvent[] }) {
  if (!state) return null;
  const next = new Date(state.nextSelectionAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return (
    <section className="rail-card competition-card">
      <div className="rail-head">
        <span className="eyebrow">Daily competition</span>
        <span className="dim">next {next} UTC</span>
      </div>
      {state.champion ? <p className="competition-result"><strong>{state.champion.name}</strong> won selection at <span className={state.champion.returnPct >= 0 ? "good num" : "bad num"}>{pct(state.champion.returnPct)}</span></p>
        : state.ranking[0] ? <p className="competition-result"><strong>{state.ranking[0].name}</strong> leads the Hive at <span className={state.ranking[0].returnPct >= 0 ? "good num" : "bad num"}>{pct(state.ranking[0].returnPct)}</span></p>
        : <p className="dim competition-empty">Collecting the first Hive snapshot.</p>}
      <div className="competition-note">{state.liveEnabled ? "LIVE · two isolated slots" : "PAPER · live keys disabled"} · {state.reason}</div>
      {live && (
        <div className="competition-live">
          {live.bees.map((b) => <span key={b.bee}>{b.bee.slice(-1)} · {state.liveSlots[b.bee]?.name ?? "unassigned"} · {b.position ? `${b.position.side} ${b.position.coin}${b.position.protected ? " protected" : " unprotected"}` : "flat"}</span>)}
          <span className={live.portfolioBreaker?.trippedAt ? "bad" : "dim"}>{live.portfolioBreaker?.trippedAt ? `${live.portfolioBreaker.lossStopPct}% breaker tripped` : `${live.portfolioBreaker?.lossStopPct ?? "?"}% breaker armed`}</span>
          {decisions[0] && <span>latest decision · {decisions[0].bee.slice(-1)} {decisions[0].action}</span>}
          {events[0] && <span>live history · {events.slice(0, 3).map((event) => event.type).join(" · ")}</span>}
        </div>
      )}
      {state.problem && <div className="competition-problem">Hive: {state.problem}</div>}
    </section>
  );
}

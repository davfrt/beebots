// Phase 6 smoke test on OKX DEMO (fake money) only: one minimum-size market round trip per bee.
// Uses the engine's own OkxExecutor (the code the bees will run). Refuses to use live keys.
// pnpm demo:roundtrip [COIN=XRP]   (the coin must exist on OKX demo; SOL and SUI do not)
import { BEES, type OkxCreds } from "../config.js";
import { OkxExecutor } from "../exec/executor.js";
import { formatSz } from "../exec/sizing.js";
import { createOkxCli } from "../okx/cli.js";
import { createPublicApi } from "../okx/public.js";
import { safeError } from "../redact.js";

const COIN = (process.argv[2] ?? "XRP").toUpperCase();
const env = process.env;
const creds: Partial<Record<(typeof BEES)[number], OkxCreds>> = {};
for (const b of BEES) {
  const p = b.toUpperCase();
  const k = env[`${p}_OKX_DEMO_API_KEY`], s = env[`${p}_OKX_DEMO_API_SECRET`], ph = env[`${p}_OKX_DEMO_API_PASSPHRASE`];
  if (!k || !s || !ph) throw new Error(`${p} demo key missing`);
  creds[b] = { apiKey: k, secretKey: s, passphrase: ph };
}

const cli = createOkxCli({ site: "eea", timeoutMs: 15_000, maxConcurrent: 2 });
const api = createPublicApi("https://eea.okx.com", true); // demo market: its own ids
const inst = (await api.instruments()).find((i) => i.coin === COIN && i.state === "live");
if (!inst) throw new Error(`no live ${COIN} X-Perp`);
const tick = (await api.tickers()).get(inst.instId)!;
console.log(`instrument ${inst.instId} · min ${inst.minSz} contract(s) ≈ $${(inst.minSz * inst.ctVal * tick.mid).toFixed(2)} · spread ${tick.spreadBp.toFixed(1)}bp\n`);

// demo = true is hard-wired: this executor can only send x-simulated-trading requests.
const exec = new OkxExecutor(cli, creds, true, (id) => (id === inst.instId ? inst : undefined), 2);
type Row = Record<string, string>;
const posRow = async (bee: (typeof BEES)[number]) =>
  (await cli.run<Row[]>({ args: ["futures", "positions", "--instId", inst.instId], bee, creds: creds[bee], demo: true })).find((r) => Number(r.pos) !== 0);
const cl = (bee: string, tag: string) => `${bee.slice(0, 2)}t${tag}${Date.now().toString(36)}`;
let problems = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`   ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) problems++;
};

for (const bee of BEES) {
  await new Promise((r) => setTimeout(r, 2000)); // bees may share one demo account: stay under its rate limit
  console.log(`— ${bee}`);
  try {
    await exec.init(bee);
    const [cfg] = await cli.run<Row[]>({ args: ["account", "config"], bee, creds: creds[bee], demo: true });
    ok(cfg?.posMode === "net_mode", `position mode ${cfg?.posMode}`);
    const before = await posRow(bee);
    if (before) {
      console.log(`   already holds ${before.pos} ${COIN}; skipping this bee so nothing is disturbed`);
      problems++;
      continue;
    }

    // Must be rejected: reduce-only while flat.
    const guard = await exec.market(bee, { instId: inst.instId, side: "sell", contracts: inst.minSz, reduceOnly: true, clOrdId: cl(bee, "g") });
    ok(!guard.ok, `reduce-only while flat is rejected${guard.ok ? " (IT FILLED: STOP)" : ` (${guard.error.code})`}`);
    if (guard.ok) break;

    // Same IOC price bound the engine uses (executor refuses unbounded opens).
    const limitPx = (await api.tickers()).get(inst.instId)!.ask * 1.005;
    const open = await exec.market(bee, { instId: inst.instId, side: "buy", contracts: inst.minSz, reduceOnly: false, clOrdId: cl(bee, "o"), limitPx });
    if (!open.ok) {
      ok(false, `open failed: ${open.error.code} ${open.error.message}`);
      continue;
    }
    ok(open.contracts === inst.minSz, `opened LONG ${formatSz(open.contracts, inst)} @ ${open.avgPx} · fee $${open.feeUsd.toFixed(6)}`);
    const pos = await posRow(bee);
    ok(!!pos && Number(pos.pos) === inst.minSz, `OKX position ${pos?.pos ?? "none"} contract(s)`);
    ok(pos?.mgnMode === "isolated", `margin mode ${pos?.mgnMode}`);
    ok(Number(pos?.lever) === 2, `leverage ${pos?.lever}x`);

    const stop = await exec.protect(bee, { instId: inst.instId, closeSide: "sell", contracts: inst.minSz, triggerPx: open.avgPx * 0.99 });
    if (!stop.ok || !stop.algoId) {
      ok(false, `native stop failed: ${stop.ok ? "no algo id" : `${stop.error.code} ${stop.error.message}`}`);
    } else {
      const placed = { instId: inst.instId, closeSide: "sell" as const, contracts: inst.minSz, triggerPx: stop.triggerPx, algoId: stop.algoId };
      ok(await exec.protectionMatches(bee, placed), "native reduce-only stop placed and verified");
      const amended = await exec.protect(bee, { ...placed, triggerPx: open.avgPx * 0.98 });
      if (!amended.ok || !amended.algoId) {
        ok(false, `native stop amendment failed: ${amended.ok ? "no algo id" : `${amended.error.code} ${amended.error.message}`}`);
      } else {
        const updated = { ...placed, triggerPx: amended.triggerPx, algoId: amended.algoId };
        ok(await exec.protectionMatches(bee, updated), "native stop amended and verified");
        ok(await exec.cancelProtection(bee, inst.instId, amended.algoId), "native stop cancelled before reduce-only close");
      }
    }

    const close = await exec.market(bee, { instId: inst.instId, side: "sell", contracts: inst.minSz, reduceOnly: true, clOrdId: cl(bee, "c") });
    if (!close.ok) {
      ok(false, `CLOSE FAILED ${close.error.code} ${close.error.message} (position left open on demo)`);
      continue;
    }
    const realised = (close.avgPx - open.avgPx) * inst.minSz * inst.ctVal;
    ok(true, `closed @ ${close.avgPx} · fee $${close.feeUsd.toFixed(6)} · realised $${realised.toFixed(6)}`);
    ok(!(await posRow(bee)) && !(await exec.pendingOrders(bee))?.length && !(await exec.conditionalOrders(bee))?.length, "flat again on OKX with nothing pending");

    // Reconciliation: our fees vs OKX fills, to the cent.
    const ids = new Set([open.ordId, close.ordId].filter((x): x is string => !!x));
    await new Promise((r) => setTimeout(r, 1500));
    const theirs = await exec.feesFor(bee, [inst.instId], ids);
    const ours = open.feeUsd + close.feeUsd;
    const theirSum = theirs ? [...theirs.values()].reduce((a, b) => a + b, 0) : NaN;
    ok(theirs !== null && theirs.size === ids.size && Math.abs(ours - theirSum) < 0.005, `fees ours $${ours.toFixed(6)} vs OKX fills $${theirSum.toFixed(6)}`);
  } catch (err) {
    const e = safeError(err);
    ok(false, `error ${e.code} ${e.message}`);
  }
}

// Unverified item: the kit's news module on EEA (read-only).
try {
  const r = await cli.run<Array<{ details?: Array<{ ccy: string; trend?: unknown[] }> }>>({ args: ["news", "coin-trend", "BTC", "--period", "1h", "--points", "24"], bee: "bee3", creds: creds.bee3, demo: true });
  const pts = r?.[0]?.details?.[0]?.trend?.length ?? 0;
  console.log(`\nnews module: ${pts > 0 ? `works on EEA (${pts} hourly points for BTC)` : "responded but returned no trend data"}`);
} catch (err) {
  const e = safeError(err);
  console.log(`\nnews module: unavailable (${e.code} ${e.message}); Momentum bees keep using volume z`);
}
console.log(problems ? `\n${problems} problem(s)` : "\nall round trips passed");
process.exit(problems ? 1 : 0);

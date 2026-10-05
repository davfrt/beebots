# Cost model (measured and read 2026-09-24)

Stake: **$1,000**, split **$333** per bee. Max notional per bee at 2x: **~$666**.

## 1. Jev

Price: **$0.042 per 1M input tokens, output free** (docs.typesafe.ai/models, and Vercel AI Gateway lists the same). Limits: 1,200 req/min, 250k tok/s.

Cost per day = `3 bees × (86,400,000 / TICK_MS) × tokens_per_call × $0.042 / 1e6`

| tick | tokens/call | decisions/min (all 3) | $/day | $/30 days |
|---|---|---|---|---|
| 1 s | 600 | 180 | $6.53 | $196 |
| 1 s | 800 | 180 | $8.71 | $261 |
| 2 s | 800 | 90 | $4.35 | $131 |
| 3 s | 800 | 60 | $2.90 | $87 |
| 5 s | 800 | 36 | $1.74 | $52 |
| 10 s | 800 | 18 | $0.87 | $26 |
| 30 s | 800 | 6 | $0.29 | $8.71 |
| 60 s | 600 | 3 | $0.11 | $3.27 |
| 60 s | 800 | 3 | $0.15 | $4.35 |

**Recommendation:** use `TICK_MS=60000`; `SAFETY_TICK_MS=10000` keeps deterministic exits responsive without paying for six mostly unchanged Jev calls per minute. The competition runtime can have five active strategies during a live handoff, giving a maximum model estimate of about $5.45-$7.25/month at this cadence. Actual use is lower when the rules do not need Jev.

## 2. OKX trading fees (X-Perps, EEA)

- **Maker 0.020% / taker 0.050%**, read off the EEA fee endpoint and corroborated by the PRIIPs KID (2026-09-23). Bees use market orders only, so **every fill is taker**.
- Round trip at notional N: `0.001 × N` in fees **plus the spread** (≈ spread_bp × N / 10,000).
- At full 2x (~$666): **~$0.67 fees per round trip** + spread.

Default budgets in `.env`:

| bee | typical size | max trades/day | fee budget/day | worst case/30 days |
|---|---|---|---|---|
| breezy | $10-$666, trend-scaled | ~1 | $0.50 | $15 |
| bizzy | ~$265 | 6 | $1.50 | $45 |
| boozy | $400-$666 | 8 | $3.00 (incl. spread) | $90 |
| **total** | | | **$5.00** | **$150 (15% of stake)** |

Budgets are hard caps in code. Once a bee spends its daily budget it can only hold or close until 00:00 UTC.

## 3. Funding

X-Perps charge continuous funding, settled at 00:00, 08:00 and 16:00 UTC, capped at ±0.75% per interval. On 2026-09-24 DOGE read 0.0100% per interval. It is roughly 4-6%/yr of notional for a long in a normal market, so **~$3-5/month per bee held at full 2x**. It can flip to a credit when funding goes negative, which is nice on screen.

## 4. Infra

| item | cost |
|---|---|
| Hostinger KVM 2 | $8.99/mo intro (24-month term), renews $14.99 |
| OKX account, sub-accounts, API, demo | free |
| Coinbase → OKX (USDC on Base) | cents |
| OKX → Coinbase (USDC on Arbitrum) | 0.0065 USDC (Base 0.042, **never Ethereum mainnet: 1.46**) |

## 5. Competition runtime

Model use is about $5.45-$7.25/month when all three paper slots and both live handoff slots continuously need Jev. Trading fees, spread and funding depend on the selected strategies and their turnover; they cannot be predicted from the Hive leaderboard.

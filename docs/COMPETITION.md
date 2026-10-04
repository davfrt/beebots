# Daily Hive competition

Set `COMPETITION_MODE=true` to enable the daily selector.

## What it does

- Reads every page of `HIVE_URL/hive/board` hourly. It never sends keys or local account data.
- Accepts copyable bots that are verified, not retired, seen within 24 hours, and have at least two trades.
- Fingerprints candidates with their rules, coins, release, and active risk policy. A release or policy change needs a fresh approval.
- On the first day, uses public week-to-date return. Afterwards it compares the complete previous UTC day's net return.
- Runs the next three strategies in the local paper engine for one day, then replaces the paper roster.
- Runs a candidate locally on paper for `COMPETITION_PAPER_OBSERVATION_HOURS` (24 by default). A public result never receives live authority on its own.
- Promotes only when the owner sets `COMPETITION_APPROVAL_FINGERPRINT` and `COMPETITION_APPROVAL_RELEASE` to the observed candidate and current `/snapshot` release. Rotation is locked for `COMPETITION_RESTRICTED_LIVE_HOURS` after promotion (24 by default).
- Keeps an old live position under its approved strategy while a separately approved challenger uses the other account.
- Stops and closes the combined live portfolio at a 1% UTC-day loss by default. Paper evaluation continues.

Returns already contain recorded fees, spread and funding. The selector does not charge them twice.

## Start on paper

```env
COMPETITION_MODE=true
DRY_RUN=true
TICK_MS=60000
SAFETY_TICK_MS=10000
TYPESAFE_API_KEY=...
```

This runs three paper candidates and shows the observed champion in the dashboard. Maximum Jev cost for the three
paper slots at the 60-second cadence is roughly $3.25-$4.40/month at the published model price; actual use is often
lower because rule-only holds do not call Jev.

## Enable live trading

Live mode needs two distinct OKX EEA sub-accounts. A sub-account is an isolated account under one OKX login, with
its own balance, positions and API key. Fund them 50/50 and create one Read + Trade key for each. Never grant
Withdraw or Transfer permission; bind live keys to the VPS IP.

```env
COMPETITION_MODE=true
DRY_RUN=false
MODE=live
LIVE_ACK=I-ACCEPT-REAL-MONEY-RISK
PORTFOLIO_DAILY_LOSS_PCT=1
COMPETITION_PAPER_OBSERVATION_HOURS=24
COMPETITION_RESTRICTED_LIVE_HOURS=24
# Copy the exact values from the candidate shown by /snapshot.
COMPETITION_APPROVAL_FINGERPRINT=...
COMPETITION_APPROVAL_RELEASE=...

BEE1_OKX_API_KEY=...
BEE1_OKX_API_SECRET=...
BEE1_OKX_API_PASSPHRASE=...
BEE2_OKX_API_KEY=...
BEE2_OKX_API_SECRET=...
BEE2_OKX_API_PASSPHRASE=...
```

Run `KEYCHECK_ONLY=live pnpm keycheck` from the VPS before live mode. The competition runtime requires two keys, not the
stock mode's three.

Every live position receives a reduce-only conditional stop at OKX. If placing or updating that stop fails, the
engine closes the position instead of leaving it unprotected. Software stops and the portfolio breaker still run
every 10 seconds.

OKX's default fee modeled by this project is 0.05% per market-order side. Actual fees depend on the account tier;
spread, funding and slippage are additional.

## Hosting

A Linux VPS with Docker is appropriate. Hostinger KVM 2 matches the upstream recommendation. Use a domain so Caddy
can provide HTTPS, enable automatic security updates, keep the nightly SQLite backup, and also copy backups off the
VPS. The API keys should be IP-bound to the VPS.

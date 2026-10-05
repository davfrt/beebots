# Configuration validation

The trading runtime validates configuration in `loadConfig()` before constructing exchange clients or starting a bee. These rules apply to dry, demo, and live modes; invalid settings raise `ConfigError` with setting names and constraints, never submitted values.

Blank or unset values keep their existing defaults. Booleans accept `true/false`, `1/0`, `yes/no`, or `on/off`, ignoring case and surrounding whitespace. Any other nonblank value is rejected.

All numbers must be finite, non-negative, and at most `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991). Narrower bounds are:

| Settings | Accepted range |
| --- | --- |
| `BEE_START_EQUITY_USD`, `JEV_USD_PER_MTOK`, `MAX_INITIAL_STOP_LOSS_USD` | Greater than zero |
| Each `*_STOP_ATR_MULT` | Greater than zero, at most 10 |
| `MAX_LEVERAGE` | Greater than zero, at most 2 |
| `DAILY_LOSS_STOP_PCT`, `PORTFOLIO_DAILY_LOSS_PCT` | Greater than zero, less than 100 |
| `BEE_RETIRE_AT_PCT` | Greater than zero, at most 100 (remaining starting equity, not loss percentage) |
| `LIVE_SIZE_MULTIPLIER`, `BREEZY_MIN_OPEN_PROB` | 0 through 1 |
| `BIZZY_SIZE_FRACTION` | Greater than zero, at most 1 |
| `TAKER_FEE_RATE` | 0 inclusive to 1 exclusive |
| Each `*_MAX_TRADES_PER_DAY` | Integer from 0 through 100 |
| Each `*_FEE_BUDGET_USD_DAY` | 0 through the configured daily-loss amount |
| `BIZZY_UNIVERSE_SIZE`, `BOOZY_CANDIDATES` | Positive integer |
| Each `*_SPREAD_GATE_BPS` | 0 through 100 |
| `JEV_TIMEOUT_MS` | Integer, 1 through 2,147,483,647 ms |
| `OKX_CLI_TIMEOUT_MS` | Integer, 1 through 2,147,481,647 ms (reserves the CLI's extra 2,000 ms) |
| `TICK_MS`, `SAFETY_TICK_MS` | Integer, 1,000 through 2,147,483,647 ms |
| `DATA_REFRESH_MS` | Integer, 15,000 through 2,147,483,647 ms |
| `ENGINE_PORT` | Integer, 1 through 65,535 |
| `MAX_FLAT_MINUTES` | 0 through `Number.MAX_SAFE_INTEGER / 60_000` |
| Each `*_COOLDOWN_MINUTES` | Greater than zero, at most `Number.MAX_SAFE_INTEGER / 60_000` |
| `BIZZY_TIME_STOP_MINUTES` | Greater than zero, at most `Number.MAX_SAFE_INTEGER / 60_000` |
| `LIVE_RAMP_HOURS` | Greater than zero, at most 168 |

Budget and trade-cap zeroes remain valid: they prevent new spending or entries. Zero max-flat retains the existing immediate-entry semantics. A zero live-size multiplier suppresses new exposure during the ramp.

The numeric ceilings prevent invalid domain values and runtime overflow; they are not recommended operating settings or proof that a risk budget is appropriate. Existing default values are unchanged. Cadences below their supported minimum now fail instead of being silently clamped, and Node's timer-overflow values are rejected rather than becoming approximately 1 ms timers.

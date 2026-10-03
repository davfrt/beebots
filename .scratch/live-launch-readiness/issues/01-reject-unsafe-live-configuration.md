# 01: Reject unsafe live configuration

**What to build:** Make startup reject ambiguous booleans and unsafe risk, sizing, cadence, cost, and server values before any live component or private exchange client starts.

**Blocked by:** None (can start immediately).

**Status:** completed

- [x] Unknown boolean strings fail validation instead of resolving false.
- [x] Every operational and risk number has an explicit finite safe range, including loss thresholds, retirement, live ramp, notional, starting equity, fees, trade limits, spread, stops, timeouts, cadences, and port.
- [x] The live-size multiplier cannot increase exposure above the normal limit.
- [x] Invalid configuration errors identify the setting without exposing secrets.
- [x] Dry, demo, and live defaults that are already safe remain unchanged.
- [x] Tests cover boundary values and representative typo/fail-open cases.

## Verification — 2026-10-03

- Added test-first regression coverage through `loadConfig()`; accepted ranges are documented in `docs/CONFIGURATION.md`.
- `node node_modules/typescript/bin/tsc --noEmit` — passed.
- `node node_modules/eslint/bin/eslint.js .` — passed.
- Configuration test files — 17 tests passed.
- Final full suite — 243 passed, 2 failed. The failures are the previously observed Windows `0600` file-mode assertions in the setup and Hive tests; this ticket does not change file permissions. Linux release verification is still required.
- Standards review: no findings. Spec review: OKX CLI timer allowance finding fixed and re-reviewed; no remaining findings.
- Existing unstaged competition changes and cadence defaults were preserved separately from this ticket's commit.

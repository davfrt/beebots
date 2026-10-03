import { describe, expect, it } from "vitest";
import { ConfigError, LIVE_ACK_PHRASE, loadConfig } from "../src/config.js";

const liveEnv: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "test-key", MODE: "live", DRY_RUN: "false", LIVE_ACK: LIVE_ACK_PHRASE };
for (const bee of ["BEE1", "BEE2", "BEE3"]) {
  for (const field of ["KEY", "SECRET", "PASSPHRASE"]) liveEnv[`${bee}_OKX_API_${field}`] = "test-credential";
}

describe("configuration validation before live startup", () => {
  it("rejects mistyped safety booleans even with complete live credentials", () => {
    for (const name of ["DRY_RUN", "ALLOW_NON_CRYPTO", "UPDATE_CHECK"]) {
      for (const value of ["treu", "flase", "2", "enabled"]) {
        expect(() => loadConfig({ ...liveEnv, [name]: value })).toThrow(new RegExp(name));
      }
    }
  });

  it("keeps explicit boolean aliases and blank defaults", () => {
    for (const value of ["1", " TRUE ", "yes", "On", "", "  ", undefined]) {
      expect(loadConfig({ ...liveEnv, DRY_RUN: value }).mode).toBe("dry");
    }
    for (const value of ["0", " FALSE ", "no", "Off"]) {
      expect(loadConfig({ ...liveEnv, DRY_RUN: value }).mode).toBe("live");
    }
  });

  it("rejects negative, non-finite, and numerically unsafe settings without exposing their values", () => {
    const names = ["JEV_DAILY_USD_CAP", "JEV_USD_PER_MTOK", "MAX_NOTIONAL_USD_PER_BEE", "MIN_24H_VOL_USD", "BREEZY_MIN_SIZE_USD", "LIVE_RAMP_HOURS"];
    for (const style of ["BIZZY", "BREEZY", "BOOZY"]) names.push(`${style}_FEE_BUDGET_USD_DAY`, `${style}_COOLDOWN_MINUTES`, `${style}_MAX_FLAT_MINUTES`);
    for (const name of names) {
      for (const value of ["-1", "NaN", "Infinity", "1e309", "9007199254740992", "secret-value"]) {
        let error: unknown;
        try { loadConfig({ ...liveEnv, [name]: value }); } catch (err) { error = err; }
        expect(error, `${name}=${value}`).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain(name);
        expect((error as Error).message).not.toContain("secret-value");
      }
    }
  });

  it("retains zero-valued budgets and cooldowns that safely disable spending or waiting", () => {
    const cfg = loadConfig({ ...liveEnv, JEV_DAILY_USD_CAP: "0", MAX_NOTIONAL_USD_PER_BEE: "0", BIZZY_FEE_BUDGET_USD_DAY: "0", BIZZY_COOLDOWN_MINUTES: "0" });
    expect(cfg.jev.dailyUsdCap).toBe(0);
    expect(cfg.risk.maxNotionalUsdPerBee).toBe(0);
    expect(cfg.bees.bizzy).toMatchObject({ feeBudgetUsdDay: 0, cooldownMinutes: 0 });
  });

  it("enforces the domain bounds of fractions, loss thresholds, counts, and stop distances", () => {
    const invalid: Record<string, string[]> = {
      BEE_START_EQUITY_USD: ["0"], MAX_LEVERAGE: ["0", "2.01"],
      DAILY_LOSS_STOP_PCT: ["0", "100", "101"], BEE_RETIRE_AT_PCT: ["0", "101"],
      LIVE_SIZE_MULTIPLIER: ["1.01"], BIZZY_SIZE_FRACTION: ["0", "1.01"],
      BREEZY_MIN_OPEN_PROB: ["1.01"], TAKER_FEE_RATE: ["1", "1.01"], JEV_USD_PER_MTOK: ["0"],
      BIZZY_UNIVERSE_SIZE: ["0", "1.5"], BOOZY_CANDIDATES: ["0", "1.5"], BIZZY_TIME_STOP_MINUTES: ["0"],
    };
    for (const style of ["BIZZY", "BREEZY", "BOOZY"]) {
      invalid[`${style}_MAX_TRADES_PER_DAY`] = ["1.5"];
      invalid[`${style}_SPREAD_GATE_BPS`] = ["10001"];
      invalid[`${style}_STOP_ATR_MULT`] = ["0"];
    }
    for (const [name, values] of Object.entries(invalid)) {
      for (const value of values) expect(() => loadConfig({ ...liveEnv, [name]: value }), `${name}=${value}`).toThrow(new RegExp(name));
    }
  });

  it("accepts safe boundaries without silently changing them", () => {
    const cfg = loadConfig({ ...liveEnv, LIVE_SIZE_MULTIPLIER: "0", MAX_LEVERAGE: "2", DAILY_LOSS_STOP_PCT: "0.01",
      BEE_RETIRE_AT_PCT: "100", BREEZY_MIN_OPEN_PROB: "1", BIZZY_SIZE_FRACTION: "1", TAKER_FEE_RATE: "0",
      BIZZY_UNIVERSE_SIZE: "1", BOOZY_CANDIDATES: "1", BIZZY_MAX_TRADES_PER_DAY: "0", BIZZY_SPREAD_GATE_BPS: "10000" });
    expect(cfg.risk).toMatchObject({ liveSizeMultiplier: 0, maxLeverage: 2, dailyLossStopPct: 0.01, retireAtPct: 100, takerFeeRate: 0 });
    expect(cfg.bizzy).toMatchObject({ sizeFraction: 1, universeSize: 1 });
    expect(cfg.boozy.candidates).toBe(1);
    expect(cfg.breezy.minOpenProb).toBe(1);
    expect(cfg.bees.bizzy).toMatchObject({ maxTradesPerDay: 0, spreadGateBps: 10000 });
    expect(loadConfig({ ...liveEnv, LIVE_SIZE_MULTIPLIER: "1" }).risk.liveSizeMultiplier).toBe(1);
  });

  it("rejects invalid ports, timer overflow, fractional timers, and cadences below the supported minimum", () => {
    const invalid: Record<string, string[]> = {
      ENGINE_PORT: ["0", "65536", "8080.5"],
      JEV_TIMEOUT_MS: ["0", "1.5", "2147483648"], OKX_CLI_TIMEOUT_MS: ["0", "1.5", "2147481648", "2147483647"],
      TICK_MS: ["0", "999", "1000.5", "2147483648"], DATA_REFRESH_MS: ["0", "14999", "15000.5", "2147483648"],
      LIVE_RAMP_HOURS: ["9007199254740991"], MAX_FLAT_MINUTES: ["9007199254740991"],
      BIZZY_TIME_STOP_MINUTES: ["9007199254740991"],
    };
    for (const style of ["BIZZY", "BREEZY", "BOOZY"]) {
      invalid[`${style}_COOLDOWN_MINUTES`] = ["9007199254740991"];
      invalid[`${style}_MAX_FLAT_MINUTES`] = ["9007199254740991"];
    }
    for (const [name, values] of Object.entries(invalid)) {
      for (const value of values) expect(() => loadConfig({ ...liveEnv, [name]: value }), `${name}=${value}`).toThrow(new RegExp(name));
    }
    const cfg = loadConfig({ ...liveEnv, ENGINE_PORT: "65535", JEV_TIMEOUT_MS: "1", OKX_CLI_TIMEOUT_MS: "2147481647", TICK_MS: "1000", DATA_REFRESH_MS: "15000" });
    expect(cfg.server.port).toBe(65535);
    expect(cfg.jev.timeoutMs).toBe(1);
    expect(cfg.okx.cliTimeoutMs).toBe(2147481647);
    expect(cfg.tickMs).toBe(1000);
    expect(cfg.dataRefreshMs).toBe(15000);
  });

  it("never includes submitted values in validation errors, including enum and literal errors", () => {
    for (const name of ["MODE", "LOG_LEVEL", "OKX_SITE", "MARGIN_MODE", "DRY_RUN", "JEV_TIMEOUT_MS"]) {
      let error: unknown;
      try { loadConfig({ ...liveEnv, [name]: "accidentally-pasted-secret" }); } catch (err) { error = err; }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain("accidentally-pasted-secret");
      expect((error as Error).message).not.toContain("test-credential");
    }
  });
});

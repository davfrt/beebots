import { afterEach, describe, expect, it, vi } from "vitest";
import { Alerts } from "../src/alerts.js";
import { LIVE_ACK_PHRASE, loadConfig } from "../src/config.js";

afterEach(() => vi.unstubAllGlobals());

describe("alerts", () => {
  it("retries a rejected delivery instead of deduplicating it", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("no", { status: 500 })).mockResolvedValueOnce(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const alerts = new Alerts("https://alerts.test/topic");

    await expect(alerts.send("exchange read failed", 1)).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the live destination available for startup validation", () => {
    const env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: "test", MODE: "live", DRY_RUN: "false", LIVE_ACK: LIVE_ACK_PHRASE };
    for (const bee of ["BEE1", "BEE2", "BEE3"]) for (const field of ["KEY", "SECRET", "PASSPHRASE"]) env[`${bee}_OKX_API_${field}`] = "test";
    expect(loadConfig(env).alertWebhookUrl).toBeUndefined();
    expect(loadConfig({ ...env, ALERT_WEBHOOK_URL: "https://alerts.test/topic" }).mode).toBe("live");
  });

  it("reports a dead-man heartbeat only to its separate monitor", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    const alerts = new Alerts("https://alerts.test/topic", "https://monitor.test/heartbeat");

    await expect(alerts.heartbeat(123)).resolves.toBe(true);

    expect(fetch).toHaveBeenCalledWith("https://monitor.test/heartbeat", expect.objectContaining({ method: "POST" }));
  });
});

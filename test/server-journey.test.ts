import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { startServer, type ServerDeps } from "../src/server.js";
import { Visitors } from "../src/visitors.js";

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("public server journey", () => {
  it("serves state, competition visibility, a redacted SSE event, and rejects writes", async () => {
    const db = new Db(":memory:");
    const bus = new EventBus(db);
    const deps: ServerDeps = {
      engine: {
        bus, db, visitors: new Visitors(db), snapshot: () => ({ bees: [] }), health: () => ({ ok: true }),
        competition: () => ({ live: { enabled: true, state: "running" } }),
      },
      profile: () => ({ bees: [] }), beeImage: () => null,
    };
    const server = startServer(deps, 0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ ok: true });
    expect(await (await fetch(`${base}/snapshot`)).json()).toMatchObject({ competition: { live: { state: "running" } } });
    expect(await (await fetch(`${base}/profile`)).json()).toEqual({ bees: [] });
    expect(await (await fetch(`${base}/visit`)).json()).toMatchObject({ total: 1 });
    expect(await (await fetch(`${base}/history`)).json()).toEqual([]);
    expect((await fetch(`${base}/equity`)).status).toBe(200);
    expect((await fetch(`${base}/bee-image/missing`)).status).toBe(404);
    expect((await fetch(`${base}/snapshot`, { method: "POST" })).status).toBe(405);

    const events = await fetch(`${base}/events`);
    const reader = events.body!.getReader();
    await reader.read(); // SSE retry preamble
    bus.emit("status", { token: "secret", state: "ready" });
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('"state":"ready"');
    expect(new TextDecoder().decode(value)).not.toContain("secret");
    await reader.cancel();
  });
});

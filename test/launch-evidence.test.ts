import { describe, expect, it } from "vitest";
import { buildLaunchEvidence, LaunchEvidenceSchema, REQUIRED_LAUNCH_GATES, type LaunchEvidenceInput } from "../src/launch-evidence.js";

const complete = (): LaunchEvidenceInput => ({
  release: "v2026.10.04",
  manifest: "evidence/release.env",
  images: {
    engine: "ghcr.io/acme/engine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    web: "ghcr.io/acme/web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    backup: "ghcr.io/acme/backup@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  },
  gates: REQUIRED_LAUNCH_GATES.map((gate) => ({ gate, status: "pass" as const, reference: `evidence/${gate}.log`, command: "redacted command", startedAt: "2026-10-04T12:00:00.000Z", finishedAt: "2026-10-04T12:01:00.000Z", output: "passed" })),
});

describe("launch evidence", () => {
  it("returns GO only when every required gate passed on immutable images", () => {
    const packet = buildLaunchEvidence(complete(), "2026-10-04T13:00:00.000Z");

    expect(packet.result).toBe("GO");
    expect(packet.missingGates).toEqual([]);
    expect(packet.markdown).toContain("Safety readiness does not establish profitability or prevent loss.");
  });

  it("fails closed for a skipped gate and redacts supplied output", () => {
    const input = complete();
    const index = input.gates.findIndex(({ gate }) => gate === "okx-demo-minimum-open");
    input.gates[index] = { ...input.gates[index]!, status: "skipped", output: "token=super-secret-value ip=203.0.113.42" };
    const packet = buildLaunchEvidence(input, "2026-10-04T13:00:00.000Z");

    expect(packet.result).toBe("NO-GO");
    expect(packet.failedGates).toEqual(["okx-demo-minimum-open"]);
    expect(packet.markdown).not.toContain("super-secret-value");
    expect(packet.markdown).not.toContain("203.0.113.42");
  });

  it("fails closed when a gate is absent or an image is mutable", () => {
    const input = complete();
    input.images.engine = "ghcr.io/acme/engine:latest";
    input.gates.pop();
    const packet = buildLaunchEvidence(input, "2026-10-04T13:00:00.000Z");

    expect(packet.result).toBe("NO-GO");
    expect(packet.missingGates).toEqual(["competition-promotion"]);
    expect(packet.releaseProblems).toEqual(["engine image is not digest-pinned"]);
  });

  it("rejects malformed operator input before making a packet", () => {
    const input = complete() as unknown as { gates: Array<Record<string, unknown>> };
    delete input.gates[0]!.output;

    expect(() => LaunchEvidenceSchema.parse(input)).toThrow("output");
  });

  it("fails closed when a passing gate has no recorded output", () => {
    const input = complete();
    input.gates[0] = { ...input.gates[0]!, output: "" };

    expect(buildLaunchEvidence(input).result).toBe("NO-GO");
  });
});

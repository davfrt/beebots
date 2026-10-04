import { redactString } from "./redact.js";
import { z } from "zod";

export const REQUIRED_LAUNCH_GATES = [
  "immutable-release",
  "linux-ci",
  "container-smoke",
  "fake-exchange-journeys",
  "okx-demo-minimum-open",
  "okx-demo-native-stop-place-verify",
  "okx-demo-native-stop-amend",
  "okx-demo-native-stop-cancel",
  "okx-demo-reduce-only-close",
  "okx-demo-fee-fill",
  "okx-demo-final-flat",
  "live-preflight-accounts",
  "live-preflight-equity",
  "live-preflight-flatness",
  "restart-during-exchange-work",
  "stale-data",
  "exchange-read-failure",
  "alert-rejection",
  "host-loss",
  "emergency-flatten",
  "rollback",
  "restore",
  "competition-promotion",
] as const;

export type LaunchGate = (typeof REQUIRED_LAUNCH_GATES)[number];
const GATE_STATUSES = ["pass", "fail", "skipped", "unresolved", "flaky"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

const GateEvidenceSchema = z.object({
  gate: z.enum(REQUIRED_LAUNCH_GATES as unknown as [LaunchGate, ...LaunchGate[]]),
  status: z.enum(GATE_STATUSES),
  reference: z.string(),
  command: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  output: z.string(),
});

export const LaunchEvidenceSchema = z.object({
  release: z.string(),
  manifest: z.string(),
  images: z.object({ engine: z.string(), web: z.string(), backup: z.string() }),
  gates: z.array(GateEvidenceSchema),
});

export type GateEvidence = z.infer<typeof GateEvidenceSchema>;
export type LaunchEvidenceInput = z.infer<typeof LaunchEvidenceSchema>;

export interface LaunchEvidencePacket {
  result: "GO" | "NO-GO";
  missingGates: LaunchGate[];
  failedGates: LaunchGate[];
  releaseProblems: string[];
  markdown: string;
}

/** Builds the reviewable packet. Missing, skipped, flaky, unresolved, or failed evidence is always NO-GO. */
export function buildLaunchEvidence(input: LaunchEvidenceInput, generatedAt = new Date().toISOString()): LaunchEvidencePacket {
  const records = new Map(input.gates.map((record) => [record.gate, record]));
  const missingGates = REQUIRED_LAUNCH_GATES.filter((gate) => !records.has(gate));
  const failedGates = REQUIRED_LAUNCH_GATES.filter((gate) => {
    const record = records.get(gate);
    return !missingGates.includes(gate) && (!record || record.status !== "pass" || !record.reference.trim() || !record.command.trim() || !record.startedAt.trim() || !record.finishedAt.trim() || !record.output.trim() || input.gates.filter((candidate) => candidate.gate === gate).length !== 1);
  });
  const releaseProblems = [
    ...(input.release.trim() ? [] : ["release identity is missing"]),
    ...(input.manifest.trim() ? [] : ["release manifest reference is missing"]),
    ...Object.entries(input.images).flatMap(([role, image]) => /@sha256:[a-f0-9]{64}$/i.test(image) ? [] : [`${role} image is not digest-pinned`]),
  ];
  const result = !missingGates.length && !failedGates.length && !releaseProblems.length ? "GO" : "NO-GO";
  const rows = REQUIRED_LAUNCH_GATES.map((gate) => {
    const record = records.get(gate);
    return record
      ? `| ${gate} | ${record.status.toUpperCase()} | ${cell(record.reference)} | ${cell(record.command)} | ${cell(`${record.startedAt} to ${record.finishedAt}`)} |`
      : `| ${gate} | MISSING | - | - | - |`;
  });
  const outputs = REQUIRED_LAUNCH_GATES.flatMap((gate) => {
    const record = records.get(gate);
    return record ? [`## ${gate} output\n\`\`\`text\n${redactString(record.output)}\n\`\`\``] : [];
  });
  const markdown = [
    "# Pre-live go/no-go evidence",
    "",
    `Generated: ${generatedAt}`,
    `Release: ${cell(input.release)}`,
    `Manifest: ${cell(input.manifest)}`,
    `Result: **${result}**`,
    "",
    "Safety readiness does not establish profitability or prevent loss.",
    "",
    "| Gate | Result | Evidence | Command | Time |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    ...(releaseProblems.length ? ["", "## Release problems", ...releaseProblems.map((problem) => `- ${problem}`)] : []),
    ...(missingGates.length ? ["", `Missing gates: ${missingGates.join(", ")}`] : []),
    ...(failedGates.length ? ["", `Non-passing gates: ${failedGates.join(", ")}`] : []),
    ...outputs.flatMap((output) => ["", output]),
    "",
  ].join("\n");
  return { result, missingGates, failedGates, releaseProblems, markdown };
}

function cell(value: string): string {
  return redactString(value).replace(/[|\r\n]/g, " ");
}

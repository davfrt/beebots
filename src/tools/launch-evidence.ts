import { readFile, writeFile } from "node:fs/promises";
import { buildLaunchEvidence, LaunchEvidenceSchema } from "../launch-evidence.js";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("usage: pnpm launch:evidence evidence.json evidence.md");

const input = LaunchEvidenceSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
const packet = buildLaunchEvidence(input);
await writeFile(outputPath, packet.markdown);
console.log(`${packet.result}: ${outputPath}`);
process.exitCode = packet.result === "GO" ? 0 : 1;

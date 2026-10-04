import { readFileSync } from "node:fs";

/** The backup sidecar atomically replaces this file only after remote upload succeeds. */
export function backupHealth(path: string, now = Date.now(), maxAgeMs = 26 * 60 * 60_000): string | null {
  try {
    const status = JSON.parse(readFileSync(path, "utf8")) as { ok?: unknown; completedAt?: unknown; error?: unknown };
    if (status.ok !== true) return `backup failed: ${typeof status.error === "string" ? status.error : "unknown error"}`;
    if (typeof status.completedAt !== "number" || !Number.isFinite(status.completedAt) || status.completedAt > now || now - status.completedAt > maxAgeMs) return "backup stale";
    return null;
  } catch {
    return "backup status missing";
  }
}

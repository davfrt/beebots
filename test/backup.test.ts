import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backupHealth } from "../src/backup.js";

describe("backup health", () => {
  it("rejects a missing, failed, or stale backup status", () => {
    const path = join(mkdtempSync(join(tmpdir(), "beebots-backup-")), "status.json");
    expect(backupHealth(path, 100, 10)).toEqual("backup status missing");
    writeFileSync(path, JSON.stringify({ ok: false, completedAt: 100, error: "upload failed" }));
    expect(backupHealth(path, 100, 10)).toEqual("backup failed: upload failed");
    writeFileSync(path, JSON.stringify({ ok: true, completedAt: 89 }));
    expect(backupHealth(path, 100, 10)).toEqual("backup stale");
    writeFileSync(path, JSON.stringify({ ok: true, completedAt: 101 }));
    expect(backupHealth(path, 100, 10)).toEqual("backup stale");
    writeFileSync(path, JSON.stringify({ ok: true, completedAt: 90 }));
    expect(backupHealth(path, 100, 10)).toBeNull();
  });
});

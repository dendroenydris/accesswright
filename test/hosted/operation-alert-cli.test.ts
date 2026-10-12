import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { defaults } from "../../src/config.js";
import { runOperationAlertCli } from "../../src/hosted/operation-alert-cli.js";

it("reads bounded metadata offline without changing inputs, accessing network or displaying private schema errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "accesswright-alert-preview-"));
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No cloud calls allowed"));
  try {
    const snapshot = join(root, "snapshot.json"), policy = join(root, "policy.json");
    const raw = JSON.stringify({ schemaVersion: 1, day: "2026-10-12", observedAt: "2026-10-13T08:00:00.000Z", complete: { jobs: false, calls: false }, jobs: [], calls: [] });
    await writeFile(snapshot, raw);
    await writeFile(policy, JSON.stringify({ failureRate: 0.2, dailyCostUsd: 1, p95DurationMs: 1000, minimumCompletedJobs: 1 }));
    const args = ["--snapshot", snapshot, "--policy", policy];
    expect((await runOperationAlertCli(args)).alerts.dailyCostUsd).toBe("insufficient-data");
    expect(await readFile(snapshot, "utf8")).toBe(raw);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(runOperationAlertCli(["--snapshot", "relative.json", "--policy", policy])).rejects.toThrow(/absolute/);
    await expect(runOperationAlertCli(["--snapshot", snapshot, "--snapshot", snapshot])).rejects.toThrow(/Expected/);
    await expect(runOperationAlertCli(["--snapshot", root, "--policy", policy])).rejects.toThrow(/regular/);
    const alias = join(root, "alias.json");
    await symlink(snapshot, alias);
    await expect(runOperationAlertCli(["--snapshot", alias, "--policy", policy])).rejects.toThrow();
    await writeFile(snapshot, " ".repeat(defaults.operationInputMaxBytes + 1));
    await expect(runOperationAlertCli(args)).rejects.toThrow(/bounded/);
    await writeFile(snapshot, "{invalid-json");
    await expect(runOperationAlertCli(args)).rejects.toThrow();
  } finally { fetcher.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { recordPrivateScan } from "../../src/runner/evidence-retention.js";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";

it("retains actual parsed observations only after explicit private-evidence opt-in", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-scan-evidence-"));
  const page = BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", violations: [], incomplete: [], aria: [], ariaTree: "private page fact", probeFailures: [], probeUnavailable: [], contexts: [], screenshot: "page.png", darkMediaDetected: false });
  try {
    await recordPrivateScan(root, "baseline", [page], false);
    expect(await readdir(root)).toEqual([]);
    await recordPrivateScan(root, "baseline", [page], true);
    expect(JSON.parse(await readFile(join(root, "baseline-observations.json"), "utf8"))).toEqual([page]);
    await expect(recordPrivateScan(root, "baseline", [page], true)).rejects.toThrow();
    await expect(recordPrivateScan(root, "../escape", [page], true)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { parseGermanEvidenceArgs, runGermanEvidenceCli } from "../../src/reporter/evidence-cli-de.js";

it("parses explicit German evidence paths and rejects unsafe/incomplete switches", () => {
  expect(parseGermanEvidenceArgs(["--report", "/tmp/report.json", "--commits", "/tmp/commits.json", "--out", "/tmp/evidence.md"]))
    .toEqual({ report: "/tmp/report.json", commits: "/tmp/commits.json", out: "/tmp/evidence.md" });
  expect(() => parseGermanEvidenceArgs(["--report", "/tmp/report.json"])).toThrow(/commits|out/i);
  expect(() => parseGermanEvidenceArgs(["--report", "relative.json", "--commits", "/tmp/c", "--out", "/tmp/o"])).toThrow(/absolute/i);
  expect(() => parseGermanEvidenceArgs(["--report", "/tmp/r", "--report", "/tmp/r", "--commits", "/tmp/c", "--out", "/tmp/o"])).toThrow(/duplicate/i);
});

it("renders an owned German report file once, with private permissions, without overwriting", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-de-report-cli-"));
  try {
    const input = join(root, "report.json"), commits = join(root, "commits.json"), output = join(root, "beleg.md");
    const report = {
      schemaVersion: 1,
      startedAt: "2026-10-07T07:00:00.000Z", finishedAt: "2026-10-07T07:00:01.000Z",
      durationMs: 1000, status: "verified", applied: false,
      fixed: 0, rejected: 0, needsHuman: 0, ignored: 0, attempts: 0,
      providerVerification: "not-run", unknownUsage: false,
      usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 },
      checks: [], outcomes: [], final: { acceptedFixIds: [], droppedFixIds: [], failures: [] },
    };
    await writeFile(input, JSON.stringify(report));
    await writeFile(commits, "[]");
    const result = await runGermanEvidenceCli(["--report", input, "--commits", commits, "--out", output]);
    expect(result).toBe(output);
    const text = await readFile(output, "utf8");
    expect(text).toContain("Technischer Barrierefreiheits-Prüfbericht");
    expect(text).toContain("kein Konformitätsnachweis");
    expect(text).toContain("nicht erfasst");
    expect((await stat(output)).mode & 0o077).toBe(0);
    await expect(runGermanEvidenceCli(["--report", input, "--commits", commits, "--out", output])).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

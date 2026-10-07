import { describe, expect, it } from "vitest";
import { makeRunReport, renderPullRequestReport } from "../../src/reporter/report.js";
import type { RepairResult } from "../../src/core/repair.js";

const result: RepairResult = { status: "verified", fixed: 1, rejected: 1, needsHuman: 2, ignored: 0, attempts: 2,
  patch: { taskId: "verified-run", changes: [{ path: "components/Button.tsx", before: "private before", after: "private after" }] },
  final: { acceptedFixIds: ["accepted"], droppedFixIds: ["dropped"], failures: [] },
  outcomes: [{ id: "accepted", ruleId: "button-name", criterion: "4.1.2", route: "llm", status: "verified", reason: null }] };

describe("review reports", () => {
  it("reports exact verification levels and unavailable checks without retaining private source", () => {
    const report = makeRunReport({ result, startedAt: "2026-10-07T00:00:00.000Z", finishedAt: "2026-10-07T00:00:10.000Z", applied: true,
      checks: [{ check: "lint", argv: [], available: false, status: "unavailable", durationMs: 0, exitCode: null, failureIds: [] }],
      usage: { inputTokens: 100, outputTokens: 20, spentUsd: 0.0001 }, providerVerification: "fake-provider" });
    expect(JSON.stringify(report)).not.toContain("private before");
    expect(JSON.stringify(report)).not.toContain("private after");
    expect(report).toMatchObject({ fixed: 1, rejected: 1, needsHuman: 2, providerVerification: "fake-provider", checks: [{ status: "unavailable" }] });
    const text = renderPullRequestReport(report);
    expect(text).toContain("4.1.2");
    expect(text).toContain("9.4.1.2");
    expect(text).toContain("EN 301 549 V3.2.1");
    expect(text).not.toContain("presumption of conformity");
    expect(text).toContain("unavailable");
    expect(text).toContain("Not a legal compliance certification");
    expect(text).toContain("Human review");
  });
  it("never labels a paid-request attempt as a passed live validation", () => {
    const report = makeRunReport({ result: { ...result, status: "blocked", fixed: 0, patch: null }, startedAt: "2026-10-07T00:00:00.000Z", finishedAt: "2026-10-07T00:00:10.000Z", applied: false, checks: [], usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 }, providerVerification: "not-run" });
    expect(renderPullRequestReport(report)).not.toContain("live validated");
    expect(report.status).toBe("blocked");
  });
});

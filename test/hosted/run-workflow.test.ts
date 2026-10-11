import { expect, it } from "vitest";

import { HostedRunWorkflow, InMemoryHostedRunStore } from "../../src/hosted/run-workflow.js";
import type { RunReport } from "../../src/reporter/report.js";

const makeReport = (): RunReport => ({
  schemaVersion: 1,
  startedAt: "2026-10-09T01:00:00.000Z", finishedAt: "2026-10-09T01:01:00.000Z",
  durationMs: 60_000, status: "verified", applied: false,
  fixed: 1, rejected: 0, needsHuman: 0, ignored: 0, attempts: 1,
  providerVerification: "not-run", unknownUsage: false,
  usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 },
  checks: ["build", "typecheck", "lint", "tests"].map(check => ({
    check: check as "build" | "typecheck" | "lint" | "tests",
    available: true, status: "passed" as const, durationMs: 100,
    exitCode: 0, failureIds: [],
  })),
  outcomes: [{ id: "fix-1", ruleId: "button-name", criterion: "4.1.2", route: "llm", status: "verified", reason: null }],
  final: { acceptedFixIds: ["fix-1"], droppedFixIds: [], failures: [] },
});

function harness() {
  const runStore = new InMemoryHostedRunStore();
  let checks = 0;
  let authorized = true;
  const workflow = new HostedRunWorkflow({
    store: runStore,
    authenticate: (runId, token) => {
      if (runId !== "run1" || token !== "fixture-token") throw new Error("Run authorization failed");
      return { runId: "run1", repository: "owner/private", installationId: 42 };
    },
    verifyTrustedResult: (_runId, digest) => {
      checks++;
      return Promise.resolve(authorized ? { reportDigest: digest, verifiedBaseSha: "a".repeat(40) } : null);
    },
  });
  return { workflow, runStore, get checks() { return checks; }, setAuthorized(v: boolean) { authorized = v; } };
}

it("records only aggregate metadata; rejects client-claimed verification until independently checked", async () => {
  const h = harness();
  const report = makeReport();
  expect(await h.workflow.submitResults("run1", "fixture-token", report)).toMatchObject({ status: "recorded" });
  const stored = h.runStore.get("run1");
  expect(stored).toBeDefined();
  expect(JSON.stringify(stored)).not.toContain("private-source");
  expect(JSON.stringify(stored)).not.toContain("Save changes");
  expect(stored).toMatchObject({ repository: "owner/private", status: "recorded", acceptedFixes: 1 });
  h.setAuthorized(false);
  expect(await h.workflow.finish("run1", "fixture-token")).toMatchObject({ status: "blocked" });
  expect(h.checks).toBe(1);
  expect(h.runStore.get("run1")?.status).toBe("blocked");
});

it("returns ready-for-operator-review only with independent matching trusted verifier proof", async () => {
  const h = harness();
  const report = makeReport();
  await h.workflow.submitResults("run1", "fixture-token", report);
  expect(await h.workflow.finish("run1", "fixture-token")).toMatchObject({
    status: "ready-for-review", verifiedBaseSha: "a".repeat(40),
  });
  expect(await h.workflow.finish("run1", "fixture-token")).toMatchObject({ status: "ready-for-review" });
  expect(h.checks).toBe(1);
});

it("never accepts incomplete production checks, unknown provider usage, or a mismatched accepted-fix set", async () => {
  for (const mutate of [
    (x: RunReport) => { x.checks[3].status = "unavailable"; x.checks[3].available = false; },
    (x: RunReport) => { x.unknownUsage = true; },
    (x: RunReport) => { x.final.acceptedFixIds = ["ghost"]; },
    (x: RunReport) => { x.final.failures.push({ check: "violations", id: "new-violation" }); },
    (x: RunReport) => { x.checks[0].exitCode = 1; },
    (x: RunReport) => { x.checks[0].failureIds = ["contradictory-build-failure"]; },
    (x: RunReport) => { x.fixed = 2; },
    (x: RunReport) => { x.outcomes.push({ ...x.outcomes[0] }); },
  ]) {
    const h = harness();
    const report = makeReport();
    mutate(report);
    expect(await h.workflow.submitResults("run1", "fixture-token", report)).toMatchObject({ status: "recorded" });
    expect(await h.workflow.finish("run1", "fixture-token")).toMatchObject({ status: "blocked" });
    expect(h.checks).toBe(0);
  }
});

it("rejects replayed report changes and unauthorized run tokens before metadata mutation", async () => {
  const h = harness();
  await expect(h.workflow.submitResults("run1", "invalid", makeReport())).rejects.toThrow(/authorization/);
  expect(h.runStore.get("run1")).toBeUndefined();
  await h.workflow.submitResults("run1", "fixture-token", makeReport());
  expect(await h.workflow.submitResults("run1", "fixture-token", makeReport())).toMatchObject({ status: "recorded" });
  const changed = makeReport(); changed.fixed = 2;
  await expect(h.workflow.submitResults("run1", "fixture-token", changed)).rejects.toThrow(/conflict|changed/i);
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runRepair } from "../../src/core/repair.js";
import type { SemanticRepair } from "../../src/core/repair.js";
import { gatherRepairContext } from "../../src/llm/gather-context.js";
import { EphemeralRepairSession } from "../../src/runner/ephemeral-repair-session.js";
import { AccesswrightConfigSchema, FixTaskSchema, PatchSchema } from "../../src/types/schemas.js";
import { createHostedSemanticRepair, runHostedWorker } from "../../src/hosted/worker.js";
import type { HostedAgentClient } from "../../src/hosted/agent-client.js";

vi.mock("../../src/llm/gather-context.js", () => ({ gatherRepairContext: vi.fn() }));
vi.mock("../../src/core/repair.js", () => ({ runRepair: vi.fn() }));
const task = FixTaskSchema.parse({ id: "fixture", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm",
  source: { file: "components/Button.tsx", line: 1, column: 1 }, routes: ["/"], violations: [{ ruleId: "button-name", route: "/", impact: "serious", target: ["#save"],
    html: "<button></button>", failureSummary: "No name", condition: "desktop-light", source: { file: "components/Button.tsx", line: 1, column: 1 } }] });
const patch = PatchSchema.parse({ taskId: task.id, changes: [{ path: "components/Button.tsx", before: "before", after: "after" }] });
const usage = { inputTokens: 300, outputTokens: 100, costUsd: 0.0005 };
const context = { component: { file: "components/Button.tsx", line: 1, column: 1, sourceExcerpt: "private-source-marker" }, callSites: [],
  page: { title: "Fixture", surroundingText: "Save changes", caption: null, linkTarget: null }, screenshotPath: null };
const images = [{ data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: "image/png" as const }];
let root: string;
let session: EphemeralRepairSession;
let events: string[];
let client: { patch: ReturnType<typeof vi.fn<HostedAgentClient["patch"]>> };
let verify: ReturnType<typeof vi.fn<Parameters<SemanticRepair>[1]>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-hosted-worker-"));
  events = [];
  session = { sourceRoot: root, evidenceDir: root, observations: [], productionBaseline: [], finalObservations: [], baselineObservations: [],
    config: AccesswrightConfigSchema.parse({}),
    finalChecks: ["build", "typecheck", "lint", "tests"].map(check => ({ check, argv: [], available: true, status: "passed", exitCode: 0, durationMs: 1, failureIds: [] })),
    journal: { exportPatches: vi.fn().mockResolvedValue([patch]) },
    close: vi.fn(() => { events.push("close"); return Promise.resolve(); }),
  } as unknown as EphemeralRepairSession;
  vi.spyOn(EphemeralRepairSession, "prepare").mockResolvedValue(session);
  vi.mocked(gatherRepairContext).mockResolvedValue({ context, images });
  client = { patch: vi.fn<HostedAgentClient["patch"]>().mockResolvedValue({ status: "accepted", patch, usage }) };
  verify = vi.fn<Parameters<SemanticRepair>[1]>().mockResolvedValue({ accepted: true, check: "ok", reason: null });
  vi.mocked(runRepair).mockResolvedValue({ status: "verified", fixed: 1, rejected: 0, needsHuman: 0, ignored: 0, attempts: 1, patch,
    outcomes: [{ id: task.id, ruleId: task.ruleId, criterion: task.criterion, route: task.route, status: "verified", reason: null }],
    final: { acceptedFixIds: [task.id], droppedFixIds: [], failures: [] } });
});
afterEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });

it("sends real image bytes, verifies every accepted proposal and records metadata without source", async () => {
  const remote = createHostedSemanticRepair({ session, client, providerVerification: "fake-provider" });
  expect(await remote.repair(task, verify)).toEqual({ status: "accepted" });
  expect(client.patch).toHaveBeenCalledWith(task, context, images, null);
  expect(verify).toHaveBeenCalledExactlyOnceWith(patch);
  expect(remote.accounting()).toEqual({ usage: { inputTokens: 300, outputTokens: 100, spentUsd: 0.0005 }, unknownUsage: false, providerVerification: "fake-provider" });
  const log = await readFile(join(root, "run.jsonl"), "utf8");
  expect(log).toContain('"step":"hosted-model"');
  expect(log).not.toContain("private-source-marker");
  expect(log).not.toContain("Save changes");
});
it("retries a known schema rejection and a verifier rejection with bounded feedback", async () => {
  client.patch.mockResolvedValueOnce({ status: "rejected", reason: "patch-validation-failed", usage });
  verify.mockResolvedValueOnce({ accepted: false, check: "aria-tree", reason: "hiding forbidden" });
  const remote = createHostedSemanticRepair({ session, client, providerVerification: "provider-api" });
  expect(await remote.repair(task, verify)).toEqual({ status: "accepted" });
  expect(client.patch).toHaveBeenNthCalledWith(2, task, context, images, "patch-validation-failed");
  expect(client.patch).toHaveBeenNthCalledWith(3, task, context, images, "rule=button-name; check=aria-tree; reason=hiding forbidden");
  expect(verify).toHaveBeenCalledTimes(2);
  expect(remote.accounting()).toMatchObject({ usage: { inputTokens: 900, outputTokens: 300, spentUsd: 0.0015 }, providerVerification: "provider-api" });
});
it("never retries an unknown response or calls another semantic task afterward", async () => {
  client.patch.mockResolvedValueOnce({ status: "rejected", reason: "agent-response-unreconciled", usage: null });
  const remote = createHostedSemanticRepair({ session, client, providerVerification: "fake-provider" });
  expect(await remote.repair(task, verify)).toMatchObject({ status: "needs-human" });
  expect(await remote.repair({ ...task, id: "another-task" }, verify)).toMatchObject({ status: "needs-human" });
  expect(client.patch).toHaveBeenCalledOnce();
  expect(verify).not.toHaveBeenCalled();
  expect(remote.accounting()).toMatchObject({ unknownUsage: true, providerVerification: "not-run" });
});
it("retains known usage when a later response is lost", async () => {
  client.patch.mockResolvedValueOnce({ status: "rejected", reason: "patch-validation-failed", usage }).mockResolvedValueOnce({ status: "rejected", reason: "lost", usage: null });
  const remote = createHostedSemanticRepair({ session, client, providerVerification: "fake-provider" });
  await remote.repair(task, verify);
  expect(remote.accounting()).toEqual({ usage: { inputTokens: 300, outputTokens: 100, spentUsd: 0.0005 }, unknownUsage: true, providerVerification: "fake-provider" });
  expect(client.patch).toHaveBeenCalledTimes(2);
});
it("ends after the configured bounded attempts while retaining rejected-call usage", async () => {
  client.patch.mockResolvedValue({ status: "rejected", reason: "patch-validation-failed", usage });
  const remote = createHostedSemanticRepair({ session, client, providerVerification: "fake-provider" });
  expect(await remote.repair(task, verify)).toEqual({ status: "needs-human", reason: "Bounded agent attempts exhausted" });
  expect(client.patch).toHaveBeenCalledTimes(3);
  expect(remote.accounting().usage.inputTokens).toBe(900);
});
it("defers missing context or rejected input before transport without claiming a provider call", async () => {
  const remote = createHostedSemanticRepair({ session, client, providerVerification: "fake-provider" });
  vi.mocked(gatherRepairContext).mockRejectedValueOnce(new Error("private-context-error"));
  expect(await remote.repair(task, verify)).toMatchObject({ status: "needs-human" });
  expect(client.patch).not.toHaveBeenCalled();
  client.patch.mockRejectedValueOnce(new Error("input schema"));
  expect(await remote.repair(task, verify)).toMatchObject({ status: "needs-human" });
  expect(remote.accounting()).toMatchObject({ unknownUsage: false, providerVerification: "not-run" });
  expect(await readFile(join(root, "run.jsonl"), "utf8")).not.toContain("private-context-error");
});
it("cleans private runtime data before transferring a schema-validated candidate", async () => {
  const report = await runHostedWorker({ providerVerification: "fake-provider", submitCandidate: candidate => {
    events.push("submit"); expect(events).toEqual(["close", "submit"]); expect(candidate.patches).toEqual([patch]); return Promise.resolve();
  } });
  expect(report).toMatchObject({ fixed: 1, applied: false, providerVerification: "not-run" });
  expect(runRepair).toHaveBeenCalledWith(session, { noLlm: true });
  expect(await readFile(join(root, "run.jsonl"), "utf8")).toContain('"step":"hosted-candidate-transfer"');
});
it("withholds a candidate if runtime cleanup fails", async () => {
  vi.spyOn(session, "close").mockRejectedValue(new Error("cleanup failed"));
  const submit = vi.fn(() => Promise.resolve());
  await expect(runHostedWorker({ providerVerification: "fake-provider", submitCandidate: submit })).rejects.toThrow("cleanup failed");
  expect(submit).not.toHaveBeenCalled();
});
it("preserves failed transfer evidence without repeating submission", async () => {
  const close = vi.spyOn(session, "close");
  const submit = vi.fn(() => Promise.reject(new Error("lost response")));
  await expect(runHostedWorker({ providerVerification: "fake-provider", submitCandidate: submit })).rejects.toThrow("lost response");
  expect(submit).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(await readFile(join(root, "run.jsonl"), "utf8")).toContain('"step":"hosted-candidate-transfer","status":"error"');
});

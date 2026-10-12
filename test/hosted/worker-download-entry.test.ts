import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { HostedAgentClient } from "../../src/hosted/agent-client.js";
import { runHostedDownloadedWorkerEntry } from "../../src/hosted/worker-download-entry.js";
import { runHostedWorker } from "../../src/hosted/worker.js";
import { assertSecretlessWorker } from "../../src/runner/worker-boundary.js";
import { hostedCandidateFixture } from "../helpers/hosted-candidate.js";
import { createGoogleMetadataIdentityToken } from "../../src/hosted/google-access-token.js";

const layout = vi.hoisted(() => ({ downloadedInput: "", temporary: "" }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof filesystem>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock("../../src/runner/worker-boundary.js", () => ({ workerLayout: layout, assertSecretlessWorker: vi.fn(() => Promise.resolve()) }));
vi.mock("../../src/hosted/worker.js", () => ({ runHostedWorker: vi.fn() }));
vi.mock("../../src/hosted/google-access-token.js", () => ({ createGoogleMetadataIdentityToken: vi.fn(() => () => Promise.resolve("local-google-identity")) }));
let root: string;
let download: MockInstance<HostedAgentClient["downloadInput"]>, submit: MockInstance<HostedAgentClient["submitCandidate"]>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-downloaded-worker-")); await mkdir(join(root, "input"));
  layout.downloadedInput = join(root, "input/source"); layout.temporary = join(root, "temp");
  vi.stubEnv("ACCESSWRIGHT_RUN_ID", "run1"); vi.stubEnv("ACCESSWRIGHT_RUN_TOKEN", "a".repeat(64));
  vi.stubEnv("ACCESSWRIGHT_AGENT_ORIGIN", "https://agent.example"); vi.stubEnv("ACCESSWRIGHT_PROVIDER_VERIFICATION", "fake-provider");
  vi.stubEnv("CLOUD_RUN_JOB", undefined); vi.stubEnv("ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL", undefined);
  const bytes = Buffer.from("private fixture source");
  download = vi.spyOn(HostedAgentClient.prototype, "downloadInput").mockResolvedValue({ runId: "run1", baseSha: "a".repeat(40), files: [{ path: "page.tsx", mode: "100644",
    blobSha: createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex"), data: bytes.toString("base64") }] });
  submit = vi.spyOn(HostedAgentClient.prototype, "submitCandidate").mockResolvedValue();
});
afterEach(async () => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it("erases the owned input before transferring any candidate and retains only metadata", async () => {
  const candidate = hostedCandidateFixture();
  vi.mocked(runHostedWorker).mockImplementation(async options => {
    expect(options.repoPath).toBe(layout.downloadedInput);
    expect(await readFile(join(layout.downloadedInput, "page.tsx"), "utf8")).toBe("private fixture source");
    await options.submitCandidate(candidate); return candidate.report;
  });
  submit.mockImplementation(async () => {
    await expect(lstat(layout.downloadedInput)).rejects.toMatchObject({ code: "ENOENT" });
  });
  await runHostedDownloadedWorkerEntry();
  expect(submit).toHaveBeenCalledExactlyOnceWith(candidate);
  const metadata = await readFile(join(layout.temporary, "input-run1/run.jsonl"), "utf8");
  expect(metadata).toContain("hosted-input-cleared"); expect(metadata).not.toContain("private fixture source"); expect(metadata).not.toContain("a".repeat(64));
});

it("clears downloaded input when repair fails and never submits a candidate", async () => {
  vi.mocked(runHostedWorker).mockRejectedValueOnce(new Error("failed repair"));
  await expect(runHostedDownloadedWorkerEntry()).rejects.toThrow("failed repair");
  await expect(lstat(layout.downloadedInput)).rejects.toMatchObject({ code: "ENOENT" });
  expect(submit).not.toHaveBeenCalled();
});

it("preserves an occupied input directory without starting repository code", async () => {
  await mkdir(layout.downloadedInput); await writeFile(join(layout.downloadedInput, "owned.txt"), "preserve");
  await expect(runHostedDownloadedWorkerEntry()).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(join(layout.downloadedInput, "owned.txt"), "utf8")).toBe("preserve");
  expect(runHostedWorker).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});

it("verifies the isolation boundary before downloading private source", async () => {
  vi.mocked(assertSecretlessWorker).mockRejectedValueOnce(new Error("unsafe runtime"));
  await expect(runHostedDownloadedWorkerEntry()).rejects.toThrow("unsafe runtime");
  expect(download).not.toHaveBeenCalled(); expect(runHostedWorker).not.toHaveBeenCalled();
});

it("requires the operator worker identity on Cloud Run before downloading source", async () => {
  vi.stubEnv("CLOUD_RUN_JOB", "fixture-worker");
  await expect(runHostedDownloadedWorkerEntry()).rejects.toThrow("worker identity configuration"); expect(download).not.toHaveBeenCalled();
  vi.stubEnv("ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL", "worker@accesswright-dev-123.iam.gserviceaccount.com");
  vi.mocked(runHostedWorker).mockImplementation(async options => { await options.submitCandidate(hostedCandidateFixture()); return hostedCandidateFixture().report; });
  await runHostedDownloadedWorkerEntry();
  expect(createGoogleMetadataIdentityToken).toHaveBeenCalledExactlyOnceWith({ audience: "https://agent.example", serviceAccountEmail: "worker@accesswright-dev-123.iam.gserviceaccount.com" });
});

it("withholds transfer if input deletion fails, even when a later cleanup succeeds", async () => {
  const candidate = hostedCandidateFixture();
  vi.mocked(runHostedWorker).mockImplementation(async options => {
    vi.mocked(filesystem.rm).mockRejectedValueOnce(new Error("cleanup failed"));
    await options.submitCandidate(candidate); return candidate.report;
  });
  await expect(runHostedDownloadedWorkerEntry()).rejects.toThrow("cleanup failed");
  expect(submit).not.toHaveBeenCalled();
  await expect(lstat(layout.downloadedInput)).rejects.toMatchObject({ code: "ENOENT" });
});

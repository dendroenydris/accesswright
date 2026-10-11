import { afterEach, expect, it, vi } from "vitest";
import { HostedAgentClient } from "../../src/hosted/agent-client.js";
import { runHostedWorkerEntry } from "../../src/hosted/worker-entry.js";
import { runHostedWorker } from "../../src/hosted/worker.js";
import { assertSecretlessWorker } from "../../src/runner/worker-boundary.js";
import { hostedCandidateFixture } from "../helpers/hosted-candidate.js";

vi.mock("../../src/runner/worker-boundary.js", () => ({ assertSecretlessWorker: vi.fn(() => Promise.resolve()) }));
vi.mock("../../src/hosted/worker.js", () => ({ runHostedWorker: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

it("checks the secretless boundary before starting any worker", async () => {
  vi.mocked(assertSecretlessWorker).mockRejectedValueOnce(new Error("unsafe runtime"));
  await expect(runHostedWorkerEntry()).rejects.toThrow("unsafe runtime");
  expect(runHostedWorker).not.toHaveBeenCalled();
});
it("requires complete trusted image configuration before repair", async () => {
  vi.stubEnv("ACCESSWRIGHT_RUN_TOKEN", undefined);
  await expect(runHostedWorkerEntry()).rejects.toThrow();
  expect(runHostedWorker).not.toHaveBeenCalled();
});
it("uses scoped environment configuration and submits through the actual client", async () => {
  vi.stubEnv("ACCESSWRIGHT_RUN_ID", "run1"); vi.stubEnv("ACCESSWRIGHT_RUN_TOKEN", "a".repeat(64));
  vi.stubEnv("ACCESSWRIGHT_AGENT_ORIGIN", "https://agent.example"); vi.stubEnv("ACCESSWRIGHT_PROVIDER_VERIFICATION", "fake-provider");
  const candidate = hostedCandidateFixture();
  const submitted = vi.spyOn(HostedAgentClient.prototype, "submitCandidate").mockResolvedValue();
  vi.mocked(runHostedWorker).mockImplementation(async options => {
    expect(options.client).toBeInstanceOf(HostedAgentClient); expect(options.providerVerification).toBe("fake-provider");
    await options.submitCandidate(candidate); return candidate.report;
  });
  await runHostedWorkerEntry();
  expect(submitted).toHaveBeenCalledExactlyOnceWith(candidate);
});

import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { runHostedServiceEntry } from "../../src/hosted/service-entry.js";
import { assertHostedVerifierNetwork } from "../../src/hosted/verifier-network.js";

vi.mock("../../src/hosted/verifier-network.js", () => ({ assertHostedVerifierNetwork: vi.fn() }));
let root: string;
const fetcher = vi.fn<typeof fetch>();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-service-start-"));
  vi.stubGlobal("fetch", fetcher); fetcher.mockClear(); vi.mocked(assertHostedVerifierNetwork).mockReset();
});
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
function config() {
  return { role: "relay", projectId: "accesswright-dev-123", region: "europe-west1", candidateBucket: "private-candidates",
    candidateQueueId: "candidateTasks", candidateTaskOrigin: "https://tasks-owned.a.run.app", verifierOrigin: "https://verifier.owned.invalid",
    taskServiceAccountEmail: "tasks@accesswright-dev-123.iam.gserviceaccount.com", relayServiceAccountEmail: "relay@accesswright-dev-123.iam.gserviceaccount.com",
    workRoot: root, collections: { agentRuns: "agentRuns", reports: "reports", checkoutPins: "pins", cleanup: "cleanup", spending: "spending" } };
}

it.each(["", "{invalid-json", " ".repeat(defaults.configMaxBytes + 1)])("refuses missing, invalid or oversized operator configuration before startup", async raw => {
  vi.stubEnv("ACCESSWRIGHT_HOSTED_CONFIG", raw);
  await expect(runHostedServiceEntry()).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled(); expect(assertHostedVerifierNetwork).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});

it("requires actual verifier network isolation before reading App credentials or creating a service", async () => {
  vi.stubEnv("ACCESSWRIGHT_HOSTED_CONFIG", JSON.stringify({ ...config(), role: "verifier", appId: 7, repositories: ["owner/repo"],
    model: { provider: "openai", id: "fixture-only" }, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    maxInputTokens: 1200, maxOutputTokens: 256, maxCostUsdPerRun: 0.02, runtimeRoot: "/fixture/runtime" }));
  vi.stubEnv("ACCESSWRIGHT_GITHUB_APP_PRIVATE_KEY", "invalid-key-must-not-be-read");
  vi.mocked(assertHostedVerifierNetwork).mockRejectedValueOnce(new Error("Network isolation unconfirmed"));
  await expect(runHostedServiceEntry()).rejects.toThrow("Network isolation unconfirmed");
  expect(assertHostedVerifierNetwork).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});

it("rejects an invalid port before producing startup evidence", async () => {
  vi.stubEnv("ACCESSWRIGHT_HOSTED_CONFIG", JSON.stringify(config())); vi.stubEnv("PORT", "0");
  await expect(runHostedServiceEntry()).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});

it("propagates a failed socket bind without a false successful startup record", async () => {
  const occupied = createServer(); occupied.listen(0, "0.0.0.0"); await once(occupied, "listening");
  try {
    const address = occupied.address(); if (!address || typeof address === "string") throw new Error("Fixture port missing");
    vi.stubEnv("ACCESSWRIGHT_HOSTED_CONFIG", JSON.stringify(config())); vi.stubEnv("PORT", String(address.port));
    await expect(runHostedServiceEntry()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await readdir(join(root, "evidence"))).toEqual([]); expect(fetcher).not.toHaveBeenCalled();
  } finally { await new Promise<void>(done => occupied.close(() => done())); }
});

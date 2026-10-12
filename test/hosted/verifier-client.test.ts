import { expect, it, vi } from "vitest";
import { HostedVerifierClient } from "../../src/hosted/verifier-client.js";
import { HostedRunWorkflow, InMemoryHostedRunStore, hostedReportDigest } from "../../src/hosted/run-workflow.js";
import { hostedCandidateFixture } from "../helpers/hosted-candidate.js";
import { defaults } from "../../src/config.js";

const runId = "run1", baseSha = "a".repeat(40), report = hostedCandidateFixture().report, digest = hostedReportDigest(report);
async function fixture() {
  const runs = new InMemoryHostedRunStore(), verify = vi.fn(() => Promise.resolve({ reportDigest: digest, verifiedBaseSha: baseSha }));
  const workflow = new HostedRunWorkflow({ store: runs, authenticate: value => ({ runId: value, repository: "owned/fixture", installationId: 42 }), verifyTrustedResult: verify });
  await workflow.submitResults(runId, "fixture-worker", report);
  const getIdentityToken = vi.fn(() => Promise.resolve("fixture-google-id-token"));
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    expect(input).toBe("https://verifier.owned.invalid/internal/candidates/verify");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-google-id-token");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toEqual({ runId, reportDigest: digest });
    return workflow.finishTrustedReport(runId, digest).then(value => Response.json(value));
  });
  const client = new HostedVerifierClient({ origin: "https://verifier.owned.invalid", runs, fetcher, getIdentityToken });
  return { runs, workflow, verify, getIdentityToken, fetcher, client };
}

it("sends only scoped metadata to the fixed Docker host and checks its durable terminal evidence; repeated dispatch does not replay", async () => {
  const f = await fixture(); expect(await f.client.finishTrustedReport(runId, digest)).toEqual({ runId, status: "ready-for-review", verifiedBaseSha: baseSha });
  expect(f.getIdentityToken).toHaveBeenCalledWith("https://verifier.owned.invalid");
  expect(await f.client.finishTrustedReport(runId, digest)).toMatchObject({ status: "ready-for-review" }); expect(f.verify).toHaveBeenCalledOnce();
});

it("withholds ready replies without matching persisted verification rather than granting authority from HTTP flags", async () => {
  const f = await fixture(); f.fetcher.mockResolvedValueOnce(Response.json({ runId, status: "ready-for-review", verifiedBaseSha: baseSha }));
  await expect(f.client.finishTrustedReport(runId, digest)).rejects.toThrow(/^Remote trusted verification is unconfirmed$/);
  expect(f.runs.get(runId)?.status).toBe("recorded"); expect(f.verify).not.toHaveBeenCalled();
});

it.each([
  () => Response.json({ runId: "other-run", status: "ready-for-review", verifiedBaseSha: baseSha }),
  () => Response.json({ runId, status: "verifying" }),
  () => Response.json({ runId, status: "ready-for-review" }),
  () => new Response("fixture-private-source-marker", { status: 503 }),
  () => new Response("x".repeat(defaults.hostedMaxCandidateResponseBytes + 1)),
])("rejects unknown or mismatched responses without automatic replay or private diagnostics (%#)", async makeResponse => {
  const f = await fixture(); f.fetcher.mockResolvedValueOnce(makeResponse());
  await expect(f.client.finishTrustedReport(runId, digest)).rejects.toThrow(/^Remote trusted verification is unconfirmed$/);
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.verify).not.toHaveBeenCalled();
});

it("rejects malformed upstream credentials without making a network request", async () => {
  const f = await fixture(); f.getIdentityToken.mockResolvedValueOnce("fixture\r\nmarker");
  await expect(f.client.finishTrustedReport(runId, digest)).rejects.toThrow(/^Remote trusted verification is unconfirmed$/); expect(f.fetcher).not.toHaveBeenCalled();
});

it.each(["http://verifier.owned.invalid", "https://secret@verifier.owned.invalid", "https://verifier.owned.invalid/private", "https://verifier.owned.invalid?selector=worker"])("rejects unsafe or non-origin verifier configuration: %s", origin => {
  expect(() => new HostedVerifierClient({ origin, runs: new InMemoryHostedRunStore(), getIdentityToken: () => Promise.resolve("fixture") })).toThrow("fixed HTTPS origin");
});

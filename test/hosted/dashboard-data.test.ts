import { expect, it } from "vitest";

import { FirestoreDashboardReader, workloadAccessToken } from "../../app/lib/run-data.js";

const base = {
  repository: "owner/private", installationId: 42, reportDigest: "f".repeat(64),
  status: "recorded" as const, acceptedFixes: 0, eligibleForReview: false,
  failedChecks: [] as Array<"build" | "typecheck" | "lint" | "tests">,
  unknownUsage: false, spentUsd: 0, verifiedBaseSha: null,
  recordedAt: "2026-10-09T14:00:00.000Z",
};
function doc(id: string, extra: Record<string, unknown> = {}) {
  return {
    name: "projects/accesswright-dev-123/databases/(default)/documents/runs/" + id,
    fields: { payload: { stringValue: JSON.stringify({ ...base, runId: id, ...extra }) } },
  };
}
const readUrl = "https://firestore.googleapis.com/v1/projects/accesswright-dev-123/databases/%28default%29/documents/runs";
function reader(fetcher: typeof fetch) {
  return new FirestoreDashboardReader({
    projectId: "accesswright-dev-123", collectionId: "runs",
    getAccessToken: () => Promise.resolve("workload-only-token"),
    fetcher,
  });
}

it("paginates bounded Firestore metadata, sorts by recordedAt, and never sends credentials to the client", async () => {
  let requests = 0;
  const api = reader((input, init) => {
    requests++;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe("https://firestore.googleapis.com");
    expect(url.pathname).toBe(new URL(readUrl).pathname);
    expect(url.searchParams.get("pageSize")).toBe("50");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer workload-only-token");
    expect(init?.cache).toBe("no-store");
    if (requests === 1) {
      expect(url.searchParams.get("pageToken")).toBe(null);
      return Promise.resolve(Response.json({ documents: [doc("run-1")], nextPageToken: "next" }));
    }
    expect(url.searchParams.get("pageToken")).toBe("next");
    return Promise.resolve(Response.json({ documents: [doc("run-2", { recordedAt: "2026-10-09T16:00:00.000Z" })] }));
  });
  const result = await api.list();
  expect(result).toMatchObject({ limited: false });
  expect(result.runs.map(run => run.runId)).toEqual(["run-2", "run-1"]);
  expect(requests).toBe(2);
  expect(JSON.stringify(result)).not.toMatch(/OPENAI_API_KEY|GH_TOKEN|sourceExcerpt|screenshot/);
});

it("reads only exact run identity and rejects unexpected source payload or wrong Firestore document", async () => {
  let body: unknown = doc("run-a");
  const api = reader(() => Promise.resolve(Response.json(body)));
  expect((await api.get("run-a"))?.repository).toBe("owner/private");
  body = doc("run-a", { status: "verifying" });
  expect((await api.get("run-a"))?.status).toBe("verifying");
  body = doc("run-a", { status: "staging" });
  expect((await api.get("run-a"))?.status).toBe("staging");
  await expect(api.get("../evil")).rejects.toThrow();
  body = doc("run-other");
  await expect(api.get("run-a")).rejects.toThrow(/identity/);
  body = doc("run-a", { sourceExcerpt: "private source" });
  await expect(api.get("run-a")).rejects.toThrow();
});

it("rejects oversized responses, duplicate run identifiers and provider failures", async () => {
  let body: unknown = { documents: [doc("run-1"), doc("run-1")] };
  let status = 200;
  const api = reader(() => Promise.resolve(Response.json(body, { status })));
  await expect(api.list()).rejects.toThrow(/duplicate/i);
  body = { documents: [doc("run-1", { source: "s".repeat(600_000) })] };
  await expect(api.list()).rejects.toThrow(/bound/i);
  status = 503;
  await expect(api.list()).rejects.toThrow(/503/);
});

it("uses only Google metadata workload identity and refuses invalid/missing metadata response", async () => {
  const token = await workloadAccessToken((input, init) => {
    expect(input).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
    expect(new Headers(init?.headers).get("metadata-flavor")).toBe("Google");
    return Promise.resolve(Response.json({
      access_token: "fixture-access-token", token_type: "Bearer", expires_in: 3599,
    }, { headers: { "Metadata-Flavor": "Google" } }));
  });
  expect(token).toBe("fixture-access-token");
  await expect(workloadAccessToken(() => Promise.resolve(Response.json({
    access_token: "malicious", token_type: "Bearer", expires_in: 3600,
  })))).rejects.toThrow(/metadata/i);
  await expect(workloadAccessToken(() => Promise.resolve(Response.json({
    access_token: "key\nleak", token_type: "Bearer", expires_in: 3600,
  }, { headers: { "Metadata-Flavor": "Google" } })))).rejects.toThrow();
});

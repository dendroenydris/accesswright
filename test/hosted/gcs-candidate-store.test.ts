import { afterEach, expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { GcsHostedCandidateStore } from "../../src/hosted/gcs-candidate-store.js";
import { hostedCandidateFixture } from "../helpers/hosted-candidate.js";

const bucketName = "owned-candidate-fixtures";
function fixture() {
  const rows = new Map<string, { generation: string; body: string }>();
  const soft = new Map<string, { generation: string; body: string }>();
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  let softDeletion = false;
  const policy: Record<string, unknown> = { name: bucketName, softDeletePolicy: { retentionDurationSeconds: "0" },
    iamConfiguration: { publicAccessPrevention: "enforced", uniformBucketLevelAccess: { enabled: true } } };
  const scheduleExpiry = vi.fn(() => Promise.resolve());
  const metadata = (name: string, row: { generation: string; body: string }) => ({ bucket: bucketName, name, generation: row.generation, size: String(Buffer.byteLength(row.body)) });
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer trusted-workload-only");
    const method = init?.method ?? "GET", body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url: url.href, method, body });
    if (url.pathname === "/storage/v1/b/" + bucketName) return Promise.resolve(Response.json(policy));
    const name = url.pathname.startsWith("/upload/") ? url.searchParams.get("name") ?? "" : decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
    if (method === "POST") {
      expect(scheduleExpiry).toHaveBeenCalled(); expect(url.searchParams.get("uploadType")).toBe("media"); expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
      if (rows.has(name)) return Promise.resolve(new Response(null, { status: 412 }));
      if (body === undefined) throw new Error("Missing candidate body");
      const row = { generation: "18352938493858493930", body }; rows.set(name, row);
      return Promise.resolve(Response.json(metadata(name, row)));
    }
    const row = url.searchParams.get("softDeleted") === "true" ? soft.get(name) : rows.get(name);
    if (!row) return Promise.resolve(new Response(null, { status: 404 }));
    if (url.searchParams.has("generation") && url.searchParams.get("generation") !== row.generation) return Promise.resolve(new Response(null, { status: 412 }));
    if (method === "DELETE") {
      expect(url.searchParams.get("ifGenerationMatch")).toBe(row.generation);
      rows.delete(name); if (softDeletion) soft.set(name, row);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.searchParams.get("alt") === "media") {
      expect(url.searchParams.get("ifGenerationMatch")).toBe(row.generation);
      return Promise.resolve(new Response(row.body));
    }
    return Promise.resolve(Response.json(metadata(name, row)));
  };
  const options = { bucketName, fetcher, scheduleExpiry, getAccessToken: () => Promise.resolve("trusted-workload-only") };
  return { rows, calls, policy, scheduleExpiry, options, setSoftDeletion: () => { softDeletion = true; }, open: () => new GcsHostedCandidateStore(options) };
}
afterEach(() => { vi.useRealTimers(); });

it("creates one immutable private object after durable expiry scheduling and survives coordinator restart", async () => {
  const f = fixture(), candidate = hostedCandidateFixture(); const saved = await f.open().put("run1", candidate);
  expect(saved.generation).toBe("18352938493858493930");
  expect(await f.open().get("run1")).toEqual({ ...saved, candidate });
  expect(await f.open().put("run1", candidate)).toEqual(saved);
  expect(f.scheduleExpiry).toHaveBeenCalledOnce();
  const changed = structuredClone(candidate); changed.patches[0].changes[0].after = "changed-private-marker";
  await expect(f.open().put("run1", changed)).rejects.toThrow("Conflicting private candidate");
  const stored = f.rows.get("accesswright-candidates/run1")?.body ?? "";
  expect(stored).not.toContain("trusted-workload-only"); expect(stored).not.toContain("OPENAI_API_KEY");
  await f.open().remove("run1", saved.generation); expect(f.rows.size).toBe(0);
});

it.each(["soft-delete", "versioning", "retention", "public", "hold"])("refuses a %s bucket before any private write", async kind => {
  const f = fixture();
  if (kind === "soft-delete") f.policy.softDeletePolicy = { retentionDurationSeconds: "604800" };
  if (kind === "versioning") f.policy.versioning = { enabled: true };
  if (kind === "retention") f.policy.retentionPolicy = { retentionPeriod: "3600" };
  if (kind === "public") f.policy.iamConfiguration = { publicAccessPrevention: "inherited", uniformBucketLevelAccess: { enabled: true } };
  if (kind === "hold") f.policy.defaultEventBasedHold = true;
  await expect(f.open().put("run1", hostedCandidateFixture())).rejects.toThrow();
  expect(f.calls.some(call => call.method === "POST")).toBe(false); expect(f.scheduleExpiry).not.toHaveBeenCalled();
});

it("withholds storage if cleanup cannot be durably scheduled and never blindly retries transport", async () => {
  const f = fixture(); f.scheduleExpiry.mockRejectedValueOnce(new Error("queue unavailable"));
  await expect(f.open().put("run1", hostedCandidateFixture())).rejects.toThrow("queue unavailable");
  expect(f.rows.size).toBe(0);
  const interrupted = vi.fn<typeof fetch>(() => Promise.reject(new Error("private-source-marker trusted-workload-only")));
  await expect(new GcsHostedCandidateStore({ ...f.options, fetcher: interrupted }).put("run1", hostedCandidateFixture())).rejects.toThrow("transport is unconfirmed");
  expect(interrupted).toHaveBeenCalledOnce();
});

it("never expires early and removes expired source with generation-bound confirmation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T19:00:00Z"));
  const f = fixture(); await f.open().put("run1", hostedCandidateFixture(), 30);
  await expect(f.open().expire("run1")).rejects.toThrow("not due"); expect(f.rows.size).toBe(1);
  vi.setSystemTime(new Date("2026-10-11T19:00:30Z"));
  await f.open().expire("run1"); expect(f.rows.size).toBe(0); expect(await f.open().get("run1")).toBeNull();
});

it("withholds cleanup confirmation if a deleted object remains soft-recoverable", async () => {
  const f = fixture(); const saved = await f.open().put("run1", hostedCandidateFixture()); f.setSoftDeletion();
  await expect(f.open().remove("run1", saved.generation)).rejects.toThrow("remains recoverable");
  expect(f.calls.some(call => new URL(call.url).searchParams.get("softDeleted") === "true")).toBe(true);
});

it("rejects corrupted candidate bytes and bounds streamed private responses", async () => {
  const f = fixture(); await f.open().put("run1", hostedCandidateFixture());
  const row = f.rows.get("accesswright-candidates/run1"); if (!row) throw new Error("Missing fixture object");
  row.body = row.body.replace("private-repaired-marker", "forged-private-marker");
  await expect(f.open().get("run1")).rejects.toThrow("identity or expiry");
  const oversized: typeof fetch = () => Promise.resolve(new Response("x".repeat(defaults.hostedMaxCandidateObjectBytes + 1)));
  await expect(new GcsHostedCandidateStore({ ...f.options, fetcher: oversized }).verifyBucket()).rejects.toThrow("bound");
});

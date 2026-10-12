import { expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { CloudRunJobInvoker } from "../../src/hosted/cloud-run-job.js";

const job = "projects/accesswright-dev-123/locations/europe-west3/jobs/worker";
function execution(id: string) {
  return { name: job + "/executions/" + id, job, createTime: "2026-10-10T12:00:00.000Z", startTime: "2026-10-10T13:00:00.000Z",
    completionTime: "2026-10-11T03:00:00.000Z", template: { PRIVATE_SOURCE: "PRIVATE_TOKEN" } };
}
function fixture(pages: unknown[]) {
  const requests: URL[] = [];
  const invoker = new CloudRunJobInvoker({ projectId: "accesswright-dev-123", region: "europe-west3", jobId: "worker", containerName: "accesswright",
    getAccessToken: () => Promise.resolve("fixture-identity"), fetcher: (input, init) => {
      const uri = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); requests.push(uri);
      expect(uri.origin).toBe("https://run.googleapis.com"); expect(uri.pathname).toBe("/v2/" + job + "/executions");
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error"); expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-identity");
      return Promise.resolve(Response.json(pages[requests.length - 1]));
    } });
  return { invoker, requests };
}

it("enumerates only fixed-job resource metadata, retaining unexpired deleted entries and stable query parameters", async () => {
  const f = fixture([{ executions: [execution("one")], nextPageToken: "next&../untrusted" },
    { executions: [{ ...execution("two"), deleteTime: "2026-10-11T04:00:00.000Z", expireTime: "2099-10-11T04:00:00.000Z" }] }]);
  const result = await f.invoker.listExecutionInventory();
  expect(result.executions).toHaveLength(2); expect(result.executions[1]).toMatchObject({ name: job + "/executions/two", deleteTime: "2026-10-11T04:00:00.000Z" });
  expect(result.observedAt).toMatch(/^\d{4}-/); expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|template|status|succeededCount/);
  expect(f.requests.map(uri => uri.searchParams.get("pageToken"))).toEqual([null, "next&../untrusted"]);
  for (const uri of f.requests) {
    expect(uri.searchParams.get("showDeleted")).toBe("true");
    expect(uri.searchParams.get("pageSize")).toBe(String(defaults.cloudRunExecutionPageSize));
    expect(uri.searchParams.get("fields")).toBe("executions(name,job,createTime,startTime,completionTime,deleteTime,expireTime),nextPageToken");
  }
});

it.each(["duplicate", "foreign-job", "foreign-name", "path", "future", "reversed-time"])("rejects ambiguous or unbound inventory (%s), without a partial result", async fault => {
  const row = execution("one");
  if (fault === "foreign-job") row.job = job.replace("/worker", "/other");
  if (fault === "foreign-name") row.name = job.replace("/worker", "/other") + "/executions/one";
  if (fault === "path") row.name = job + "/executions/../other";
  if (fault === "future") row.createTime = "2099-10-10T12:00:00.000Z";
  if (fault === "reversed-time") row.completionTime = "2026-10-09T03:00:00.000Z";
  const pages = fault === "duplicate" ? [{ executions: [row], nextPageToken: "next" }, { executions: [row] }] : [{ executions: [row] }];
  await expect(fixture(pages).invoker.listExecutionInventory()).rejects.toThrow(/identity|timestamp/);
});

it("withholds inventory on repeated tokens or page exhaustion", async () => {
  await expect(fixture([{ nextPageToken: "loop" }, { nextPageToken: "loop" }]).invoker.listExecutionInventory()).rejects.toThrow(/pagination/);
  const pages = Array.from({ length: defaults.cloudRunExecutionMaxListPages }, (_, index) => ({ nextPageToken: String(index + 1) }));
  await expect(fixture(pages).invoker.listExecutionInventory()).rejects.toThrow(/page limit/);
});

it("does not return first-page data after denied access and cancels oversized streamed inventory", async () => {
  let count = 0, cancelled = 0;
  const invoker = new CloudRunJobInvoker({ projectId: "accesswright-dev-123", region: "europe-west3", jobId: "worker", containerName: "accesswright",
    getAccessToken: () => Promise.resolve("fixture-identity"), fetcher: () => {
      count += 1;
      return Promise.resolve(count === 1 ? Response.json({ executions: [execution("one")], nextPageToken: "next" }) : new Response("PRIVATE_ERROR", { status: 403 }));
    } });
  await expect(invoker.listExecutionInventory()).rejects.toThrow(/403/);
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(defaults.cloudRunResponseMaxBytes + 1)); }, cancel() { cancelled += 1; },
  }, { highWaterMark: 0 }))));
  const oversized = new CloudRunJobInvoker({ projectId: "accesswright-dev-123", region: "europe-west3", jobId: "worker", containerName: "accesswright",
    getAccessToken: () => Promise.resolve("fixture-identity"), fetcher });
  await expect(oversized.listExecutionInventory()).rejects.toThrow(/size limit/); expect(cancelled).toBe(1); expect(fetcher).toHaveBeenCalledOnce();
});

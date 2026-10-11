import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { appendRunRecord, RunRecordSchema } from "../../src/tracer/run-record.js";

const payloadSchema = z.object({ resourceSpans: z.array(z.object({ scopeSpans: z.array(z.object({ spans: z.array(z.object({
  name: z.string(), startTimeUnixNano: z.string(), endTimeUnixNano: z.string(), status: z.object({ code: z.number() }),
  attributes: z.array(z.object({ key: z.string(), value: z.object({ stringValue: z.string().optional(), intValue: z.union([z.string(), z.number()]).optional(), doubleValue: z.number().optional() }) })),
})) })) })) });
const servers: Server[] = [];
let directory: string;
let path: string;
beforeEach(async () => {
  for (const name of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS"]) vi.stubEnv(name, undefined);
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", "500");
  directory = await mkdtemp(join(tmpdir(), "accesswright-otlp-"));
  path = join(directory, "run.jsonl");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  await rm(directory, { recursive: true, force: true });
});
async function collector(status = 200) {
  const requests: Array<{ url: string; body: string; header: string | string[] | undefined }> = [];
  const server = createServer((request, response) => {
    void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    requests.push({ url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8"), header: request.headers["x-trace"] });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(status === 200 ? "{}" : "collector-private-diagnostic");
    })().catch(() => { response.writeHead(500); response.end("{}"); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture collector address");
  return { endpoint: `http://127.0.0.1:${address.port}`, requests };
}
it("keeps JSONL local when no endpoint is configured", async () => {
  const received = await collector();
  await appendRunRecord(path, { timestamp: "2026-10-11T20:00:00.000Z", step: "scan", status: "ok" });
  expect(received.requests).toEqual([]);
  expect(RunRecordSchema.parse(JSON.parse((await readFile(path, "utf8")).trim()))).toMatchObject({ step: "scan", status: "ok" });
});
it("exports an ended span to the exact trace endpoint without registering a global provider", async () => {
  const received = await collector();
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${received.endpoint}/custom/traces`);
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_HEADERS", "x-trace=fixture-header");
  const original = trace.getTracerProvider();
  await appendRunRecord(path, { timestamp: "2026-10-11T20:00:00.000Z", step: "scan", status: "ok", durationMs: 125 });
  expect(trace.getTracerProvider()).toBe(original);
  expect(received.requests).toHaveLength(1);
  expect(received.requests[0]).toMatchObject({ url: "/custom/traces", header: "fixture-header" });
  const spans = payloadSchema.parse(JSON.parse(received.requests[0]?.body ?? "")).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
  expect(spans).toHaveLength(1);
  expect(spans[0]).toMatchObject({ name: "scan", status: { code: 1 } });
  expect(BigInt(spans[0]?.endTimeUnixNano ?? "0") - BigInt(spans[0]?.startTimeUnixNano ?? "0")).toBe(125000000n);
});
it("appends the trace path to a base endpoint and exports only bounded model metadata", async () => {
  const received = await collector();
  vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", `${received.endpoint}/collector/`);
  await appendRunRecord(path, { timestamp: "2026-10-11T20:00:00.000Z", step: "llm", status: "rejected", durationMs: 20,
    model: { provider: "fixture", id: "fixture-model", reasoningEffort: "high" }, usage: { inputTokens: 12, outputTokens: 3, costUsd: 0.001 },
    metadata: { promptHash: "a".repeat(64), route: "/private-customer", diagnostic: "private-source-and-image-text" } });
  expect(received.requests).toHaveLength(1);
  expect(received.requests[0]?.url).toBe("/collector/v1/traces");
  const body = received.requests[0]?.body ?? "";
  const spans = payloadSchema.parse(JSON.parse(body)).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
  expect(spans[0]).toMatchObject({ name: "llm", status: { code: 2 } });
  const attributes = Object.fromEntries((spans[0]?.attributes ?? []).map(attribute => [attribute.key, attribute.value]));
  expect(attributes).toMatchObject({ "llm.provider": { stringValue: "fixture" }, "llm.model": { stringValue: "fixture-model" }, "llm.prompt_hash": { stringValue: "a".repeat(64) } });
  expect(Object.keys(attributes).sort()).toEqual(["accesswright.status", "llm.cost_usd", "llm.input_tokens", "llm.model", "llm.output_tokens", "llm.prompt_hash", "llm.provider", "llm.reasoning_effort"]);
  expect(body).not.toMatch(/private-customer|private-source-and-image-text/);
  expect(await readFile(path, "utf8")).toContain("private-source-and-image-text");
});
it("retains local evidence and records a collector failure without leaking its diagnostic", async () => {
  const received = await collector(400);
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${received.endpoint}/v1/traces`);
  await appendRunRecord(path, { timestamp: "2026-10-11T20:00:00.000Z", step: "build", status: "error" });
  const text = await readFile(path, "utf8");
  expect(text).not.toContain("collector-private-diagnostic");
  const records = text.trim().split("\n").map(line => RunRecordSchema.parse(JSON.parse(line)));
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ step: "build", status: "error" });
  expect(records[1]).toMatchObject({ step: "trace-export", status: "error", metadata: { step: "build" } });
});
it.each(["not-an-endpoint", "file:///private-source", "https://fixture-user:fixture-secret@example.invalid/traces"])("refuses an invalid or credential-bearing endpoint: %s", async endpoint => {
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", endpoint);
  await appendRunRecord(path, { timestamp: "2026-10-11T20:00:00.000Z", step: "scan", status: "ok" });
  const text = await readFile(path, "utf8");
  expect(text).not.toMatch(/fixture-user|fixture-secret|example.invalid|file:\/\/\/private-source|not-an-endpoint/);
  expect(text.trim().split("\n")).toHaveLength(2);
});
it("exports nothing when boundary validation or local evidence writing fails", async () => {
  const received = await collector();
  vi.stubEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `${received.endpoint}/v1/traces`);
  await expect(appendRunRecord(path, { timestamp: "2026-10-11T20:00:00.000Z", step: "scan", status: "ok", metadata: { apiKey: "fixture-secret" } })).rejects.toThrow(/secret-like/i);
  await expect(appendRunRecord(join(directory, "absent", "run.jsonl"), { timestamp: "2026-10-11T20:00:00.000Z", step: "scan", status: "ok" })).rejects.toThrow();
  expect(received.requests).toEqual([]);
});

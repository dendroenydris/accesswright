import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults } from "../config.js";
import { appendRunRecord } from "../tracer/run-record.js";
import { clearHostedCandidate } from "./candidate-cleanup.js";
import type { FirestoreCandidateCleanupStore } from "./candidate-cleanup.js";
import type { GcsHostedCandidateStore } from "./gcs-candidate-store.js";
import type { HostedRunStore, HostedRunWorkflow } from "./run-workflow.js";

const runSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const verifySchema = z.object({ runId: runSchema, reportDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const expirySchema = z.object({ runId: runSchema, expiresAt: z.iso.datetime() }).strict();
class OversizedTask extends Error { constructor() { super("Candidate task metadata exceeds its bound"); } }
async function readTask(request: IncomingMessage): Promise<unknown> {
  const claimed = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(claimed) || claimed < 0) throw new SyntaxError("Invalid metadata length");
  if (claimed > defaults.firestoreRecordMaxBytes) { request.resume(); throw new OversizedTask(); }
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    length += chunk.length; if (length > defaults.firestoreRecordMaxBytes) throw new OversizedTask(); chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
function send(response: ServerResponse, code: number, input: object): void {
  const body = JSON.stringify(input);
  response.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

/** Separate private ingress: authenticate the exact Google Tasks identity, never the worker's run token. */
export function createHostedCandidateTaskServer(options: {
  authenticateTask: (authorization: string) => Promise<boolean>;
  workflow: Pick<HostedRunWorkflow, "finishTrustedReport">;
  runs: Pick<HostedRunStore, "get">;
  store: Pick<GcsHostedCandidateStore, "remove" | "generationForCleanup">;
  cleanup: Pick<FirestoreCandidateCleanupStore, "get" | "claim" | "confirm">;
  evidenceRoot: string;
}) {
  const record = async (runId: string, step: string, status: "ok" | "error") => {
    const directory = join(options.evidenceRoot, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await appendRunRecord(join(directory, "run.jsonl"), { timestamp: new Date().toISOString(), step, status });
  };
  const server = createServer((request, response) => {
    void (async () => {
      const route = request.url === "/internal/candidates/verify" ? "verify" : request.url === "/internal/candidates/expire" ? "expire" : null;
      if (!route) { send(response, 404, { status: "not-found" }); return; }
      if (request.method !== "POST") { send(response, 405, { status: "method-not-allowed" }); return; }
      let taskRunId: string | undefined;
      try {
        if (!await options.authenticateTask(request.headers.authorization ?? "")) {
          request.resume(); send(response, 401, { status: "unauthorized" }); return;
        }
        if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
          request.resume(); send(response, 415, { status: "unsupported-media-type" }); return;
        }
        const body = await readTask(request);
        if (route === "verify") {
          const task = verifySchema.parse(body);
          taskRunId = task.runId;
          await record(task.runId, "hosted-candidate-verification-dispatch", "ok");
          const result = await options.workflow.finishTrustedReport(task.runId, task.reportDigest);
          await record(task.runId, "hosted-candidate-verification-response", "ok");
          send(response, 200, result);
          return;
        }
        const task = expirySchema.parse(body);
        taskRunId = task.runId;
        if (Date.parse(task.expiresAt) > Date.now()) throw new Error("Cleanup deadline is not due");
        const run = await options.runs.get(task.runId);
        if (!run?.candidateDigest) throw new Error("Cleanup requires the original candidate identity");
        let receipt = await options.cleanup.get(task.runId);
        if (!receipt) {
          const generation = await options.store.generationForCleanup(task.runId);
          if (!generation) throw new Error("Interrupted upload cleanup is unconfirmed");
          receipt = await options.cleanup.claim(task.runId, { generation, expiresAt: task.expiresAt, candidateDigest: run.candidateDigest });
        }
        if (receipt.candidateDigest !== run.candidateDigest || receipt.expiresAt !== task.expiresAt) throw new Error("Cleanup task identity changed");
        if (receipt.status !== "cleared") await clearHostedCandidate(options, task.runId, { generation: receipt.generation, expiresAt: receipt.expiresAt, candidateDigest: receipt.candidateDigest });
        await record(task.runId, "hosted-candidate-expiry-cleared", "ok");
        if (run.status === "recorded") await options.workflow.finishTrustedReport(task.runId, run.reportDigest);
        send(response, 200, { runId: task.runId, status: "cleared" });
      } catch (error) {
        if (taskRunId) try { await record(taskRunId, "hosted-candidate-task-" + route, "error"); } catch { /* Keep the operation pending when diagnostic storage is unavailable. */ }
        if (error instanceof OversizedTask) send(response, 413, { status: "too-large" });
        else if (error instanceof z.ZodError || error instanceof SyntaxError) send(response, 400, { status: "invalid-metadata" });
        else send(response, 503, { status: "requires-reconciliation" });
      }
    })().catch(() => { if (!response.writableEnded) send(response, 503, { status: "requires-reconciliation" }); });
  });
  server.requestTimeout = defaults.hostedHttpRequestTimeoutMs;
  server.headersTimeout = defaults.hostedHttpHeadersTimeoutMs;
  return server;
}

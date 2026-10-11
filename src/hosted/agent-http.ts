import { createServer } from "node:http";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";

import { defaults } from "../config.js";
import type { HostedPatchAgent } from "./agent-api.js";
import { createHostedRunHandler } from "./run-http.js";
import { HostedRunWorkflow } from "./run-workflow.js";
import type { HostedRunWorkflowDependencies } from "./run-workflow.js";
import { HostedPatchRequestSchema } from "./agent-protocol.js";

const maxBodyBytes = defaults.hostedMaxPatchBodyBytes;
const patchPath = /^\/runs\/([A-Za-z0-9_-]{1,64})\/tasks\/([^/?]+)\/patch$/;

class LargePayloadError extends Error {
  constructor() { super("Internal agent request exceeds byte limit"); }
}

function send(response: ServerResponse, status: number, data: Record<string, unknown>): void {
  const text = JSON.stringify(data);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

async function boundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  const headerLength = request.headers["content-length"];
  if (typeof headerLength === "string" && Number(headerLength) > maxBodyBytes) {
    request.resume();
    throw new LargePayloadError();
  }
  for await (const chunk of request as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > maxBodyBytes) throw new LargePayloadError();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * Restricted agent API. The target Docker job has a random per-run token, not
 * OpenAI/GitHub keys. Source is transmitted to the caller only after its token
 * and task identity are verified; no request data is persisted by this HTTP layer.
 * Deployment must configure private service ingress and durable run storage.
 */
export function createHostedAgentHandler(agent: HostedPatchAgent): RequestListener {
  return (request, response) => {
    void (async () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const matched = patchPath.exec(path);
      if (!matched) {
        send(response, 404, { status: "not-found" });
        return;
      }
      if (request.method !== "POST") {
        send(response, 405, { status: "method-not-allowed" });
        return;
      }
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        send(response, 415, { status: "unsupported-media-type" });
        return;
      }
      const runId = matched[1] ?? "";
      const bearer = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/);
      const token = bearer?.[1];
      try {
        if (!token) throw new Error("authorization");
        await agent.inspectRun(runId, token);
      } catch {
        send(response, 401, { status: "unauthorized" });
        return;
      }
      let taskId: string;
      try { taskId = decodeURIComponent(matched[2] ?? ""); }
      catch {
        send(response, 400, { status: "invalid-task" });
        return;
      }
      try {
        const parsed = HostedPatchRequestSchema.safeParse(await boundedJson(request));
        if (!parsed.success) {
          send(response, 400, { status: "invalid-request" });
          return;
        }
        if (Buffer.byteLength(JSON.stringify({ task: parsed.data.task, context: parsed.data.context, feedback: parsed.data.feedback })) > defaults.hostedMaxContextBytes) throw new LargePayloadError();
        const task = z.object({ id: z.string().min(1).max(1024) }).passthrough().safeParse(parsed.data.task);
        if (!task.success || task.data.id !== taskId) {
          send(response, 400, { status: "invalid-task" });
          return;
        }
        const result = await agent.patch(runId, token, parsed.data.task, parsed.data.context, { images: parsed.data.images, feedback: parsed.data.feedback });
        send(response, result.status === "accepted" ? 200 : 422, result);
      } catch (error) {
        if (error instanceof LargePayloadError) send(response, 413, { status: "too-large" });
        else if (error instanceof SyntaxError || error instanceof z.ZodError) send(response, 400, { status: "invalid-request" });
        else if (error instanceof Error && /per-run|limit exceeded/i.test(error.message)) send(response, 429, { status: "limited" });
        else if (error instanceof Error && /in flight|concurrent update conflict/i.test(error.message)) send(response, 409, { status: "in-flight" });
        else if (error instanceof Error && /sealed/i.test(error.message)) send(response, 409, { status: "run-closed" });
        else if (error instanceof Error && /unknown usage|blocked/i.test(error.message)) send(response, 503, { status: "usage-unreconciled" });
        else if (error instanceof Error && /context|source|task/i.test(error.message)) send(response, 400, { status: "invalid-request" });
        else send(response, 503, { status: "unavailable" });
      }
    })().catch(() => {
      if (!response.writableEnded) send(response, 503, { status: "unavailable" });
    });
  };
}

/** Private coordinator only; public webhooks use their separate receiver. */
export function createHostedAgentServer(options: Pick<HostedRunWorkflowDependencies, "store" | "verifyTrustedResult" | "receiveCandidate"> & { agent: HostedPatchAgent }) {
  const patches = createHostedAgentHandler(options.agent);
  const runs = createHostedRunHandler(new HostedRunWorkflow({
    store: options.store,
    authenticate: (runId, token) => options.agent.inspectRun(runId, token),
    verifyTrustedResult: options.verifyTrustedResult,
    ...(options.receiveCandidate ? { receiveCandidate: options.receiveCandidate } : {}),
  }));
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    (patchPath.test(path) ? patches : runs)(request, response);
  });
  server.requestTimeout = defaults.hostedHttpRequestTimeoutMs;
  server.headersTimeout = defaults.hostedHttpHeadersTimeoutMs;
  return server;
}

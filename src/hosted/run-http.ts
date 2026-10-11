import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";

import type { HostedRunWorkflow } from "./run-workflow.js";
import { defaults } from "../config.js";

const pathSchema = /^\/runs\/([A-Za-z0-9_-]{1,64})\/(results|candidate|finish|status)$/;
const maxBodyBytes = 128 * 1024;
class OversizedReport extends Error {
  constructor() { super("Run submission exceeds byte limit"); }
}

function send(response: ServerResponse, code: number, data: object): void {
  const output = JSON.stringify(data);
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(output),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(output);
}

async function readBody(request: IncomingMessage, maxBytes = maxBodyBytes): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > maxBytes) {
    request.resume();
    throw new OversizedReport();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const part of request as AsyncIterable<Buffer>) {
    length += part.length;
    if (length > maxBytes) throw new OversizedReport();
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * Local trusted-service run orchestration. A job-provided RunReport is
 * *untrusted*: finish cannot publish, and marks ready-for-review ONLY if a
 * trusted coordinator independently validates its exact report digest.
 * Cloud use requires Firestore transactions and private service ingress.
 */
export function createHostedRunHandler(workflow: HostedRunWorkflow): RequestListener {
  return (request, response) => {
    void (async () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const match = pathSchema.exec(path);
      if (!match) {
        send(response, 404, { status: "not-found" });
        return;
      }
      const runId = match[1] ?? "";
      const action = match[2] ?? "";
      const isStatus = action === "status";
      if ((isStatus && request.method !== "GET") || (!isStatus && request.method !== "POST")) {
        send(response, 405, { status: "method-not-allowed" });
        return;
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? "")?.[1];
      if (!token) {
        send(response, 401, { status: "unauthorized" });
        return;
      }
      try {
        // Authenticate before reading a potentially sensitive target payload.
        await workflow.inspect(runId, token);
      } catch {
        send(response, 401, { status: "unauthorized" });
        return;
      }
      if (isStatus) {
        const data = await workflow.inspect(runId, token);
        send(response, data === undefined ? 404 : 200, data ?? { status: "not-found" });
        return;
      }
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        send(response, 415, { status: "unsupported-media-type" });
        return;
      }
      try {
        const body = await readBody(request, action === "candidate" ? defaults.hostedMaxCandidateBodyBytes : maxBodyBytes);
        if (action === "candidate") {
          send(response, 202, await workflow.submitCandidate(runId, token, body));
          return;
        }
        if (action === "results") {
          const result = await workflow.submitResults(runId, token, body);
          send(response, 202, result);
          return;
        }
        z.object({}).strict().parse(body);
        const result = await workflow.finish(runId, token);
        send(response, result.status === "blocked" ? 409 : 200, result);
      } catch (error) {
        if (error instanceof OversizedReport) send(response, 413, { status: "too-large" });
        else if (error instanceof z.ZodError || error instanceof SyntaxError) send(response, 400, { status: "invalid-request" });
        else if (error instanceof Error && /before finish|not.*submitted/i.test(error.message)) send(response, 409, { status: "run-not-ready" });
        else if (error instanceof Error && /verification.*in progress/i.test(error.message)) send(response, 409, { status: "verification-pending" });
        else if (error instanceof Error && /staging.*pending/i.test(error.message)) send(response, 409, { status: "candidate-pending" });
        else if (error instanceof Error && /conflict|changed|already exists/i.test(error.message)) send(response, 409, { status: "conflict" });
        else send(response, 503, { status: "unavailable" });
      }
    })().catch(() => {
      if (!response.writableEnded) send(response, 503, { status: "unavailable" });
    });
  };
}

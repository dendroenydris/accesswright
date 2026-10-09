import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { z } from "zod";

import type { CloudRunInvocation } from "./cloud-run-job.js";
import type { QueuedRun } from "./webhook.js";

const runSchema = z.object({
  runId: z.string().regex(/^[a-f0-9]{32}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  event: z.enum(["installation", "issue_comment"]),
  createdAt: z.iso.datetime(),
  pullNumber: z.number().int().positive().nullable(),
}).strict();
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const maxBytes = 16 * 1024;

export interface CloudRunDispatchDependencies {
  /** Verify signed Cloud Tasks OIDC token, subject and expected audience. */
  authenticateTask: (authorization: string) => Promise<boolean>;
  /** Durable create-only claim for the unique runId, never an in-memory-only check in production. */
  claim: (run: QueuedRun) => Promise<boolean>;
  /** Register a fresh opaque token with the private Agent API before launch. */
  registerRunToken: (run: QueuedRun) => Promise<string>;
  invokeJob: (run: QueuedRun, token: string) => Promise<CloudRunInvocation>;
  /** Durable, redacted operation metadata; a failed write must not trigger a duplicate launch. */
  recordOutcome: (run: QueuedRun, operation: string | null) => Promise<void>;
}
export interface TaskDispatchResult {
  runId: string;
  status: "launched" | "duplicate";
}

/**
 * No untrusted repo data can select a Cloud Run Job image, cloud project or
 * network destination. A consumed claim is NEVER released or blindly retried
 * after uncertain Cloud Run replies. Manual reconciliation is required.
 */
export class CloudRunTaskDispatcher {
  private readonly dependencies: CloudRunDispatchDependencies;

  constructor(dependencies: CloudRunDispatchDependencies) {
    this.dependencies = dependencies;
  }

  async dispatch(rawRun: unknown, authorization: string): Promise<TaskDispatchResult> {
    if (!await this.dependencies.authenticateTask(authorization)) {
      throw new Error("Cloud Task OIDC authorization failed");
    }
    const run = runSchema.parse(rawRun);
    if (!await this.dependencies.claim(run)) {
      return { runId: run.runId, status: "duplicate" };
    }
    let operation: string | null = null;
    try {
      const token = tokenSchema.safeParse(await this.dependencies.registerRunToken(run));
      if (!token.success) throw new Error("Scoped run registration failed");
      const started = await this.dependencies.invokeJob(run, token.data);
      if (started.runId !== run.runId) throw new Error("Cloud Run returned mismatched run identity");
      operation = started.operation;
      await this.dependencies.recordOutcome(run, operation);
      return { runId: run.runId, status: "launched" };
    } catch (error) {
      // Even on a network failure, do not release the durable launch claim.
      // An operation might already have started; its state must be reconciled.
      try { await this.dependencies.recordOutcome(run, operation); }
      catch { /* no repeated invocation, even if recording also failed */ }
      throw error;
    }
  }
}

class OversizedJob extends Error {
  constructor() { super("Cloud Task request size limit"); }
}
function send(response: ServerResponse, code: number, data: object) {
  const body = JSON.stringify(data);
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}
async function boundedJson(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? "0") > maxBytes) {
    request.resume();
    throw new OversizedJob();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new OversizedJob();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Mount only behind authenticated private Cloud Run ingress, not on a public endpoint. */
export function createCloudRunTaskHandler(dispatcher: CloudRunTaskDispatcher): RequestListener {
  return (request, response) => {
    void (async () => {
      if (request.url !== "/internal/jobs") {
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
      try {
        const result = await dispatcher.dispatch(await boundedJson(request), request.headers.authorization ?? "");
        send(response, result.status === "launched" ? 202 : 200, result);
      } catch (error) {
        if (error instanceof OversizedJob) send(response, 413, { status: "too-large" });
        else if (error instanceof z.ZodError || error instanceof SyntaxError) send(response, 400, { status: "invalid-run" });
        else if (error instanceof Error && /OIDC authorization/i.test(error.message)) send(response, 401, { status: "unauthorized" });
        else send(response, 503, { status: "requires-reconciliation" });
      }
    })().catch(() => {
      if (!response.writableEnded) send(response, 503, { status: "requires-reconciliation" });
    });
  };
}

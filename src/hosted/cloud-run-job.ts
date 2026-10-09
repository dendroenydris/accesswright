import { z } from "zod";

import type { QueuedRun } from "./webhook.js";

const projectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,30}[a-z0-9]$/);
const regionSchema = z.string().regex(/^[a-z][a-z0-9]+(?:-[a-z0-9]+)+$/);
const jobSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/);
const containerSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/);
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/, "A scoped 256-bit run token is required");
const queuedRunSchema = z.object({
  runId: z.string().regex(/^[a-f0-9]{32}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  event: z.enum(["installation", "issue_comment"]),
  createdAt: z.iso.datetime(),
  pullNumber: z.number().int().positive().nullable(),
}).strict();
const operationSchema = z.object({
  name: z.string().regex(/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/operations\/[A-Za-z0-9_-]+$/),
  done: z.boolean().optional(),
  error: z.object({ code: z.number().int().optional() }).passthrough().optional(),
}).passthrough();

async function readBoundedOperation(response: Response): Promise<z.infer<typeof operationSchema>> {
  if (Number(response.headers.get("content-length") ?? 0) > 12000) {
    await response.body?.cancel();
    throw new Error("Cloud Run operation response exceeded size limit");
  }
  if (!response.body) throw new Error("Cloud Run operation response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > 12000) {
        await reader.cancel();
        throw new Error("Cloud Run operation response exceeded size limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return operationSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
}

export interface CloudRunJobOptions {
  projectId: string;
  region: string;
  jobId: string;
  containerName: string;
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}

export interface CloudRunInvocation {
  runId: string;
  operation: string;
}

/**
 * Trusted coordinator only. Launches an already-deployed Cloud Run Job by
 * immutable name. The job environment contains a random, short-lived run
 * token and public run metadata — never OpenAI, GitHub or service account keys.
 *
 * The caller MUST first acquire a durable dispatch claim and register the
 * token with the private agent API. Uncertain responses must not be retried
 * blindly; Cloud Run Jobs.run has no automatic exactly-once guarantee.
 */
export class CloudRunJobInvoker {
  private readonly url: string;
  private readonly operationPrefix: string;
  private readonly containerName: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetcher: typeof fetch;

  constructor(options: CloudRunJobOptions) {
    const project = projectSchema.parse(options.projectId);
    const region = regionSchema.parse(options.region);
    const job = jobSchema.safeParse(options.jobId);
    if (!job.success) throw new Error("Invalid Cloud Run job identifier");
    this.containerName = containerSchema.parse(options.containerName);
    this.url = "https://run.googleapis.com/v2/projects/" + project +
      "/locations/" + region + "/jobs/" + job.data + ":run";
    this.operationPrefix = "projects/" + project + "/locations/" + region + "/operations/";
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetcher ?? fetch;
  }

  /** Read-only reconciliation; never re-dispatch a run based on operation polling. */
  async inspectOperation(operation: string): Promise<{
    operation: string;
    status: "pending" | "succeeded" | "failed";
  }> {
    const name = operationSchema.shape.name.parse(operation);
    if (!name.startsWith(this.operationPrefix)) {
      throw new Error("Cloud Run operation identity does not belong to this coordinator");
    }
    const identity = await this.getAccessToken();
    if (!identity || identity.length > 4096 || /[\r\n]/.test(identity)) {
      throw new Error("Cloud Run workload identity is unavailable");
    }
    const response = await this.fetcher("https://run.googleapis.com/v2/" + name, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: "Bearer " + identity, Accept: "application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Cloud Run operation inspect failed (HTTP " + response.status + ")");
    }
    const result = await readBoundedOperation(response);
    if (result.name !== name) throw new Error("Cloud Run operation identity mismatch");
    const status = result.done !== true ? "pending" : result.error ? "failed" : "succeeded";
    return { operation: name, status };
  }

  async start(input: QueuedRun, rawToken: string): Promise<CloudRunInvocation> {
    const run = queuedRunSchema.parse(input);
    const runToken = tokenSchema.safeParse(rawToken);
    if (!runToken.success) throw new Error("A scoped 256-bit run token is required");
    const identity = await this.getAccessToken();
    if (!identity || identity.length > 4096 || /[\r\n]/.test(identity)) {
      throw new Error("Cloud Run workload identity is unavailable");
    }
    const env = [
      { name: "ACCESSWRIGHT_RUN_ID", value: run.runId },
      { name: "ACCESSWRIGHT_RUN_TOKEN", value: runToken.data },
      { name: "ACCESSWRIGHT_REPOSITORY", value: run.repository },
      { name: "ACCESSWRIGHT_INSTALLATION_ID", value: String(run.installationId) },
      { name: "ACCESSWRIGHT_PR_NUMBER", value: run.pullNumber === null ? "" : String(run.pullNumber) },
    ];
    const body = {
      overrides: {
        taskCount: 1,
        timeout: "1800s",
        containerOverrides: [{ name: this.containerName, env }],
      },
    };
    const response = await this.fetcher(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: "Bearer " + identity,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Cloud Run Jobs invocation failed (HTTP " + response.status + ")");
    }
    const operation = (await readBoundedOperation(response)).name;
    if (!operation.startsWith(this.operationPrefix)) {
      throw new Error("Cloud Run returned an unexpected operation identity");
    }
    return { runId: run.runId, operation };
  }
}

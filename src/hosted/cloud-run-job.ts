import { z } from "zod";
import { defaults } from "../config.js";

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
  response: z.record(z.string(), z.unknown()).optional(),
}).passthrough().refine(operation => !(operation.error && operation.response) &&
  (operation.done === true || (operation.error === undefined && operation.response === undefined)), "Contradictory Cloud Run operation result");

const executionSchema = z.object({
  name: z.string(), job: z.string(), taskCount: z.number().int().positive(),
  startTime: z.iso.datetime().optional(), completionTime: z.iso.datetime().optional(), reconciling: z.boolean().optional(),
  succeededCount: z.number().int().nonnegative().optional(), failedCount: z.number().int().nonnegative().optional(),
  cancelledCount: z.number().int().nonnegative().optional(), runningCount: z.number().int().nonnegative().optional(),
  conditions: z.array(z.object({ type: z.string(), state: z.string() })),
  template: z.object({ containers: z.array(z.object({ name: z.string(),
    env: z.array(z.object({ name: z.string(), value: z.string().optional(), valueSource: z.unknown().optional() })) })) }),
});

const inventoryExecutionSchema = z.object({
  name: z.string().max(250), job: z.string().max(250), createTime: z.iso.datetime(),
  startTime: z.iso.datetime().optional(), completionTime: z.iso.datetime().optional(),
  deleteTime: z.iso.datetime().optional(), expireTime: z.iso.datetime().optional(),
}).refine(entry => Date.parse(entry.createTime) <= Date.now() &&
  [entry.startTime, entry.completionTime, entry.deleteTime].every(time => time === undefined ||
    (Date.parse(time) >= Date.parse(entry.createTime) && Date.parse(time) <= Date.now())) &&
  (entry.startTime === undefined || entry.completionTime === undefined || Date.parse(entry.completionTime) >= Date.parse(entry.startTime)) &&
  (entry.expireTime === undefined || Date.parse(entry.expireTime) >= Date.parse(entry.deleteTime ?? entry.createTime)), "Invalid execution inventory timestamp");
const inventoryPageSchema = z.object({
  executions: z.array(inventoryExecutionSchema).max(defaults.cloudRunExecutionPageSize).optional(),
  nextPageToken: z.string().max(4096).optional(),
});

async function readBoundedResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > defaults.cloudRunResponseMaxBytes) {
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
      if (total > defaults.cloudRunResponseMaxBytes) {
        await reader.cancel();
        throw new Error("Cloud Run operation response exceeded size limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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

export interface CloudRunExecutionObservation {
  runId: string;
  operation: string | null;
  execution: string | null;
  status: "succeeded" | "failed" | "running" | "unknown";
  observedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
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
  private readonly jobName: string;
  private readonly containerName: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetcher: typeof fetch;

  constructor(options: CloudRunJobOptions) {
    const project = projectSchema.parse(options.projectId);
    const region = regionSchema.parse(options.region);
    const job = jobSchema.safeParse(options.jobId);
    if (!job.success) throw new Error("Invalid Cloud Run job identifier");
    this.containerName = containerSchema.parse(options.containerName);
    this.jobName = "projects/" + project + "/locations/" + region + "/jobs/" + job.data;
    this.url = "https://run.googleapis.com/v2/" + this.jobName + ":run";
    this.operationPrefix = "projects/" + project + "/locations/" + region + "/operations/";
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetcher ?? fetch;
  }

  /** API-operation status only, not terminal execution evidence; never re-dispatch based on polling. */
  async inspectOperation(operation: string): Promise<{
    operation: string;
    status: "pending" | "succeeded" | "failed" | "unknown";
  }> {
    const result = await this.readOperation(operation);
    const status = result.done !== true ? "pending" : result.error ? "failed" : result.response ? "succeeded" : "unknown";
    return { operation: result.name, status };
  }

  private async readOperation(operation: string): Promise<z.infer<typeof operationSchema>> {
    const name = operationSchema.shape.name.parse(operation);
    if (!name.startsWith(this.operationPrefix)) {
      throw new Error("Cloud Run operation identity does not belong to this coordinator");
    }
    const result = operationSchema.parse(await this.readResource(name));
    if (result.name !== name) throw new Error("Cloud Run operation identity mismatch");
    return result;
  }

  private async readResource(name: string): Promise<unknown> {
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
    return readBoundedResponse(response);
  }

  /** Retained resource directory only; listing cannot prove a complete historical window or terminal outcomes. */
  async listExecutionInventory() {
    const executions: z.infer<typeof inventoryExecutionSchema>[] = [];
    const names = new Set<string>(), tokens = new Set<string>(), prefix = this.jobName + "/executions/";
    const query = new URLSearchParams({ pageSize: String(defaults.cloudRunExecutionPageSize), showDeleted: "true",
      fields: "executions(name,job,createTime,startTime,completionTime,deleteTime,expireTime),nextPageToken" });
    for (let page = 0; page < defaults.cloudRunExecutionMaxListPages; page += 1) {
      const result = inventoryPageSchema.parse(await this.readResource(this.jobName + "/executions?" + query.toString()));
      for (const execution of result.executions ?? []) {
        if (execution.job !== this.jobName || !execution.name.startsWith(prefix) ||
          !/^[A-Za-z0-9_-]+$/.test(execution.name.slice(prefix.length)) || names.has(execution.name)) {
          throw new Error("Cloud Run inventory execution identity is mismatched or repeated");
        }
        names.add(execution.name); executions.push(execution);
      }
      const token = result.nextPageToken ?? "";
      if (!token) return { observedAt: new Date().toISOString(), executions };
      if (tokens.has(token)) throw new Error("Cloud Run inventory repeated a pagination token");
      tokens.add(token); query.set("pageToken", token);
    }
    throw new Error("Cloud Run inventory exceeds page limit");
  }

  /** Read-only evidence from a fresh Execution GET; never a retry or publication authority. */
  async inspectExecution(input: QueuedRun, operation: string): Promise<CloudRunExecutionObservation> {
    const run = queuedRunSchema.parse(input), result = await this.readOperation(operation);
    const observed: CloudRunExecutionObservation = { runId: run.runId, operation: result.name, execution: null,
      status: "unknown", observedAt: new Date().toISOString(), startedAt: null, finishedAt: null };
    if (result.done !== true || result.error || typeof result.response?.name !== "string") return observed;
    const name = result.response.name, prefix = this.jobName + "/executions/";
    if (!name.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(name.slice(prefix.length))) {
      throw new Error("Cloud Run execution identity does not belong to this job");
    }
    const parsed = executionSchema.safeParse(await this.readResource(name));
    if (!parsed.success) throw new Error("Cloud Run execution identity or evidence is invalid");
    const execution = parsed.data, containers = execution.template.containers;
    if (execution.name !== name || execution.job !== this.jobName || containers.length !== 1 || containers[0]?.name !== this.containerName) {
      throw new Error("Cloud Run execution identity mismatch");
    }
    const markers = { ACCESSWRIGHT_RUN_ID: run.runId, ACCESSWRIGHT_REPOSITORY: run.repository,
      ACCESSWRIGHT_INSTALLATION_ID: String(run.installationId), ACCESSWRIGHT_PR_NUMBER: run.pullNumber === null ? "" : String(run.pullNumber) };
    for (const [key, value] of Object.entries(markers)) {
      const entries = containers[0].env.filter(entry => entry.name === key);
      // Protobuf JSON omits the empty string for an installation run's PR marker.
      if (entries.length !== 1 || entries[0]?.valueSource !== undefined || (entries[0]?.value ?? "") !== value) throw new Error("Cloud Run execution run identity mismatch");
    }
    const completed = execution.conditions.filter(condition => condition.type === "Completed");
    if (completed.length > 1) throw new Error("Cloud Run execution condition is ambiguous");
    observed.execution = name;
    observed.observedAt = new Date().toISOString();
    observed.startedAt = execution.startTime ?? null;
    const start = execution.startTime ? Date.parse(execution.startTime) : NaN;
    if (execution.taskCount !== 1 || !Number.isFinite(start) || start < Date.parse(run.createdAt) || start > Date.parse(observed.observedAt)) return observed;
    // Protobuf JSON omits counters with their declared zero value.
    const succeeded = execution.succeededCount ?? 0, failed = execution.failedCount ?? 0;
    const cancelled = execution.cancelledCount ?? 0, running = execution.runningCount ?? 0;
    const state = completed[0]?.state;
    if (!execution.completionTime) {
      if (["CONDITION_PENDING", "CONDITION_RECONCILING"].includes(state ?? "") && running === 1 && succeeded + failed + cancelled === 0) observed.status = "running";
      return observed;
    }
    const finish = Date.parse(execution.completionTime);
    if (execution.reconciling === true || finish < start || finish > Date.parse(observed.observedAt) || running !== 0) return observed;
    if (state === "CONDITION_SUCCEEDED" && succeeded === 1 && failed + cancelled === 0) observed.status = "succeeded";
    if (state === "CONDITION_FAILED" && succeeded === 0 && failed + cancelled === 1) observed.status = "failed";
    if (observed.status !== "unknown") observed.finishedAt = execution.completionTime;
    return observed;
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
    const operation = operationSchema.parse(await readBoundedResponse(response)).name;
    if (!operation.startsWith(this.operationPrefix)) {
      throw new Error("Cloud Run returned an unexpected operation identity");
    }
    return { runId: run.runId, operation };
  }
}

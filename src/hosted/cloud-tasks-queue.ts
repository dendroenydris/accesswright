import { z } from "zod";
import { defaults } from "../config.js";

import type { QueuedRun } from "./webhook.js";

const projectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,30}[a-z0-9]$/);
const regionSchema = z.string().regex(/^[a-z][a-z0-9]+(?:-[a-z0-9]+)+$/);
const queueSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/);
const accountSchema = z.string().regex(/^[a-zA-Z0-9-]+@[a-z][a-z0-9-]{4,30}[a-z0-9]\.iam\.gserviceaccount\.com$/);
const queuedRunSchema = z.object({
  runId: z.string().regex(/^[a-f0-9]{32}$/),
  repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  event: z.enum(["installation", "issue_comment"]),
  createdAt: z.iso.datetime(),
  pullNumber: z.number().int().positive().nullable(),
}).strict();
const responseSchema = z.object({ name: z.string().max(512), dispatchDeadline: z.string().regex(/^[0-9]+(?:\.[0-9]+)?s$/),
  httpRequest: z.object({ httpMethod: z.literal("POST"), url: z.string().max(512), body: z.string().max(defaults.firestoreRecordMaxBytes),
    oidcToken: z.object({ serviceAccountEmail: z.string().max(256), audience: z.string().max(256) }).passthrough() }).passthrough() }).passthrough();

async function confirmedResponse(response: Response): Promise<z.infer<typeof responseSchema>> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || !Number.isFinite(declared) || declared < 0 || declared > defaults.firestoreRecordMaxBytes || !response.body) {
    await response.body?.cancel(); throw new Error("Cloud Tasks run enqueue is unconfirmed (HTTP " + response.status + ")");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > defaults.firestoreRecordMaxBytes) throw new Error("Cloud Tasks run response exceeds its bound");
      chunks.push(next.value);
    }
    return responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  } catch { throw new Error("Cloud Tasks run response identity is unconfirmed"); }
  finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

export interface CloudTasksRunQueueOptions {
  projectId: string;
  region: string;
  queueId: string;
  /** A trusted, private Cloud Run dispatcher, not a repository-provided URL. */
  targetUrl: string;
  serviceAccountEmail: string;
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}

export interface CloudTasksQueueResult {
  status: "queued" | "duplicate";
  runId: string;
}

/**
 * A Cloud Tasks transport for bounded run metadata only. Service account OIDC
 * authenticates the dispatch; the target job still needs durable idempotence
 * before starting Cloud Run Jobs. No secrets or repository source are enqueued.
 */
export class CloudTasksRunQueue {
  private readonly url: string;
  private readonly targetUrl: string;
  private readonly audience: string;
  private readonly serviceAccountEmail: string;
  private readonly fetcher: typeof fetch;
  private readonly getAccessToken: () => Promise<string>;
  private readonly taskPrefix: string;

  constructor(options: CloudTasksRunQueueOptions) {
    const projectId = projectSchema.parse(options.projectId);
    const region = regionSchema.parse(options.region);
    const queue = queueSchema.parse(options.queueId);
    const account = accountSchema.parse(options.serviceAccountEmail);
    if (account.split("@")[1] !== projectId + ".iam.gserviceaccount.com") {
      throw new Error("Cloud Tasks service account must belong to the selected project");
    }
    const target = new URL(options.targetUrl);
    if (target.protocol !== "https:" ||
      !target.hostname.endsWith(".run.app") ||
      target.pathname !== "/internal/jobs" ||
      target.port || target.username || target.password || target.search || target.hash) {
      throw new Error("Cloud Tasks target must be the trusted HTTPS Cloud Run jobs dispatcher");
    }
    this.url = "https://cloudtasks.googleapis.com/v2/projects/" + projectId +
      "/locations/" + region + "/queues/" + queue + "/tasks";
    this.taskPrefix = "projects/" + projectId + "/locations/" + region +
      "/queues/" + queue + "/tasks/";
    this.targetUrl = target.href;
    this.audience = target.origin;
    this.serviceAccountEmail = account;
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetcher ?? fetch;
  }

  async enqueue(input: QueuedRun): Promise<CloudTasksQueueResult> {
    const run = queuedRunSchema.parse(input);
    const token = await this.getAccessToken();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new Error("Cloud Tasks workload identity is unavailable");
    }
    const name = this.taskPrefix + run.runId;
    const task = {
      task: {
        name,
        dispatchDeadline: String(defaults.hostedJobDispatchDeadlineSeconds) + "s",
        httpRequest: {
          httpMethod: "POST",
          url: this.targetUrl,
          headers: { "Content-Type": "application/json" },
          body: Buffer.from(JSON.stringify(run)).toString("base64"),
          oidcToken: {
            serviceAccountEmail: this.serviceAccountEmail,
            audience: this.audience,
          },
        },
      },
    };
    let response = await this.fetcher(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(defaults.hostedHttpHeadersTimeoutMs),
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...task, responseView: "FULL" }),
    });
    const duplicate = response.status === 409;
    if (response.status === 409) {
      await response.body?.cancel();
      // Recently deleted task names also return 409; prove the exact task still exists.
      response = await this.fetcher("https://cloudtasks.googleapis.com/v2/" + name + "?responseView=FULL", {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(defaults.hostedHttpHeadersTimeoutMs),
        headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      });
    }
    const saved = await confirmedResponse(response), expected = task.task;
    if (saved.name !== name || parseFloat(saved.dispatchDeadline) !== parseFloat(expected.dispatchDeadline) ||
      saved.httpRequest.url !== expected.httpRequest.url || saved.httpRequest.body !== expected.httpRequest.body ||
      saved.httpRequest.oidcToken.serviceAccountEmail !== this.serviceAccountEmail || saved.httpRequest.oidcToken.audience !== this.audience) {
      throw new Error("Cloud Tasks run identity or deadline changed");
    }
    return { status: duplicate ? "duplicate" : "queued", runId: run.runId };
  }
}

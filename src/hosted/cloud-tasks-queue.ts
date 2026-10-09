import { z } from "zod";

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
      !target.hostname.endsWith(".a.run.app") ||
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
        dispatchDeadline: "30s",
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
    const response = await this.fetcher(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(task),
    });
    if (response.status === 409) {
      await response.body?.cancel();
      return { status: "duplicate", runId: run.runId };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Cloud Tasks run enqueue failed (HTTP " + response.status + ")");
    }
    await response.body?.cancel();
    return { status: "queued", runId: run.runId };
  }
}

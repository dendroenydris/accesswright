import { z } from "zod";
import { defaults } from "../config.js";
import type { CloudTasksRunQueueOptions } from "./cloud-tasks-queue.js";

const runSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const responseSchema = z.object({ name: z.string().max(512), dispatchDeadline: z.string().regex(/^[0-9]+(?:\.[0-9]+)?s$/),
  scheduleTime: z.iso.datetime({ precision: null }), httpRequest: z.object({ httpMethod: z.literal("POST"), url: z.string().max(512), body: z.string().max(4096),
    oidcToken: z.object({ serviceAccountEmail: z.string().max(256), audience: z.string().max(256) }).passthrough() }).passthrough() }).passthrough();
export type CloudTasksCandidateQueueOptions = Omit<CloudTasksRunQueueOptions, "targetUrl"> & { targetOrigin: string };

async function boundedResponse(response: Response): Promise<unknown> {
  const size = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || !Number.isFinite(size) || size < 0 || size > defaults.firestoreRecordMaxBytes || !response.body) {
    await response.body?.cancel(); throw new Error("Candidate task registration is unconfirmed");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length; if (length > defaults.firestoreRecordMaxBytes) throw new Error("Candidate task response exceeds its bound");
      chunks.push(next.value);
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("Candidate task response is not valid JSON"); }
}

/** Only metadata is enqueued. A duplicate name is accepted only while its exact authenticated task still exists. */
export class CloudTasksCandidateQueue {
  private readonly base: string;
  private readonly prefix: string;
  private readonly origin: string;
  private readonly options: CloudTasksCandidateQueueOptions;
  constructor(options: CloudTasksCandidateQueueOptions) {
    const project = z.string().regex(/^[a-z][a-z0-9-]{4,30}[a-z0-9]$/).parse(options.projectId);
    const region = z.string().regex(/^[a-z][a-z0-9]+(?:-[a-z0-9]+)+$/).parse(options.region);
    const queue = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/).parse(options.queueId);
    const account = z.string().regex(/^[A-Za-z0-9-]+@[a-z][a-z0-9-]{4,30}[a-z0-9]\.iam\.gserviceaccount\.com$/).parse(options.serviceAccountEmail);
    if (account.split("@")[1] !== project + ".iam.gserviceaccount.com") throw new Error("Candidate task identity must belong to the selected project");
    const origin = new URL(options.targetOrigin);
    if (origin.protocol !== "https:" || !origin.hostname.endsWith(".run.app") || origin.pathname !== "/" ||
      origin.port || origin.username || origin.password || origin.search || origin.hash) throw new Error("Candidate tasks require a trusted private Cloud Run origin");
    this.prefix = "projects/" + project + "/locations/" + region + "/queues/" + queue + "/tasks/";
    this.base = "https://cloudtasks.googleapis.com/v2/" + this.prefix.slice(0, -1);
    this.origin = origin.origin; this.options = Object.freeze({ ...options, serviceAccountEmail: account });
  }
  async enqueueVerification(rawRunId: string, reportDigest: string): Promise<void> {
    const runId = runSchema.parse(rawRunId), digest = z.string().regex(/^[a-f0-9]{64}$/).parse(reportDigest);
    await this.enqueue("verify", runId, { runId, reportDigest: digest }, defaults.hostedVerificationDeadlineSeconds);
  }
  async enqueueExpiry(rawRunId: string, rawExpiresAt: string): Promise<void> {
    const runId = runSchema.parse(rawRunId), expiresAt = z.iso.datetime().parse(rawExpiresAt), remaining = Date.parse(expiresAt) - Date.now();
    if (remaining <= 0 || remaining > defaults.hostedMaxTtlSeconds * 1000) throw new Error("Candidate expiry must be the bounded original future deadline");
    await this.enqueue("expire", runId, { runId, expiresAt }, defaults.hostedExpiryDeadlineSeconds, expiresAt);
  }
  private async request(url: string, body?: object): Promise<Response> {
    const token = await this.options.getAccessToken();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("Candidate task workload identity unavailable");
    try {
      return await (this.options.fetcher ?? fetch)(url, { method: body ? "POST" : "GET", redirect: "error", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(defaults.hostedHttpHeadersTimeoutMs), headers: { authorization: "Bearer " + token, accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error("Candidate task transport is unconfirmed"); }
  }
  private async enqueue(kind: "verify" | "expire", runId: string, payload: object, deadline: number, expiresAt?: string): Promise<void> {
    const name = this.prefix + kind + "-" + runId;
    const httpRequest = { httpMethod: "POST", url: this.origin + "/internal/candidates/" + kind,
      headers: { "Content-Type": "application/json" }, body: Buffer.from(JSON.stringify(payload)).toString("base64"),
      oidcToken: { serviceAccountEmail: this.options.serviceAccountEmail, audience: this.origin } };
    const task = { name, dispatchDeadline: String(deadline) + "s", httpRequest, ...(expiresAt ? { scheduleTime: expiresAt } : {}) };
    let response = await this.request(this.base, { task, responseView: "FULL" });
    if (response.status === 409) {
      await response.body?.cancel();
      // Cloud Tasks also reserves recently deleted names; 409 alone is not a live cleanup task.
      response = await this.request("https://cloudtasks.googleapis.com/v2/" + name + "?responseView=FULL");
    }
    const saved = responseSchema.parse(await boundedResponse(response));
    if (saved.name !== name || parseFloat(saved.dispatchDeadline) !== deadline || saved.httpRequest.httpMethod !== httpRequest.httpMethod ||
      saved.httpRequest.url !== httpRequest.url || saved.httpRequest.body !== httpRequest.body ||
      saved.httpRequest.oidcToken.serviceAccountEmail !== this.options.serviceAccountEmail || saved.httpRequest.oidcToken.audience !== this.origin ||
      (expiresAt !== undefined && Date.parse(saved.scheduleTime) < Date.parse(expiresAt))) throw new Error("Candidate task identity or deadline changed");
  }
}

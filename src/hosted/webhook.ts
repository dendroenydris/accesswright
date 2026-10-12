import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const MAX_WEBHOOK_BYTES = 1_048_576;
const DeliverySchema = z.string().uuid();
const FullNameSchema = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
const RepositorySchema = z.object({ full_name: FullNameSchema, private: z.boolean() }).passthrough();

export interface WebhookHeaders {
  "x-hub-signature-256"?: string;
  "x-github-event"?: string;
  "x-github-delivery"?: string;
}

/** Verify raw transport bytes before parsing, with bounded work and constant-time digest comparison. */
export function verifyGitHubSignature(body: Uint8Array, signature: string | undefined, secret: string): boolean {
  if (body.byteLength > MAX_WEBHOOK_BYTES) throw new Error("Webhook body exceeds size limit");
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const provided = Buffer.from(signature.slice(7), "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const CommonPayloadSchema = z.object({
  installation: z.object({ id: z.number().int().positive() }).passthrough(),
  sender: z.object({ login: z.string().min(1).max(100) }).passthrough(),
  action: z.string().min(1),
}).passthrough();

export interface QueuedRun {
  runId: string;
  repository: string;
  installationId: number;
  event: "installation" | "issue_comment";
  createdAt: string;
  pullNumber: number | null;
}

export interface WebhookDispatchResult {
  status: "queued" | "ignored" | "duplicate" | "unauthorized";
  runIds: string[];
}

export interface WebhookRunRegistry {
  claim(key: string, delivery: string): boolean | Promise<boolean>;
  commit(key: string, run: QueuedRun): void | Promise<void>;
  release(key: string, delivery: string): void | Promise<void>;
}

export interface WebhookDispatchDependencies {
  secret: string;
  installationAllowlist: ReadonlySet<number>;
  repositoryAllowlist: ReadonlySet<string>;
  registry: WebhookRunRegistry;
  queue: (run: QueuedRun) => Promise<void>;
  authorizeComment: (context: {
    repository: string; pullNumber: number; sender: string; installationId: number;
  }) => Promise<boolean>;
}

/** In-process adapter for local integration; production must use a durable compare-and-set store. */
export class InMemoryRunRegistry {
  private readonly committed = new Map<string, QueuedRun>();
  private readonly claimed = new Set<string>();
  private readonly deliveries = new Set<string>();

  claim(key: string, delivery: string): boolean {
    if (this.committed.has(key) || this.claimed.has(key) || this.deliveries.has(delivery)) return false;
    this.claimed.add(key);
    this.deliveries.add(delivery);
    return true;
  }

  commit(key: string, run: QueuedRun): void {
    if (!this.claimed.has(key)) throw new Error("Attempted to commit unclaimed webhook run");
    this.committed.set(key, { ...run });
    this.claimed.delete(key);
  }

  release(key: string, delivery: string): void {
    this.claimed.delete(key);
    this.deliveries.delete(delivery);
  }

  list(): QueuedRun[] {
    return [...this.committed.values()].map(item => ({ ...item }));
  }
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function dispatchGitHubWebhook(
  body: Uint8Array,
  headers: WebhookHeaders,
  dependencies: WebhookDispatchDependencies,
): Promise<WebhookDispatchResult> {
  if (!verifyGitHubSignature(body, headers["x-hub-signature-256"], dependencies.secret)) {
    return { status: "unauthorized", runIds: [] };
  }
  const delivery = DeliverySchema.parse(headers["x-github-delivery"]);
  const event = headers["x-github-event"];
  if (event !== "installation" && event !== "issue_comment") {
    return { status: "ignored", runIds: [] };
  }
  const payload = CommonPayloadSchema.parse(JSON.parse(Buffer.from(body).toString("utf8")) as unknown);
  if (!dependencies.installationAllowlist.has(payload.installation.id)) {
    return { status: "unauthorized", runIds: [] };
  }
  if (payload.action !== "created") return { status: "ignored", runIds: [] };

  let repositories: string[];
  let commentId: number | null = null;
  let pullNumber: number | null = null;
  const allowed = new Set([...dependencies.repositoryAllowlist].map(value => value.toLowerCase()));
  if (event === "installation") {
    const installation = z.object({ repositories: z.array(RepositorySchema) }).parse(payload);
    repositories = [...new Set(installation.repositories.map(repo => repo.full_name.toLowerCase()))].filter(repo => allowed.has(repo));
  } else {
    const comment = z.object({
      repository: RepositorySchema,
      issue: z.object({
        number: z.number().int().positive(),
        pull_request: z.object({}).passthrough(),
      }).passthrough(),
      comment: z.object({ body: z.string().max(20_000), id: z.number().int().positive() }).passthrough(),
    }).parse(payload);
    if (!allowed.has(comment.repository.full_name.toLowerCase())) return { status: "unauthorized", runIds: [] };
    if (comment.comment.body.trim() !== "/accesswright fix") {
      return { status: "ignored", runIds: [] };
    }
    pullNumber = comment.issue.number;
    if (!await dependencies.authorizeComment({
      repository: comment.repository.full_name,
      pullNumber,
      sender: payload.sender.login,
      installationId: payload.installation.id,
    })) {
      return { status: "unauthorized", runIds: [] };
    }
    repositories = [comment.repository.full_name.toLowerCase()];
    commentId = comment.comment.id;
  }

  const runIds: string[] = [];
  let queued = false;
  for (const repository of repositories) {
    const key = event === "installation" ? "installation|" + payload.installation.id + "|" + repository :
      "comment|" + payload.installation.id + "|" + repository + "|" + commentId;
    // A single installation delivery can contain multiple independent repositories.
    const deliveryKey = stableId(delivery + "|" + repository), runId = stableId(key).slice(0, 32);
    runIds.push(runId);
    if (!await dependencies.registry.claim(key, deliveryKey)) continue;
    const run: QueuedRun = { runId, repository, installationId: payload.installation.id, event,
      createdAt: new Date().toISOString(), pullNumber };
    try {
      await dependencies.queue(run);
      await dependencies.registry.commit(key, run);
      queued = true;
    } catch (error) {
      await dependencies.registry.release(key, deliveryKey);
      throw error;
    }
  }
  return { status: queued ? "queued" : runIds.length ? "duplicate" : "ignored", runIds };
}

import { z } from "zod";
import { defaults } from "../config.js";
import { FirestoreMetadataStore } from "./firestore-metadata.js";

import type { QueuedRun } from "./webhook.js";

const projectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,30}[a-z0-9]$/, "Invalid Firestore dispatch project");
const collectionSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/);
const runSchema = z.object({
  runId: z.string().regex(/^[a-f0-9]{32}$/),
  repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  event: z.enum(["installation", "issue_comment"]),
  createdAt: z.iso.datetime(),
  pullNumber: z.number().int().positive().nullable(),
}).strict();

const metadataSchema = runSchema.extend({
  status: z.enum(["claimed", "launched", "requires-reconciliation"]),
  operation: z.string().max(250).nullable(),
}).strict();
export type DispatchClaim = z.infer<typeof metadataSchema>;

const firestoreResponse = z.object({
  updateTime: z.string().min(10).max(60).regex(/^[0-9TZ.:+-]+$/),
  fields: z.object({ payload: z.object({ stringValue: z.string().max(4096) }) }).passthrough(),
}).passthrough();

export interface DispatchClaimOptions {
  projectId: string;
  collectionId: string;
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}
interface ReadClaim {
  value: DispatchClaim;
  version: string;
}

async function boundedResponse(response: Response): Promise<unknown> {
  const maximum = defaults.hostedDispatchResponseMaxBytes;
  if (Number(response.headers.get("content-length") ?? "0") > maximum) {
    await response.body?.cancel();
    throw new Error("Firestore dispatch metadata response exceeds size limit");
  }
  if (!response.body) throw new Error("Firestore dispatch metadata response is empty");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("Firestore dispatch metadata response exceeds size limit");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * Production-style Firestore REST create-only idempotence ledger.
 * Cloud Run Jobs invocation must never occur without an atomic launch claim.
 * Unknown status is permanently held for manual reconciliation, not retried.
 * No source, credentials, run-scoped token or provider prompts are persisted.
 */
export class FirestoreDispatchClaims {
  private readonly documents: FirestoreMetadataStore<DispatchClaim>;
  private readonly url: string;
  private readonly fetcher: typeof fetch;
  private readonly getAccessToken: () => Promise<string>;

  constructor(options: DispatchClaimOptions) {
    this.documents = new FirestoreMetadataStore(options, metadataSchema);
    const project = projectSchema.parse(options.projectId);
    const collection = collectionSchema.parse(options.collectionId);
    this.url = "https://firestore.googleapis.com/v1/projects/" + project +
      "/databases/" + encodeURIComponent("(default)") + "/documents/" + collection;
    this.fetcher = options.fetcher ?? fetch;
    this.getAccessToken = options.getAccessToken;
  }

  private async request(method: "GET" | "POST" | "PATCH", path: string, record?: DispatchClaim): Promise<Response> {
    const identity = await this.getAccessToken();
    if (!identity || identity.length > 4096 || /[\r\n]/.test(identity)) {
      throw new Error("Firestore dispatch workload identity is unavailable");
    }
    return this.fetcher(this.url + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + identity,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(record === undefined ? {} : {
        body: JSON.stringify({ fields: { payload: { stringValue: JSON.stringify(record) } } }),
      }),
    });
  }

  private decode(raw: unknown, expected: string): ReadClaim {
    const document = firestoreResponse.parse(raw);
    const value = metadataSchema.parse(JSON.parse(document.fields.payload.stringValue) as unknown);
    if (value.runId !== expected) throw new Error("Firestore dispatch claim identity mismatch");
    return { value, version: document.updateTime };
  }

  private async readVersion(id: string): Promise<ReadClaim | undefined> {
    const runId = runSchema.shape.runId.parse(id);
    const response = await this.request("GET", "/" + runId);
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore claim read failed (HTTP " + response.status + ")");
    }
    return this.decode(await boundedResponse(response), runId);
  }

  async read(id: string): Promise<DispatchClaim | undefined> {
    const result = await this.readVersion(id);
    return result === undefined ? undefined : structuredClone(result.value);
  }

  async records(readTime: string): Promise<DispatchClaim[]> {
    return (await this.documents.versions(readTime)).map(({ record, updateTime }) => {
      if (Date.parse(updateTime) < Date.parse(record.createdAt)) throw new Error("Dispatch version predates its creation timestamp");
      return record;
    });
  }

  async claim(raw: QueuedRun): Promise<boolean> {
    const run = runSchema.parse(raw);
    const record: DispatchClaim = { ...run, status: "claimed", operation: null };
    const response = await this.request("POST", "?documentId=" + encodeURIComponent(run.runId), record);
    if (response.status === 409 || response.status === 412) {
      await response.body?.cancel();
      return false;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore claim create failed (HTTP " + response.status + ")");
    }
    const stored = this.decode(await boundedResponse(response), run.runId).value;
    if (JSON.stringify(stored) !== JSON.stringify(record)) {
      throw new Error("Firestore claim create result is not the requested metadata");
    }
    return true;
  }

  async recordOutcome(raw: QueuedRun, operation: string | null): Promise<void> {
    const run = runSchema.parse(raw);
    if (operation !== null && (
      operation.length > 250 ||
      !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/operations\/[A-Za-z0-9_-]+$/.test(operation)
    )) {
      throw new Error("Invalid Cloud Run operation reference");
    }
    const current = await this.readVersion(run.runId);
    if (!current) throw new Error("Firestore dispatch claim missing");
    const identity = (input: QueuedRun) => JSON.stringify(input);
    const fromStore: QueuedRun = {
      runId: current.value.runId,
      repository: current.value.repository,
      installationId: current.value.installationId,
      event: current.value.event,
      createdAt: current.value.createdAt,
      pullNumber: current.value.pullNumber,
    };
    if (identity(fromStore) !== identity(run)) throw new Error("Firestore dispatch run identity changed");
    if (current.value.status !== "claimed") {
      if (current.value.operation === operation) return;
      throw new Error("Terminal dispatch claim cannot be overwritten");
    }
    const updated: DispatchClaim = {
      ...current.value,
      status: operation === null ? "requires-reconciliation" : "launched",
      operation,
    };
    const path = "/" + encodeURIComponent(run.runId) +
      "?updateMask.fieldPaths=payload&currentDocument.updateTime=" +
      encodeURIComponent(current.version);
    const response = await this.request("PATCH", path, updated);
    if (response.status === 409 || response.status === 412 || response.status === 404) {
      await response.body?.cancel();
      throw new Error("Firestore dispatch outcome write conflict");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore dispatch outcome write failed (HTTP " + response.status + ")");
    }
    const stored = this.decode(await boundedResponse(response), run.runId).value;
    if (JSON.stringify(stored) !== JSON.stringify(updated)) {
      throw new Error("Firestore claim outcome mismatch");
    }
  }
}

import { z } from "zod";

const projectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,30}[a-z0-9]$/);
const collectionSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,62}$/);
const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const payloadSchema = z.object({
  runId: runIdSchema,
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  installationId: z.number().int().positive(),
  reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["staging", "recorded", "verifying", "blocked", "ready-for-review"]),
  acceptedFixes: z.number().int().min(0).max(200),
  eligibleForReview: z.boolean(),
  failedChecks: z.array(z.enum(["build", "typecheck", "lint", "tests"])).max(4),
  unknownUsage: z.boolean(),
  spentUsd: z.number().finite().nonnegative(),
  verifiedBaseSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  recordedAt: z.iso.datetime(),
}).strict();
export type DashboardRun = z.infer<typeof payloadSchema>;

const docSchema = z.object({
  name: z.string().min(1).max(512),
  fields: z.object({ payload: z.object({ stringValue: z.string().max(8192) }) }).passthrough(),
}).passthrough();
const pageSchema = z.object({
  documents: z.array(z.unknown()).max(50).optional(),
  nextPageToken: z.string().min(1).max(1024).optional(),
}).passthrough();
const metadataSchema = z.object({
  access_token: z.string().min(1).max(4096).regex(/^[^\r\n]+$/),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive().max(86400),
}).passthrough();

const metadataUrl = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/** Cloud Run workload identity only; no JSON key files, repository tokens or browser credentials. */
export async function workloadAccessToken(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(metadataUrl, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "Metadata-Flavor": "Google", Accept: "application/json" },
  });
  if (!response.ok || response.headers.get("Metadata-Flavor") !== "Google") {
    await response.body?.cancel();
    throw new Error("Google workload identity metadata is unavailable");
  }
  return metadataSchema.parse(await readBoundedJson(response, 8192)).access_token;
}

async function readBoundedJson(response: Response, maximum: number): Promise<unknown> {
  const claimed = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(claimed) || claimed > maximum) {
    await response.body?.cancel();
    throw new Error("Firestore response exceeds metadata-only bound");
  }
  if (!response.body) throw new Error("Firestore metadata response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error("Firestore response exceeds metadata-only bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parsedDocument(value: unknown, expectedId?: string): DashboardRun {
  const doc = docSchema.parse(value);
  const record = payloadSchema.parse(JSON.parse(doc.fields.payload.stringValue) as unknown);
  const suffix = doc.name.slice(doc.name.lastIndexOf("/") + 1);
  if (suffix !== record.runId || (expectedId !== undefined && record.runId !== expectedId)) {
    throw new Error("Firestore dashboard returned a mismatched run identity");
  }
  return record;
}

export interface FirestoreDashboardReaderOptions {
  projectId: string;
  collectionId: string;
  getAccessToken: () => Promise<string>;
  fetcher?: typeof fetch;
}

export interface DashboardRunPage {
  runs: DashboardRun[];
  /** This limit must be visible in the UI: a partial page is never called all runs. */
  limited: boolean;
}

/**
 * Read-only metadata projection, never a source/report/screenshot reader.
 * Cloud Run IAM must restrict this service account to metadata reads.
 */
export class FirestoreDashboardReader {
  private readonly base: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetcher: typeof fetch;

  constructor(options: FirestoreDashboardReaderOptions) {
    const project = projectSchema.parse(options.projectId);
    const collection = collectionSchema.parse(options.collectionId);
    this.base = "https://firestore.googleapis.com/v1/projects/" + project +
      "/databases/%28default%29/documents/" + collection;
    this.getAccessToken = options.getAccessToken;
    this.fetcher = options.fetcher ?? fetch;
  }

  private async request(url: string): Promise<Response> {
    const token = await this.getAccessToken();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
      throw new Error("Firestore dashboard workload identity unavailable");
    }
    const response = await this.fetcher(url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(15000),
      cache: "no-store",
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
    return response;
  }

  async get(runId: string): Promise<DashboardRun | undefined> {
    const id = runIdSchema.parse(runId);
    const response = await this.request(this.base + "/" + encodeURIComponent(id));
    if (response.status === 404) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Firestore dashboard get failed (HTTP " + response.status + ")");
    }
    return parsedDocument(await readBoundedJson(response, 16000), id);
  }

  async list(): Promise<DashboardRunPage> {
    const records: DashboardRun[] = [];
    const seen = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = this.base + "?pageSize=50" + (token ? "&pageToken=" + encodeURIComponent(token) : "");
      const response = await this.request(url);
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Firestore dashboard list failed (HTTP " + response.status + ")");
      }
      const found = pageSchema.parse(await readBoundedJson(response, 512000));
      for (const item of found.documents ?? []) {
        const record = parsedDocument(item);
        if (seen.has(record.runId)) throw new Error("Duplicate Firestore run record");
        seen.add(record.runId);
        records.push(record);
      }
      token = found.nextPageToken;
      if (!token) break;
    }
    records.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
    return { runs: records, limited: token !== undefined };
  }
}

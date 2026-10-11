import { z } from "zod";
import { defaults } from "../config.js";
import { HostedCandidateSchema, hostedCandidateDigest } from "./agent-protocol.js";
import type { HostedCandidate } from "./agent-protocol.js";

const runSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const generationSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
const envelopeSchema = z.object({ schemaVersion: z.literal(1), runId: runSchema, createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), candidate: HostedCandidateSchema }).strict();
const metadataSchema = z.object({ bucket: z.string(), name: z.string(), generation: generationSchema,
  size: z.string().regex(/^[0-9]{1,10}$/), temporaryHold: z.boolean().optional(), eventBasedHold: z.boolean().optional(), retention: z.unknown().optional() }).passthrough();

export interface HostedCandidateReference { generation: string; expiresAt: string; candidateDigest: string }
export interface GcsHostedCandidateStoreOptions {
  bucketName: string;
  getAccessToken: () => Promise<string>;
  /** Must durably schedule an authenticated expiry check before the first private write. */
  scheduleExpiry: (runId: string, expiresAt: string) => Promise<void>;
  fetcher?: typeof fetch;
}

async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const claimed = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(claimed) || claimed < 0 || claimed > maximum || !response.body) {
    await response.body?.cancel(); throw new Error("Private storage response exceeds its bound");
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length; if (length > maximum) throw new Error("Private storage response exceeds its bound");
      chunks.push(next.value);
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("Private storage response is not valid JSON"); }
}

/** Trusted coordinator only. A dedicated private bucket must disable soft deletion, versioning and retention. */
export class GcsHostedCandidateStore {
  private readonly bucket: string;
  private readonly options: GcsHostedCandidateStoreOptions;
  constructor(options: GcsHostedCandidateStoreOptions) {
    this.bucket = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/).parse(options.bucketName);
    this.options = options;
  }
  private objectUrl(runId: string): string {
    return "https://storage.googleapis.com/storage/v1/b/" + this.bucket + "/o/" + encodeURIComponent("accesswright-candidates/" + runSchema.parse(runId));
  }
  private async request(url: string, method = "GET", body?: string): Promise<Response> {
    const token = await this.options.getAccessToken();
    if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error("Private storage workload identity unavailable");
    try {
      return await (this.options.fetcher ?? fetch)(url, { method, redirect: "error", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(defaults.hostedHttpHeadersTimeoutMs), headers: { authorization: "Bearer " + token, accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }) },
        ...(body === undefined ? {} : { body }) });
    } catch { throw new Error("Private storage transport is unconfirmed"); }
  }
  private async successful(response: Response, maximum: number): Promise<unknown> {
    if (!response.ok) { await response.body?.cancel(); throw new Error("Private storage request failed (HTTP " + response.status + ")"); }
    return boundedJson(response, maximum);
  }
  async verifyBucket(): Promise<void> {
    const fields = "name,versioning,softDeletePolicy,retentionPolicy,objectRetention,defaultEventBasedHold,iamConfiguration,billing";
    const response = await this.request("https://storage.googleapis.com/storage/v1/b/" + this.bucket + "?fields=" + encodeURIComponent(fields));
    const policy = z.object({ name: z.literal(this.bucket),
      softDeletePolicy: z.object({ retentionDurationSeconds: z.union([z.literal("0"), z.literal(0)]) }).passthrough(),
      versioning: z.object({ enabled: z.literal(false).optional() }).passthrough().optional(),
      iamConfiguration: z.object({ publicAccessPrevention: z.literal("enforced"), uniformBucketLevelAccess: z.object({ enabled: z.literal(true) }).passthrough() }).passthrough(),
      defaultEventBasedHold: z.literal(false).optional(), billing: z.object({ requesterPays: z.literal(false).optional() }).passthrough().optional(),
      retentionPolicy: z.unknown().optional(), objectRetention: z.unknown().optional(),
    }).passthrough().parse(await this.successful(response, defaults.firestoreRecordMaxBytes));
    if (policy.retentionPolicy !== undefined || policy.objectRetention !== undefined) throw new Error("Private candidate bucket retains deleted source");
  }
  private checkedMetadata(input: unknown, runId: string) {
    const value = metadataSchema.parse(input);
    if (value.bucket !== this.bucket || value.name !== "accesswright-candidates/" + runId ||
      Number(value.size) > defaults.hostedMaxCandidateObjectBytes || value.temporaryHold || value.eventBasedHold || value.retention !== undefined) {
      throw new Error("Private object identity, size or deletion policy is invalid");
    }
    return value;
  }
  async put(rawRunId: string, input: HostedCandidate, ttlSeconds: number = defaults.hostedDefaultTtlSeconds): Promise<HostedCandidateReference> {
    const runId = runSchema.parse(rawRunId), candidate = HostedCandidateSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(candidate)) > defaults.hostedMaxCandidateBodyBytes) throw new Error("Private candidate exceeds its byte limit");
    const ttl = z.number().int().min(defaults.hostedMinTtlSeconds).max(defaults.hostedMaxTtlSeconds).parse(ttlSeconds);
    await this.verifyBucket();
    const present = await this.get(runId);
    if (present) {
      if (present.candidateDigest !== hostedCandidateDigest(candidate)) throw new Error("Conflicting private candidate already exists");
      return { generation: present.generation, expiresAt: present.expiresAt, candidateDigest: present.candidateDigest };
    }
    const now = Date.now(); const expiresAt = new Date(now + ttl * 1000).toISOString(); const candidateDigest = hostedCandidateDigest(candidate);
    const body = JSON.stringify({ schemaVersion: 1, runId, createdAt: new Date(now).toISOString(), expiresAt, candidateDigest, candidate });
    await this.options.scheduleExpiry(runId, expiresAt);
    const response = await this.request("https://storage.googleapis.com/upload/storage/v1/b/" + this.bucket + "/o?uploadType=media&ifGenerationMatch=0&name=" + encodeURIComponent("accesswright-candidates/" + runId), "POST", body);
    if (response.status === 412) {
      await response.body?.cancel(); const existing = await this.get(runId);
      if (!existing || existing.candidateDigest !== candidateDigest) throw new Error("Conflicting private candidate already exists");
      return { generation: existing.generation, expiresAt: existing.expiresAt, candidateDigest: existing.candidateDigest };
    }
    const saved = this.checkedMetadata(await this.successful(response, defaults.firestoreRecordMaxBytes), runId);
    if (Number(saved.size) !== Buffer.byteLength(body)) throw new Error("Private storage acknowledgment size differs from candidate");
    return { generation: saved.generation, expiresAt, candidateDigest };
  }
  async get(rawRunId: string): Promise<(HostedCandidateReference & { candidate: HostedCandidate }) | null> {
    const runId = runSchema.parse(rawRunId), metadata = await this.readMetadata(runId);
    if (!metadata) return null;
    const media = await this.request(this.objectUrl(runId) + "?alt=media&generation=" + metadata.generation + "&ifGenerationMatch=" + metadata.generation);
    const envelope = envelopeSchema.parse(await this.successful(media, defaults.hostedMaxCandidateObjectBytes));
    const lifetime = Date.parse(envelope.expiresAt) - Date.parse(envelope.createdAt);
    if (envelope.runId !== runId || envelope.candidateDigest !== hostedCandidateDigest(envelope.candidate) ||
      lifetime < defaults.hostedMinTtlSeconds * 1000 || lifetime > defaults.hostedMaxTtlSeconds * 1000 || Date.parse(envelope.createdAt) > Date.now()) {
      throw new Error("Private candidate identity or expiry is invalid");
    }
    if (Date.parse(envelope.expiresAt) <= Date.now()) { await this.remove(runId, metadata.generation); return null; }
    return { generation: metadata.generation, expiresAt: envelope.expiresAt, candidateDigest: envelope.candidateDigest, candidate: envelope.candidate };
  }
  private async readMetadata(runId: string) {
    const response = await this.request(this.objectUrl(runId));
    if (response.status === 404) { await response.body?.cancel(); return null; }
    return this.checkedMetadata(await this.successful(response, defaults.firestoreRecordMaxBytes), runId);
  }
  /** Recover only the fixed object's deletion identity; never parse potentially corrupted source. */
  async generationForCleanup(rawRunId: string): Promise<string | null> {
    const metadata = await this.readMetadata(runSchema.parse(rawRunId));
    return metadata?.generation ?? null;
  }
  async remove(rawRunId: string, rawGeneration: string): Promise<void> {
    const runId = runSchema.parse(rawRunId), generation = generationSchema.parse(rawGeneration);
    await this.verifyBucket();
    const response = await this.request(this.objectUrl(runId) + "?generation=" + generation + "&ifGenerationMatch=" + generation, "DELETE");
    await response.body?.cancel();
    if (![204, 404].includes(response.status)) throw new Error("Private candidate cleanup is unconfirmed (HTTP " + response.status + ")");
    for (const query of ["?generation=" + generation, "?generation=" + generation + "&softDeleted=true", ""]) {
      const remaining = await this.request(this.objectUrl(runId) + query); await remaining.body?.cancel();
      if (remaining.status !== 404) throw new Error("Private candidate remains recoverable after cleanup");
    }
  }
  /** Expiry comes from the authenticated pre-write task, never from corrupted private source. */
  async expire(rawRunId: string, expectedExpiresAt: string): Promise<void> {
    const runId = runSchema.parse(rawRunId), expiry = z.iso.datetime().parse(expectedExpiresAt);
    if (Date.parse(expiry) > Date.now()) throw new Error("Private candidate expiry is not due; retry the authenticated cleanup check");
    const metadata = await this.readMetadata(runId);
    if (!metadata) throw new Error("Private candidate is absent; a prior trusted cleanup receipt is required");
    await this.remove(runId, metadata.generation);
  }
}

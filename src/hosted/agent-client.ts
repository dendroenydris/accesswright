import { z } from "zod";
import { defaults } from "../config.js";
import type { RepairContext } from "../llm/context.js";
import type { LlmImage } from "../llm/types.js";
import { FixTaskSchema } from "../types/schemas.js";
import type { FixTask } from "../types/schemas.js";
import { HostedCandidateSchema, HostedCandidateReceiptSchema, hostedCandidateDigest, HostedPatchEvidenceSchema, HostedPatchResponseSchema, HostedRepairContextSchema } from "./agent-protocol.js";
import type { HostedCandidate } from "./agent-protocol.js";
import type { HostedPatchResponse } from "./agent-api.js";

/** Worker transport holds only a scoped run token. Lost responses are never retried here. */
export class HostedAgentClient {
  private readonly origin: string;
  private readonly runId: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { origin: string; runId: string; token: string; fetcher?: typeof fetch }) {
    const url = new URL(options.origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error("Trusted agent origin must be HTTPS or loopback HTTP without credentials, path or query");
    }
    this.origin = url.origin;
    this.runId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(options.runId);
    this.token = z.string().regex(/^[a-f0-9]{64}$/).parse(options.token);
    this.fetcher = options.fetcher ?? fetch;
  }

  async patch(taskInput: FixTask, contextInput: RepairContext, images: readonly LlmImage[] = [], feedback: string | null = null): Promise<HostedPatchResponse> {
    const task = FixTaskSchema.parse(taskInput);
    const context = HostedRepairContextSchema.parse(contextInput);
    const evidence = HostedPatchEvidenceSchema.parse({ images: images.map(image => ({ mediaType: image.mediaType, data: Buffer.from(image.data).toString("base64") })), feedback });
    if (Buffer.byteLength(JSON.stringify({ task, context, feedback })) > defaults.hostedMaxContextBytes) throw new Error("Hosted context exceeds its byte limit");
    const body = JSON.stringify({ task, context, ...evidence });
    if (Buffer.byteLength(body) > defaults.hostedMaxPatchBodyBytes) throw new Error("Hosted request exceeds its byte limit");
    try {
      const response = await this.post("tasks/" + encodeURIComponent(task.id) + "/patch", body, [200, 422], defaults.hostedMaxPatchResponseBytes);
      const result = HostedPatchResponseSchema.safeParse(response.data);
      if (!result.success || (response.status === 200) !== (result.data.status === "accepted")) return { status: "rejected", reason: "invalid-agent-response", usage: null };
      if (result.data.status === "accepted") {
        const paths = new Set([context.component.file, ...context.callSites.map(site => site.file)]);
        if (result.data.patch.taskId !== task.id || result.data.patch.changes.some(change => !paths.has(change.path))) return { status: "rejected", reason: "invalid-agent-patch", usage: null };
      }
      return result.data;
    } catch {
      return { status: "rejected", reason: "agent-response-unreconciled", usage: null };
    }
  }

  /** One attempt; a lost acknowledgment needs coordinator reconciliation, never automatic resubmission. */
  async submitCandidate(input: HostedCandidate): Promise<void> {
    const candidate = HostedCandidateSchema.parse(input);
    const body = JSON.stringify(candidate);
    if (Buffer.byteLength(body) > defaults.hostedMaxCandidateBodyBytes) throw new Error("Hosted candidate exceeds its byte limit");
    try {
      const response = await this.post("candidate", body, [202], defaults.hostedMaxCandidateResponseBytes);
      const receipt = HostedCandidateReceiptSchema.parse(response.data);
      if (receipt.runId !== this.runId || receipt.candidateDigest !== hostedCandidateDigest(candidate)) throw new Error("Candidate acknowledgment mismatch");
    } catch { throw new Error("Hosted candidate transfer is unconfirmed; trusted reconciliation is required"); }
  }

  private async post(path: string, body: string, statuses: number[], maxBytes: number): Promise<{ status: number; data: unknown }> {
      const response = await this.fetcher(this.origin + "/runs/" + this.runId + "/" + path, {
        method: "POST", headers: { authorization: "Bearer " + this.token, "content-type": "application/json" }, body,
        redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(defaults.providerTimeoutMs + defaults.hostedHttpHeadersTimeoutMs),
      });
      if (!statuses.includes(response.status) || !response.body || Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new Error("Agent response unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > maxBytes) throw new Error("Agent response exceeds its byte limit");
          chunks.push(next.value);
        }
      } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
      return { status: response.status, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  }
}

import { z } from "zod";
import { defaults } from "../config.js";
import type { RepairContext } from "../llm/context.js";
import type { LlmImage } from "../llm/types.js";
import { FixTaskSchema } from "../types/schemas.js";
import type { FixTask } from "../types/schemas.js";
import { HostedPatchEvidenceSchema, HostedPatchResponseSchema, HostedRepairContextSchema } from "./agent-protocol.js";
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
      const response = await this.fetcher(this.origin + "/runs/" + this.runId + "/tasks/" + encodeURIComponent(task.id) + "/patch", {
        method: "POST", headers: { authorization: "Bearer " + this.token, "content-type": "application/json" }, body,
        redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(defaults.providerTimeoutMs + defaults.hostedHttpHeadersTimeoutMs),
      });
      if (![200, 422].includes(response.status) || !response.body || Number(response.headers.get("content-length")) > defaults.hostedMaxPatchResponseBytes) {
        await response.body?.cancel();
        return { status: "rejected", reason: "agent-unavailable", usage: null };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.length;
          if (length > defaults.hostedMaxPatchResponseBytes) throw new Error("Agent response exceeds its byte limit");
          chunks.push(next.value);
        }
      } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
      const result = HostedPatchResponseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
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
}

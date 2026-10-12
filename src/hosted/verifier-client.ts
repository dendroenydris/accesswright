import { z } from "zod";
import { defaults } from "../config.js";
import type { HostedRunStore, HostedRunTransition } from "./run-workflow.js";

const runSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const responseSchema = z.discriminatedUnion("status", [
  z.object({ runId: runSchema, status: z.literal("ready-for-review"), verifiedBaseSha: shaSchema }).strict(),
  z.object({ runId: runSchema, status: z.literal("blocked") }).strict(),
]);

/** Cloud Run task ingress can delegate to a separately authenticated Docker-capable trusted host. */
export class HostedVerifierClient {
  private readonly origin: string;
  private readonly options: { getIdentityToken: (audience: string) => Promise<string>; runs: Pick<HostedRunStore, "get">; fetcher?: typeof fetch };
  constructor(options: { origin: string; getIdentityToken: (audience: string) => Promise<string>; runs: Pick<HostedRunStore, "get">; fetcher?: typeof fetch }) {
    const origin = new URL(options.origin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("Trusted verifier requires a fixed HTTPS origin");
    }
    this.origin = origin.origin; this.options = Object.freeze({ ...options });
  }

  async finishTrustedReport(rawRunId: string, rawDigest: string): Promise<HostedRunTransition> {
    const runId = runSchema.parse(rawRunId), reportDigest = z.string().regex(/^[a-f0-9]{64}$/).parse(rawDigest);
    try {
      const token = await this.options.getIdentityToken(this.origin);
      if (!token || Buffer.byteLength(token) > defaults.googleIdentityMaxTokenBytes || /[\s\p{Cc}]/u.test(token)) throw new Error("Unavailable verifier identity");
      const response = await (this.options.fetcher ?? fetch)(this.origin + "/internal/candidates/verify", {
        method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
        signal: AbortSignal.timeout(defaults.hostedVerificationDeadlineSeconds * 1000),
        headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ runId, reportDigest }),
      });
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (response.status !== 200 || !Number.isFinite(declared) || declared < 0 || declared > defaults.hostedMaxCandidateResponseBytes || !response.body) {
        await response.body?.cancel(); throw new Error("Unconfirmed verifier response");
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > defaults.hostedMaxCandidateResponseBytes) { await reader.cancel(); throw new Error("Verifier response exceeds its bound"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const receipt = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      const stored = await this.options.runs.get(runId);
      if (receipt.runId !== runId || !stored || stored.reportDigest !== reportDigest || stored.status !== receipt.status ||
        stored.verifiedBaseSha !== (receipt.status === "ready-for-review" ? receipt.verifiedBaseSha : null)) throw new Error("Verifier reply disagrees with durable evidence");
      return receipt;
    } catch { throw new Error("Remote trusted verification is unconfirmed"); }
  }
}

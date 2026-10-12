import { z } from "zod";
import { defaults } from "../config.js";

const metadataEndpoint = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const tokenSchema = z.object({
  access_token: z.string().min(1).max(defaults.googleMetadataMaxTokenChars).regex(/^[^\s\p{Cc}]+$/u),
  expires_in: z.number().int().positive().max(defaults.googleMetadataMaxLifetimeSeconds), token_type: z.literal("Bearer"),
}).strict();

async function readMetadata(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (response.status !== 200 || response.headers.get("metadata-flavor") !== "Google" || !Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
    await response.body?.cancel(); throw new Error("Unconfirmed metadata response");
  }
  if (!response.body) throw new Error("Missing metadata response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error("Metadata exceeds its bound"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** Trusted Google workload only. Attached-account credentials stay in memory, never target containers or files. */
export function createGoogleMetadataAccessToken(fetcher: typeof fetch = fetch): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  const load = async () => {
    const startedAt = Date.now();
    try {
      const response = await fetcher(metadataEndpoint, { method: "GET", redirect: "error",
        headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(defaults.googleMetadataTimeoutMs) });
      const data = tokenSchema.parse(JSON.parse((await readMetadata(response, defaults.googleMetadataMaxResponseBytes)).toString("utf8")) as unknown);
      const expiresAt = startedAt + data.expires_in * 1000;
      if (expiresAt <= Date.now() + defaults.googleMetadataRefreshSkewSeconds * 1000) throw new Error("Metadata token is expiring");
      cached = { token: data.access_token, expiresAt };
      return data.access_token;
    } catch { throw new Error("Google workload access is unconfirmed"); }
  };
  return async () => {
    if (cached && cached.expiresAt > Date.now() + defaults.googleMetadataRefreshSkewSeconds * 1000) return cached.token;
    pending ??= load().finally(() => { pending = undefined; });
    return pending;
  };
}

/** Fixed audience/account; the trusted receiver still verifies Google's signature using GoogleCloudTasksOidcVerifier. */
export function createGoogleMetadataIdentityToken(options: { audience: string; serviceAccountEmail: string; fetcher?: typeof fetch }): (audience: string) => Promise<string> {
  const audience = new URL(options.audience);
  if (audience.protocol !== "https:" || audience.origin !== options.audience) throw new Error("Workload identity requires a fixed HTTPS audience");
  const email = z.string().regex(/^[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com$/).parse(options.serviceAccountEmail);
  const endpoint = new URL(metadataEndpoint.replace(/\/token$/, "/identity"));
  endpoint.searchParams.set("audience", audience.origin); endpoint.searchParams.set("format", "full");
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  const load = async () => {
    try {
      const response = await (options.fetcher ?? fetch)(endpoint.href, { method: "GET", redirect: "error",
        headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(defaults.googleMetadataTimeoutMs) });
      const token = (await readMetadata(response, defaults.googleIdentityMaxTokenBytes)).toString("utf8"), parts = token.split(".");
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Malformed identity token");
      z.object({ alg: z.literal("RS256"), kid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), typ: z.literal("JWT").optional() }).strict()
        .parse(JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8")) as unknown);
      const claims = z.object({ iss: z.enum(["https://accounts.google.com", "accounts.google.com"]), aud: z.literal(audience.origin),
        email: z.literal(email), email_verified: z.literal(true), sub: z.string().min(1).max(256), iat: z.number().int(), exp: z.number().int(), nbf: z.number().int().optional() })
        .passthrough().parse(JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown);
      const now = Math.floor(Date.now() / 1000), skew = defaults.googleMetadataRefreshSkewSeconds;
      if (claims.iat > now + skew || claims.exp <= now + skew || claims.exp <= claims.iat ||
        claims.exp > now + defaults.googleMetadataMaxLifetimeSeconds + skew || (claims.nbf !== undefined && claims.nbf > now)) throw new Error("Unconfirmed identity lifetime");
      cached = { token, expiresAt: claims.exp * 1000 }; return token;
    } catch { throw new Error("Google workload identity is unconfirmed"); }
  };
  return async requestedAudience => {
    if (requestedAudience !== audience.origin) throw new Error("Workload identity audience changed");
    if (cached && cached.expiresAt > Date.now() + defaults.googleMetadataRefreshSkewSeconds * 1000) return cached.token;
    pending ??= load().finally(() => { pending = undefined; }); return pending;
  };
}

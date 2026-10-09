import { createPublicKey, verify as verifySignature } from "node:crypto";
import { z } from "zod";

const googleJwksEndpoint = "https://www.googleapis.com/oauth2/v3/certs";
const maxTokenBytes = 16 * 1024;
const maxJwksBytes = 64 * 1024;
const maxClockSkewSeconds = 60;
const headerSchema = z.object({
  alg: z.literal("RS256"),
  kid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  typ: z.literal("JWT").optional(),
}).strict();
const claimSchema = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string().min(1),
  sub: z.string().min(1).max(256),
  email: z.email(),
  email_verified: z.literal(true),
  iat: z.number().int(),
  exp: z.number().int(),
  nbf: z.number().int().optional(),
}).passthrough();
const rsaJwk = z.object({
  kty: z.literal("RSA"),
  kid: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  n: z.string().regex(/^[A-Za-z0-9_-]{100,2048}$/),
  e: z.string().regex(/^[A-Za-z0-9_-]{1,16}$/),
  alg: z.literal("RS256").optional(),
  use: z.literal("sig").optional(),
}).passthrough();
const jwksSchema = z.object({ keys: z.array(rsaJwk).min(1).max(20) }).passthrough();
type RsaJwk = z.infer<typeof rsaJwk>;

export interface GoogleCloudTasksOidcOptions {
  /** Exact Cloud Tasks OIDC audience; CloudTasksRunQueue sends the service origin. */
  audience: string;
  /** Exact Cloud Tasks service account that is allowed to dispatch jobs. */
  serviceAccountEmail: string;
  /** Inject only in tests; production always fetches the fixed Google JWKS URL. */
  fetcher?: typeof fetch;
  /** UTC seconds. */
  clock?: () => number;
}

async function readBounded(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Google signing-key fetch failed");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!Number.isFinite(declared) || declared > maxJwksBytes) {
    await response.body?.cancel();
    throw new Error("Google signing-key response too large");
  }
  if (!response.body) throw new Error("Google signing-key response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maxJwksBytes) {
        await reader.cancel();
        throw new Error("Google signing-key response too large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * Verifies Google-signed Cloud Tasks OIDC ID tokens at the trusted HTTP ingress.
 * Claims, issuer, audience, signing key, signature, and service-account email
 * all have to match. No caller-supplied URL or JWT key location is trusted.
 *
 * Use as dispatcher.authenticateTask: authorization => verifier.verify(authorization).
 * This does not grant public ingress or Cloud Run IAM permissions.
 */
export class GoogleCloudTasksOidcVerifier {
  private readonly audience: string;
  private readonly serviceAccountEmail: string;
  private readonly fetcher: typeof fetch;
  private readonly clock: () => number;
  private cache: { keys: RsaJwk[]; expiresAt: number } | undefined;

  constructor(options: GoogleCloudTasksOidcOptions) {
    const url = new URL(options.audience);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname) {
      throw new Error("Cloud Tasks audience must be an HTTPS URL without credentials or fragment");
    }
    this.audience = options.audience;
    this.serviceAccountEmail = z.string().regex(
      /^[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com$/,
    ).parse(options.serviceAccountEmail);
    this.fetcher = options.fetcher ?? fetch;
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  private async fetchKeys(): Promise<RsaJwk[]> {
    const response = await this.fetcher(googleJwksEndpoint, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
    const keys = jwksSchema.parse(await readBounded(response)).keys;
    const ttl = /(?:^|,)\s*max-age=(\d+)\b/i.exec(response.headers.get("cache-control") ?? "")?.[1];
    const maxAge = ttl === undefined ? 300 : Math.max(0, Math.min(300, Number(ttl)));
    this.cache = { keys, expiresAt: this.clock() + maxAge };
    return keys;
  }

  async verify(authorization: string): Promise<boolean> {
    try {
      if (!authorization.startsWith("Bearer ") || Buffer.byteLength(authorization) > maxTokenBytes) return false;
      const compact = authorization.slice(7);
      const parts = compact.split(".");
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
      const [protectedPart, payloadPart, signaturePart] = parts;
      if (!protectedPart || !payloadPart || !signaturePart) return false;
      const header = headerSchema.parse(JSON.parse(Buffer.from(protectedPart, "base64url").toString("utf8")) as unknown);
      const claims = claimSchema.parse(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown);
      const now = this.clock();
      if (!Number.isSafeInteger(now) || claims.aud !== this.audience ||
        claims.email !== this.serviceAccountEmail ||
        claims.iat > now + maxClockSkewSeconds ||
        claims.exp <= now || claims.exp <= claims.iat ||
        (claims.nbf !== undefined && claims.nbf > now)) return false;
      const cached = this.cache;
      let keys = cached && cached.expiresAt > now ? cached.keys : await this.fetchKeys();
      let key = keys.find(item => item.kid === header.kid);
      if (!key && cached && cached.expiresAt > now) {
        keys = await this.fetchKeys();
        key = keys.find(item => item.kid === header.kid);
      }
      if (!key) return false;
      const publicKey = createPublicKey({
        key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk",
      });
      return verifySignature("RSA-SHA256", Buffer.from(protectedPart + "." + payloadPart),
        publicKey, Buffer.from(signaturePart, "base64url"));
    } catch {
      // Network, schema, signature and parsing failures all deny access.
      // Never log raw ID tokens or signing material.
      return false;
    }
  }
}

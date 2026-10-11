import { createPrivateKey, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaults } from "../config.js";
import { appendRunRecord } from "../tracer/run-record.js";

const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine(value => value.split("/").every(part => part !== "." && part !== ".."));
const identitySchema = z.object({ runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), repository: repositorySchema,
  installationId: z.number().int().positive() }).strict();
type SourceIdentity = z.infer<typeof identitySchema>;
const installationSchema = z.object({ id: z.number().int().positive(), app_id: z.number().int().positive(),
  account: z.object({ login: z.string().min(1) }).passthrough(), suspended_at: z.literal(null) }).passthrough();
const tokenSchema = z.object({ token: z.string().min(1).max(4096).regex(/^[^\r\n]+$/), expires_at: z.iso.datetime(),
  permissions: z.object({ contents: z.literal("read"), metadata: z.literal("read").optional() }).strict() }).passthrough();
const repositoriesSchema = z.object({ total_count: z.literal(1), repositories: z.array(z.object({ full_name: repositorySchema,
  default_branch: z.string().min(1).max(255).regex(/^[^\p{Cc}]+$/u).refine(value => value !== "." && value !== "..") }).passthrough()).length(1) }).passthrough();

/** Source-only GitHub App credentials stay on the trusted host; no publication permissions are requested. */
export class GitHubSourceAccess {
  private readonly appId: number;
  private readonly key: KeyObject;
  private readonly allowlist: Set<string>;
  private readonly evidenceRoot: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { appId: number; privateKey: string; allowlist: string[]; evidenceRoot: string; fetcher?: typeof fetch }) {
    this.appId = z.number().int().positive().parse(options.appId);
    this.allowlist = new Set(z.array(repositorySchema).min(1).parse(options.allowlist).map(value => value.toLowerCase()));
    this.evidenceRoot = options.evidenceRoot; this.fetcher = options.fetcher ?? fetch;
    try {
      this.key = createPrivateKey(options.privateKey);
      if (this.key.asymmetricKeyType !== "rsa" || (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < defaults.githubMinRsaBits) throw new Error("Unsupported key");
    } catch { throw new Error("GitHub App signing configuration is unavailable"); }
  }

  private identity(input: SourceIdentity): SourceIdentity {
    const run = identitySchema.parse(input);
    if (!this.allowlist.has(run.repository.toLowerCase())) throw new Error("Source repository is outside the installation allowlist");
    return run;
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: String(this.appId), iat: now - defaults.githubJwtClockSkewSeconds, exp: now + defaults.githubJwtTtlSeconds })).toString("base64url");
    const data = header + "." + payload;
    return data + "." + sign("RSA-SHA256", Buffer.from(data), this.key).toString("base64url");
  }

  private async record(runId: string, step: string, status: "ok" | "error", baseSha?: string): Promise<void> {
    await mkdir(join(this.evidenceRoot, runId), { recursive: true, mode: 0o700 });
    await appendRunRecord(join(this.evidenceRoot, runId, "run.jsonl"), {
      timestamp: new Date().toISOString(), step, status, ...(baseSha ? { metadata: { baseSha } } : {}),
    });
  }

  private async request(path: string, authorization: string, body?: object): Promise<unknown> {
    const response = await this.fetcher("https://api.github.com" + path, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(defaults.githubHttpTimeoutMs),
      headers: { authorization: "Bearer " + authorization, accept: "application/vnd.github+json", "content-type": "application/json",
        "user-agent": "accesswright", "x-github-api-version": defaults.githubApiVersion }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (response.status !== (body ? 201 : 200) || !Number.isFinite(declared) || declared < 0 || declared > defaults.githubResponseMaxBytes) {
      await response.body?.cancel(); throw new Error("GitHub source response is unconfirmed");
    }
    if (!response.body) throw new Error("GitHub source response is missing");
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        total += part.value.byteLength;
        if (total > defaults.githubResponseMaxBytes) { await reader.cancel(); throw new Error("GitHub source response exceeds its limit"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }

  private async sourceAccess(input: SourceIdentity): Promise<{ token: string; defaultBranch: string }> {
    const run = this.identity(input);
    try {
      const jwt = this.jwt(), [owner, name] = run.repository.split("/");
      const installation = installationSchema.parse(await this.request("/app/installations/" + run.installationId, jwt));
      if (installation.id !== run.installationId || installation.app_id !== this.appId || installation.account.login.toLowerCase() !== owner?.toLowerCase()) throw new Error("Installation mismatch");
      const access = tokenSchema.parse(await this.request("/app/installations/" + run.installationId + "/access_tokens", jwt,
        { repositories: [name], permissions: { contents: "read" } }));
      if (Date.parse(access.expires_at) <= Date.now() + defaults.sourceCheckoutTimeoutMs) throw new Error("Source token expires before checkout");
      const repos = repositoriesSchema.parse(await this.request("/installation/repositories", access.token));
      const repo = repos.repositories[0];
      if (!repo || repo.full_name.toLowerCase() !== run.repository.toLowerCase()) throw new Error("Source scope mismatch");
      await this.record(run.runId, "hosted-github-source-access", "ok");
      return { token: access.token, defaultBranch: repo.default_branch };
    } catch {
      await this.record(run.runId, "hosted-github-source-access", "error");
      throw new Error("GitHub installation source access is unconfirmed");
    }
  }

  async getInstallationToken(input: SourceIdentity): Promise<string> {
    return (await this.sourceAccess(input)).token;
  }

  /** Pin once before job registration; persist this SHA and reuse it for input and independent replay. */
  async pinDefaultRevision(input: SourceIdentity): Promise<string> {
    const run = this.identity(input);
    try {
      const { token, defaultBranch } = await this.sourceAccess(run);
      const commit = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).passthrough().parse(await this.request(
        "/repos/" + run.repository.split("/").map(encodeURIComponent).join("/") + "/commits/" + encodeURIComponent(defaultBranch), token));
      await this.record(run.runId, "hosted-github-source-revision", "ok", commit.sha);
      return commit.sha;
    } catch {
      await this.record(run.runId, "hosted-github-source-revision", "error");
      throw new Error("GitHub source revision is unconfirmed");
    }
  }
}

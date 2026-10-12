import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { GitHubSourceAccess } from "../../src/hosted/github-source-access.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }), privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const run = { runId: "run1", repository: "owned/fixture", installationId: 42 }, sha = "a".repeat(40);
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "aw-source-auth-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
function fixture() {
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.origin).toBe("https://api.github.com"); expect(init?.redirect).toBe("error");
    if (url.pathname === "/app/installations/42") return Promise.resolve(Response.json({ id: 42, app_id: 7, account: { login: "owned" }, suspended_at: null }));
    if (url.pathname.endsWith("/access_tokens")) return Promise.resolve(Response.json({ token: "fixture-source-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: { contents: "read", metadata: "read" } }, { status: 201 }));
    if (url.pathname === "/installation/repositories") return Promise.resolve(Response.json({ total_count: 1, repositories: [{ full_name: run.repository, default_branch: "main" }] }));
    if (url.pathname.endsWith("/git/ref/heads/main")) return Promise.resolve(Response.json({ ref: "refs/heads/main", object: { type: "commit", sha } }));
    if (url.pathname.endsWith("/git/ref/pull/15/head")) return Promise.resolve(Response.json({ ref: "refs/pull/15/head", object: { type: "commit", sha: "b".repeat(40) } }));
    throw new Error("Unexpected fixture source endpoint");
  });
  const service = new GitHubSourceAccess({ appId: 7, privateKey, allowlist: [run.repository], evidenceRoot: root, fetcher });
  return { service, fetcher };
}

it("signs a bounded App JWT, requests one read-only repository and pins its default revision without persisting credentials", async () => {
  const { service, fetcher } = fixture();
  expect(await service.pinDefaultRevision(run)).toBe(sha); expect(fetcher).toHaveBeenCalledTimes(4);
  const appAuth = new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization");
  const parts = appAuth?.replace(/^Bearer /, "").split(".") ?? [];
  expect(parts).toHaveLength(3);
  const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as { iss: string; iat: number; exp: number };
  const now = Math.floor(Date.now() / 1000); expect(claims.iss).toBe("7"); expect(claims.iat).toBeLessThanOrEqual(now);
  expect(claims.exp).toBeLessThanOrEqual(now + 600); expect(claims.exp).toBeGreaterThan(now);
  expect(verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), keys.publicKey, Buffer.from(parts[2] ?? "", "base64url"))).toBe(true);
  const requestBody = fetcher.mock.calls[1]?.[1]?.body;
  if (typeof requestBody !== "string") throw new Error("Missing fixture token request body");
  expect(JSON.parse(requestBody)).toEqual({ repositories: ["fixture"], permissions: { contents: "read" } });
  const log = await readFile(join(root, "run1/run.jsonl"), "utf8");
  expect(log).toContain(sha); expect(log).not.toContain("fixture-source-token"); expect(log).not.toContain("PRIVATE KEY"); expect(log).not.toContain(parts[2]);
});
it("rejects unallowlisted repositories before requesting credentials", async () => {
  const f = fixture(); await expect(f.service.getInstallationToken({ ...run, repository: "other/fixture" })).rejects.toThrow("allowlist");
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([{ id: 43, app_id: 7, account: { login: "owned" }, suspended_at: null },
  { id: 42, app_id: 8, account: { login: "owned" }, suspended_at: null },
  { id: 42, app_id: 7, account: { login: "other" }, suspended_at: null },
  { id: 42, app_id: 7, account: { login: "owned" }, suspended_at: "2026-10-10T00:00:00Z" }])("refuses mismatched or suspended installations before token creation: %j", async installation => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(Response.json(installation));
  await expect(f.service.getInstallationToken(run)).rejects.toThrow(/^GitHub installation source access is unconfirmed$/);
  expect(f.fetcher).toHaveBeenCalledOnce();
});
it.each([{ contents: "write" }, { contents: "read", issues: "write" }])("refuses widened source-token permissions: %j", async permissions => {
  const f = fixture(); const original = f.fetcher.getMockImplementation(); if (!original) throw new Error("Missing fixture fetch");
  f.fetcher.mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(Response.json({ token: "fixture-source-token", expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions }, { status: 201 })) : original(input, init));
  await expect(f.service.getInstallationToken(run)).rejects.toThrow("unconfirmed"); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it.each([{ total_count: 2, repositories: [] }, { total_count: 1, repositories: [{ full_name: "other/fixture", default_branch: "main" }] }])("refuses unconfirmed repository scope: %j", async repositories => {
  const f = fixture(); const original = f.fetcher.getMockImplementation(); if (!original) throw new Error("Missing fixture fetch");
  f.fetcher.mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.endsWith("/installation/repositories") ? Promise.resolve(Response.json(repositories)) : original(input, init);
  });
  await expect(f.service.getInstallationToken(run)).rejects.toThrow("unconfirmed");
});
it("bounds response bytes and redacts HTTP errors without retrying", async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response("private-source-marker fixture-source-token", { status: 403 }));
  await expect(f.service.getInstallationToken(run)).rejects.toThrow(/^GitHub installation source access is unconfirmed$/);
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(await readFile(join(root, "run1/run.jsonl"), "utf8")).not.toMatch(/private-source-marker|fixture-source-token/);
  f.fetcher.mockResolvedValueOnce(new Response("x".repeat(defaults.githubResponseMaxBytes + 1)));
  await expect(f.service.getInstallationToken(run)).rejects.toThrow("unconfirmed"); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("refuses credentials that expire before a bounded source checkout can finish", async () => {
  const f = fixture(); const original = f.fetcher.getMockImplementation(); if (!original) throw new Error("Missing fixture fetch");
  f.fetcher.mockImplementation((input, init) => init?.method === "POST" ? Promise.resolve(Response.json({ token: "fixture-source-token",
    expires_at: new Date(Date.now() + 1000).toISOString(), permissions: { contents: "read" } }, { status: 201 })) : original(input, init));
  await expect(f.service.getInstallationToken(run)).rejects.toThrow("unconfirmed"); expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("rejects unavailable signing keys without including signing material in the error", () => {
  expect(() => new GitHubSourceAccess({ appId: 7, privateKey: "fixture-private-key-marker", allowlist: [run.repository], evidenceRoot: root })).toThrow(/^GitHub App signing configuration is unavailable$/);
});

it("pins the requested PR head with the same contents-read source token, without reading a merge or default revision", async () => {
  const f = fixture(); expect(await f.service.pinRunRevision(run, 15)).toBe("b".repeat(40));
  expect(f.fetcher).toHaveBeenCalledTimes(4);
  expect(f.fetcher.mock.calls[3]?.[0]).toBe("https://api.github.com/repos/owned/fixture/git/ref/pull/15/head");
  const tokenRequest = f.fetcher.mock.calls[1]?.[1]?.body;
  if (typeof tokenRequest !== "string") throw new Error("Missing fixture scope");
  expect(JSON.parse(tokenRequest)).toEqual({ repositories: ["fixture"], permissions: { contents: "read" } });
  const log = await readFile(join(root, "run1/run.jsonl"), "utf8");
  expect(log).toContain("b".repeat(40)); expect(log).not.toContain("fixture-source-token");
});

it.each([{ ref: "refs/pull/15/merge", object: { type: "commit", sha } },
  { ref: "refs/pull/16/head", object: { type: "commit", sha } },
  { ref: "refs/pull/15/head", object: { type: "tag", sha } },
  { ref: "refs/pull/15/head", object: { type: "commit", sha: "invalid" } },
  [{ ref: "refs/pull/15/head", object: { type: "commit", sha } }]])("refuses an unconfirmed PR reference without falling back to the default branch: %j", async reference => {
  const f = fixture(), original = f.fetcher.getMockImplementation(); if (!original) throw new Error("Missing fixture fetch");
  f.fetcher.mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.endsWith("/git/ref/pull/15/head") ? Promise.resolve(Response.json(reference)) : original(input, init);
  });
  await expect(f.service.pinRunRevision(run, 15)).rejects.toThrow(/^GitHub source revision is unconfirmed$/);
  expect(f.fetcher).toHaveBeenCalledTimes(4);
});

it.each([0, -1, 1.5])("rejects invalid PR identity before source access: %s", async pull => {
  const f = fixture(); await expect(f.service.pinRunRevision(run, pull)).rejects.toThrow(); expect(f.fetcher).not.toHaveBeenCalled();
});

it.each(["none", "read", "triage", "write", "maintain", "admin"])("authorizes a signed comment sender only with repository write access (%s)", async permission => {
  const f = fixture(), original = f.fetcher.getMockImplementation(); if (!original) throw new Error("Missing fixture fetch");
  f.fetcher.mockImplementation((input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.endsWith("/collaborators/reviewer/permission")) return Promise.resolve(Response.json({ permission, user: { login: "reviewer" } }));
    return original(input, init);
  });
  expect(await f.service.authorizeComment({ repository: run.repository, installationId: run.installationId, sender: "reviewer", pullNumber: 15 })).toBe(["write", "maintain", "admin"].includes(permission));
  expect(f.fetcher).toHaveBeenCalledTimes(4);
});

it.each(["different-sender", "unavailable"])("denies unconfirmed comment permission without widening source scope (%s)", async failure => {
  const f = fixture(), original = f.fetcher.getMockImplementation(); if (!original) throw new Error("Missing fixture fetch");
  f.fetcher.mockImplementation((input, init) => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    if (url.endsWith("/permission")) return Promise.resolve(failure === "unavailable" ? new Response("private-source-token-marker", { status: 503 }) : Response.json({ permission: "admin", user: { login: "different" } }));
    return original(input, init);
  });
  expect(await f.service.authorizeComment({ repository: run.repository, installationId: run.installationId, sender: "reviewer", pullNumber: 15 })).toBe(false);
  const scope = f.fetcher.mock.calls[1]?.[1]?.body;
  if (typeof scope !== "string") throw new Error("Missing source scope");
  expect(JSON.parse(scope)).toEqual({ repositories: ["fixture"], permissions: { contents: "read" } });
});

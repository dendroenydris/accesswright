import { createSign, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";

import { CloudRunTaskDispatcher } from "../../src/hosted/task-dispatch.js";
import { GoogleCloudTasksOidcVerifier } from "../../src/hosted/google-oidc.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" });
const serviceAccount = "accesswright-tasks@example-project.iam.gserviceaccount.com";
const audience = "https://internal.example.org/internal/jobs";
const now = 1_791_555_000;
const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function token(overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const protectedHeader = enc({ alg: "RS256", kid: "trusted-google-key", typ: "JWT", ...header });
  const payload = enc({
    iss: "https://accounts.google.com", aud: audience,
    email: serviceAccount, email_verified: true, sub: "123456789",
    iat: now - 60, exp: now + 900, ...overrides,
  });
  const input = protectedHeader + "." + payload;
  return input + "." + createSign("RSA-SHA256").update(input).end().sign(privateKey).toString("base64url");
}

function fixture() {
  let requests = 0;
  let keys: Array<Record<string, unknown>> = [{ ...publicJwk, kid: "trusted-google-key", alg: "RS256", use: "sig" }];
  const verifier = new GoogleCloudTasksOidcVerifier({
    audience, serviceAccountEmail: serviceAccount, clock: () => now,
    fetcher: (input, init) => {
      requests++;
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe("https://www.googleapis.com/oauth2/v3/certs");
      expect(init?.redirect).toBe("error");
      return Promise.resolve(Response.json({ keys }, { headers: { "cache-control": "public, max-age=600" } }));
    },
  });
  return {
    verifier,
    get requests() { return requests; },
    setKeys(value: Array<Record<string, unknown>>) { keys = value; },
  };
}

it("verifies Google RS256 OIDC signature, audience, issuer, verified email and expiry", async () => {
  const f = fixture();
  expect(await f.verifier.verify("Bearer " + token())).toBe(true);
  expect(await f.verifier.verify("Bearer " + token())).toBe(true);
  expect(f.requests).toBe(1);
  for (const invalid of [
    { aud: "https://evil.example.org/" }, { email: "attacker@example.org" },
    { email_verified: false }, { iss: "https://attacker.example.org" },
    { iat: now + 3600 }, { exp: now - 1 }, { nbf: now + 10 },
  ]) {
    expect(await f.verifier.verify("Bearer " + token(invalid))).toBe(false);
  }
});

it("rejects unsigned or tampered tokens even if claims otherwise look authorized", async () => {
  const f = fixture();
  const issued = token();
  const [header, , sig] = issued.split(".");
  expect(await f.verifier.verify("Bearer " + [header, enc({ email: serviceAccount, aud: audience }), sig].join("."))).toBe(false);
  expect(await f.verifier.verify("Bearer " + token({}, { alg: "none" }))).toBe(false);
  expect(await f.verifier.verify("Bearer " + token({}, { kid: "../other" }))).toBe(false);
  expect(await f.verifier.verify("Bearer " + token({}, { crit: ["b64"] }))).toBe(false);
  expect(await f.verifier.verify("Bearer not-a-jwt")).toBe(false);
  expect(await f.verifier.verify("Bearer " + "x".repeat(20_000))).toBe(false);
});

it("does not trust attacker-supplied JWK URLs or unrecognized Google key identifiers", async () => {
  const f = fixture();
  expect(await f.verifier.verify("Bearer " + token({}, { jku: "https://evil.example.org/keys" }))).toBe(false);
  expect(await f.verifier.verify("Bearer " + token({}, { kid: "missing" }))).toBe(false);
  expect(f.requests).toBeLessThanOrEqual(2);
});

it("fails closed on unavailable or malformed JWKS, with no permissive fallback", async () => {
  const unavailable = new GoogleCloudTasksOidcVerifier({
    audience, serviceAccountEmail: serviceAccount, clock: () => now,
    fetcher: () => Promise.resolve(new Response("malformed", { status: 503 })),
  });
  expect(await unavailable.verify("Bearer " + token())).toBe(false);
  const oversized = new GoogleCloudTasksOidcVerifier({
    audience, serviceAccountEmail: serviceAccount, clock: () => now,
    fetcher: () => Promise.resolve(Response.json({ keys: [{ x: "x".repeat(90_000) }] })),
  });
  expect(await oversized.verify("Bearer " + token())).toBe(false);
});

it("authorizes Cloud Run dispatch only after verifying a signed Google Cloud Tasks token", async () => {
  const f = fixture();
  const issuedRun = {
    runId: "a".repeat(32), repository: "owner/private", installationId: 42,
    event: "installation" as const, createdAt: "2026-10-09T12:00:00.000Z", pullNumber: null,
  };
  const claims = new Set<string>();
  let launches = 0;
  const dispatcher = new CloudRunTaskDispatcher({
    authenticateTask: authorization => f.verifier.verify(authorization),
    claim: run => {
      if (claims.has(run.runId)) return Promise.resolve(false);
      claims.add(run.runId);
      return Promise.resolve(true);
    },
    registerRunToken: () => Promise.resolve("d".repeat(64)),
    invokeJob: (run, scopedToken) => {
      expect(scopedToken).toBe("d".repeat(64));
      launches++;
      return Promise.resolve({ runId: run.runId, operation: "projects/p/locations/europe-west3/operations/test" });
    },
    recordOutcome: () => Promise.resolve(),
  });
  await expect(dispatcher.dispatch(issuedRun, "Bearer " + token({ aud: "https://wrong.example.org" }))).rejects.toThrow(/OIDC/);
  expect(launches).toBe(0);
  expect(await dispatcher.dispatch(issuedRun, "Bearer " + token())).toMatchObject({ status: "launched" });
  expect(await dispatcher.dispatch(issuedRun, "Bearer " + token())).toMatchObject({ status: "duplicate" });
  expect(launches).toBe(1);
});

it("rejects JWTs signed by an untrusted RSA key and prevents algorithm confusion", async () => {
  const f = fixture();
  f.setKeys([{ ...generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" }), kid: "trusted-google-key" }]);
  expect(await f.verifier.verify("Bearer " + token())).toBe(false);
  expect(await f.verifier.verify("Bearer " + token({}, { alg: "HS256" }))).toBe(false);
});

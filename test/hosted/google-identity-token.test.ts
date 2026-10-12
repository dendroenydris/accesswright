import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createGoogleMetadataIdentityToken } from "../../src/hosted/google-access-token.js";
import { GoogleCloudTasksOidcVerifier } from "../../src/hosted/google-oidc.js";
import { defaults } from "../../src/config.js";

const audience = "https://verifier.owned.invalid", serviceAccountEmail = "relay@accesswright-dev-123.iam.gserviceaccount.com";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }), kid = "fixture-key";
function identity(overrides: object = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: audience, email: serviceAccountEmail,
    email_verified: true, sub: "fixture-account", iat: now, exp: now + 600, ...overrides })).toString("base64url");
  const body = header + "." + payload;
  return body + "." + sign("RSA-SHA256", Buffer.from(body), keys.privateKey).toString("base64url");
}

it("retrieves one fixed-audience identity in memory and passes the independent receiver's actual signature/account verification", async () => {
  const token = identity(), fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(token, { headers: { "Metadata-Flavor": "Google" } })));
  const getToken = createGoogleMetadataIdentityToken({ audience, serviceAccountEmail, fetcher });
  expect(await Promise.all([getToken(audience), getToken(audience)])).toEqual([token, token]); expect(fetcher).toHaveBeenCalledOnce();
  const requested = fetcher.mock.calls[0]?.[0];
  if (typeof requested !== "string") throw new Error("Missing fixture identity endpoint");
  const endpoint = new URL(requested);
  expect(endpoint.origin).toBe("http://metadata.google.internal"); expect(endpoint.pathname).toBe("/computeMetadata/v1/instance/service-accounts/default/identity");
  expect(endpoint.searchParams.get("audience")).toBe(audience); expect(endpoint.searchParams.get("format")).toBe("full");
  const verifier = new GoogleCloudTasksOidcVerifier({ audience, serviceAccountEmail,
    fetcher: () => Promise.resolve(Response.json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] })) });
  expect(await verifier.verify("Bearer " + token)).toBe(true);
});

it("refuses caller-selected audiences before fetching or returning a cached identity", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(identity(), { headers: { "Metadata-Flavor": "Google" } })));
  const getToken = createGoogleMetadataIdentityToken({ audience, serviceAccountEmail, fetcher });
  await expect(getToken("https://other.invalid")).rejects.toThrow("audience changed"); expect(fetcher).not.toHaveBeenCalled();
  await getToken(audience); await expect(getToken("https://other.invalid")).rejects.toThrow("audience changed"); expect(fetcher).toHaveBeenCalledOnce();
});

it.each([{ aud: "https://other.invalid" }, { email: "worker@accesswright-dev-123.iam.gserviceaccount.com" }, { email_verified: false },
  { iss: "https://attacker.invalid" }, { exp: 1 }, { sub: "" }, { nbf: 9999999999 }])("refuses incorrect identity claims without exposing the JWT (%j)", async claims => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(identity(claims), { headers: { "Metadata-Flavor": "Google" } })));
  await expect(createGoogleMetadataIdentityToken({ audience, serviceAccountEmail, fetcher })(audience)).rejects.toThrow(/^Google workload identity is unconfirmed$/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each(["not-a-jwt", "x".repeat(defaults.googleIdentityMaxTokenBytes + 1)])("bounds and rejects malformed metadata token bodies (%#)", async body => {
  await expect(createGoogleMetadataIdentityToken({ audience, serviceAccountEmail,
    fetcher: () => Promise.resolve(new Response(body, { headers: { "Metadata-Flavor": "Google" } })) })(audience)).rejects.toThrow(/^Google workload identity is unconfirmed$/);
});

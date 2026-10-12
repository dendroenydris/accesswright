import { afterEach, expect, it, vi } from "vitest";
import { defaults } from "../../src/config.js";
import { createGoogleMetadataAccessToken } from "../../src/hosted/google-access-token.js";

const token = "fixture-workload-token";
const response = (accessToken = token, expires = 3600) => Response.json({ access_token: accessToken, expires_in: expires, token_type: "Bearer" }, { headers: { "Metadata-Flavor": "Google" } });
afterEach(() => { vi.restoreAllMocks(); });

it("uses a fixed non-redirecting metadata endpoint and shares one in-memory refresh across concurrent adapter calls", async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response())), getAccessToken = createGoogleMetadataAccessToken(fetcher);
  expect(await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()])).toEqual([token, token, token]);
  expect(await getAccessToken()).toBe(token); expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0]).toBe("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error", headers: { "Metadata-Flavor": "Google" } });
  expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

it("refreshes expiring credentials and never falls back to an expired token after failure", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(response(token, 61))), getAccessToken = createGoogleMetadataAccessToken(fetcher);
  expect(await getAccessToken()).toBe(token); clock.mockReturnValue(1_002_000);
  fetcher.mockRejectedValueOnce(new Error("fixture private-token-marker"));
  await expect(getAccessToken()).rejects.toThrow(/^Google workload access is unconfirmed$/);
  fetcher.mockResolvedValueOnce(response("fixture-refreshed-token"));
  expect(await getAccessToken()).toBe("fixture-refreshed-token"); expect(fetcher).toHaveBeenCalledTimes(3);
});

it.each([
  () => new Response("fixture-private-token-marker", { status: 403 }),
  () => new Response("fixture-private-token-marker", { status: 302 }),
  () => Response.json({ access_token: token, expires_in: 3600, token_type: "Bearer" }),
  () => Response.json({ access_token: "fixture\r\nmarker", expires_in: 3600, token_type: "Bearer" }, { headers: { "Metadata-Flavor": "Google" } }),
  () => Response.json({ access_token: token, expires_in: 0, token_type: "Bearer" }, { headers: { "Metadata-Flavor": "Google" } }),
  () => Response.json({ access_token: token, expires_in: 3600, token_type: "Basic" }, { headers: { "Metadata-Flavor": "Google" } }),
  () => new Response("x".repeat(defaults.googleMetadataMaxResponseBytes + 1), { headers: { "Metadata-Flavor": "Google" } }),
  () => new Response("{}", { headers: { "Metadata-Flavor": "Google", "Content-Length": "9000" } }),
])("rejects unconfirmed metadata without exposing token/body details (%#)", async makeResponse => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(makeResponse()));
  await expect(createGoogleMetadataAccessToken(fetcher)()).rejects.toThrow(/^Google workload access is unconfirmed$/);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("counts request time against token lifetime instead of caching a delayed expiring reply", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const fetcher = vi.fn<typeof fetch>(() => { clock.mockReturnValue(1_002_000); return Promise.resolve(response(token, 61)); });
  await expect(createGoogleMetadataAccessToken(fetcher)()).rejects.toThrow(/^Google workload access is unconfirmed$/);
});

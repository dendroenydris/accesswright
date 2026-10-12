import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { configureHostedWorker } from "../../src/hosted/worker-configuration.js";
import { createGoogleMetadataIdentityToken } from "../../src/hosted/google-access-token.js";

vi.mock("../../src/hosted/google-access-token.js", () => ({ createGoogleMetadataIdentityToken: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
const environment = { ACCESSWRIGHT_RUN_ID: "run1", ACCESSWRIGHT_RUN_TOKEN: "a".repeat(64),
  ACCESSWRIGHT_AGENT_ORIGIN: "https://agent-owned.a.run.app", ACCESSWRIGHT_PROVIDER_VERIFICATION: "fake-provider" };

it("wires metadata identity into the actual Cloud Run worker transport without putting it in source bodies", async () => {
  const getIdentityToken = vi.fn(() => Promise.resolve("local-google-identity"));
  vi.mocked(createGoogleMetadataIdentityToken).mockReturnValue(getIdentityToken);
  const bytes = Buffer.from("local fixture source");
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ runId: "run1", baseSha: "a".repeat(40), files: [{
    path: "page.tsx", mode: "100644", blobSha: createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex"), data: bytes.toString("base64"),
  }] })));
  vi.stubGlobal("fetch", fetcher);
  const serviceAccountEmail = "worker@accesswright-dev-123.iam.gserviceaccount.com";
  const config = configureHostedWorker({ ...environment, CLOUD_RUN_JOB: "fixture-worker", ACCESSWRIGHT_WORKER_SERVICE_ACCOUNT_EMAIL: serviceAccountEmail });
  expect(createGoogleMetadataIdentityToken).toHaveBeenCalledExactlyOnceWith({ audience: environment.ACCESSWRIGHT_AGENT_ORIGIN, serviceAccountEmail });
  await config.client.downloadInput();
  expect(getIdentityToken).toHaveBeenCalledExactlyOnceWith(environment.ACCESSWRIGHT_AGENT_ORIGIN);
  const [url, request] = fetcher.mock.calls[0];
  expect(new Headers(request?.headers).get("x-serverless-authorization")).toBe("Bearer local-google-identity");
  expect(new Headers(request?.headers).get("authorization")).toBe("Bearer " + environment.ACCESSWRIGHT_RUN_TOKEN);
  expect(url).not.toContain("local-google-identity"); expect(request?.body).toBe("{}");
});

it("keeps local Docker transport independent of cloud metadata and fails missing Cloud Run identity before any request", () => {
  const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
  expect(configureHostedWorker(environment)).toMatchObject({ runId: "run1", providerVerification: "fake-provider" });
  expect(createGoogleMetadataIdentityToken).not.toHaveBeenCalled();
  expect(() => configureHostedWorker({ ...environment, CLOUD_RUN_JOB: "fixture-worker" })).toThrow("worker identity configuration");
  expect(fetcher).not.toHaveBeenCalled();
});

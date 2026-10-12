import { createHmac } from "node:crypto";
import { once } from "node:events";
import { expect, it } from "vitest";
import {
  InMemoryRunRegistry,
} from "../../src/hosted/webhook.js";
import {
  createHostedWebhookServer,
} from "../../src/hosted/http.js";

const secret = "local-test-secret";
function signed(body: string, event = "installation") {
  return {
    "content-type": "application/json",
    "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    "x-github-delivery": "5aee4111-0000-4000-8000-000000000001",
    "x-github-event": event,
  };
}

it("HTTP webhook processes signed requests, handles duplicates, and never exposes private payloads", async () => {
  const runs: string[] = [];
  const app = createHostedWebhookServer({
    secret, installationAllowlist: new Set([123]), repositoryAllowlist: new Set(["owner/repo"]), registry: new InMemoryRunRegistry(),
    queue: run => { runs.push(run.runId); return Promise.resolve(); },
    authorizeComment: () => Promise.resolve(false),
  });
  try {
    app.listen(0, "127.0.0.1");
    await once(app, "listening");
    const address = app.address();
    if (!address || typeof address === "string") throw new Error("Test server did not get TCP address");
    const url = "http://127.0.0.1:" + address.port;
    const health = await fetch(url + "/healthz");
    expect(health.status).toBe(200);

    const privateText = "must-not-appear-in-response";
    const body = JSON.stringify({
      action: "created", installation: { id: 123 },
      repositories: [{ full_name: "owner/repo", private: true }],
      sender: { login: "authorized" }, text: privateText,
    });
    const response = await fetch(url + "/github/webhook", { method: "POST", headers: signed(body), body });
    expect(response.status).toBe(202);
    const text = await response.text();
    expect(text).toContain('"status":"queued"');
    expect(text).not.toContain(privateText);
    const duplicate = await fetch(url + "/github/webhook", { method: "POST", headers: signed(body), body });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()) as unknown).toMatchObject({ status: "duplicate" });
    expect(runs).toHaveLength(1);

    const unauthorized = await fetch(url + "/github/webhook", {
      method: "POST",
      headers: { ...signed(body), "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      body,
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.text()).not.toContain(privateText);
    const oversized = await fetch(url + "/github/webhook", {
      method: "POST", headers: signed(body), body: "a".repeat(1_048_577),
    });
    expect(oversized.status).toBe(413);
    expect(runs).toHaveLength(1);
    const missing = await fetch(url + "/missing");
    expect(missing.status).toBe(404);
  } finally {
    await new Promise<void>(resolve => app.close(() => resolve()));
  }
});

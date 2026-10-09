import { createHmac } from "node:crypto";
import { once } from "node:events";
import { expect, it } from "vitest";

import { createHostedWebhookServer } from "../../src/hosted/http.js";
import { CloudTasksRunQueue } from "../../src/hosted/cloud-tasks-queue.js";
import { InMemoryRunRegistry } from "../../src/hosted/webhook.js";

it("routes a signed GitHub webhook through real local HTTP into scoped Cloud Tasks requests", async () => {
  const secret = "local-webhook-secret";
  let taskCreates = 0;
  const queue = new CloudTasksRunQueue({
    projectId: "accesswright-dev-123",
    region: "europe-west3",
    queueId: "repair-jobs",
    targetUrl: "https://accesswright-agent-abc-uc.a.run.app/internal/jobs",
    serviceAccountEmail: "job-dispatch@accesswright-dev-123.iam.gserviceaccount.com",
    getAccessToken: () => Promise.resolve("local-fixture-identity"),
    fetcher: (_input, init) => {
      taskCreates++;
      const record = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        task: { httpRequest: { body: string } };
      };
      const decoded = JSON.parse(Buffer.from(record.task.httpRequest.body, "base64").toString("utf8")) as {
        repository: string; installationId: number; event: string;
      };
      expect(decoded).toMatchObject({
        repository: "owner/private", installationId: 42, event: "installation",
      });
      return Promise.resolve(Response.json({ name: "fixture-task" }));
    },
  });
  const server = createHostedWebhookServer({
    secret, installationAllowlist: new Set([42]),
    registry: new InMemoryRunRegistry(),
    queue: async run => { await queue.enqueue(run); },
    authorizeComment: () => Promise.resolve(false),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listening server");
  const url = "http://127.0.0.1:" + address.port + "/github/webhook";
  try {
    const body = JSON.stringify({
      action: "created", installation: { id: 42 },
      repository: { full_name: "owner/private", private: true },
      sender: { login: "reviewer" },
    });
    const headers = {
      "content-type": "application/json",
      "x-github-event": "installation",
      "x-github-delivery": "11111111-1111-4111-8111-111111111111",
      "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    };
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(202);
    const duplicate = await fetch(url, { method: "POST", headers, body });
    expect((await duplicate.json()) as unknown).toMatchObject({ status: "duplicate" });
    expect(taskCreates).toBe(1);
    const bad = await fetch(url, {
      method: "POST", headers: { ...headers, "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body,
    });
    expect(bad.status).toBe(401);
    expect(taskCreates).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";

import { dispatchGitHubWebhook } from "./webhook.js";
import type { WebhookDispatchDependencies, WebhookHeaders } from "./webhook.js";

const MAX_HTTP_WEBHOOK_BYTES = 1_048_576;

class PayloadTooLarge extends Error {
  constructor() { super("Webhook request exceeded the byte size limit"); }
}

function sendJson(response: ServerResponse, code: number, body: object): void {
  const data = JSON.stringify(body);
  response.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(data);
}

async function boundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    length += chunk.byteLength;
    if (length > MAX_HTTP_WEBHOOK_BYTES) throw new PayloadTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function header(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Local HTTP adapter using the same authenticated transport boundary intended
 * for Cloud Run. Queue and state implementations are injected and must be
 * replaced by durable adapters before deployment; no source is persisted here.
 */
export function createHostedWebhookServer(dependencies: WebhookDispatchDependencies) {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/healthz") {
        sendJson(response, 200, { status: "ok" });
        return;
      }
      if (request.url !== "/github/webhook") {
        sendJson(response, 404, { status: "not-found" });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { status: "method-not-allowed" });
        return;
      }
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        sendJson(response, 415, { status: "unsupported-media-type" });
        return;
      }
      try {
        const body = await boundedBody(request);
        const headers: WebhookHeaders = {
          "x-github-delivery": header(request.headers["x-github-delivery"]),
          "x-github-event": header(request.headers["x-github-event"]),
          "x-hub-signature-256": header(request.headers["x-hub-signature-256"]),
        };
        const result = await dispatchGitHubWebhook(body, headers, dependencies);
        sendJson(response, result.status === "queued" ? 202
          : result.status === "unauthorized" ? 401 : 200, result);
      } catch (error) {
        if (error instanceof PayloadTooLarge) {
          sendJson(response, 413, { status: "too-large" });
        } else if (error instanceof SyntaxError || error instanceof ZodError) {
          sendJson(response, 400, { status: "invalid-payload" });
        } else {
          // Never include request bodies, credentials or queue exceptions in the response.
          sendJson(response, 503, { status: "unavailable" });
        }
      }
    })().catch(() => {
      if (!response.writableEnded) sendJson(response, 503, { status: "unavailable" });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

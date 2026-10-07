import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AiSdkLlmProvider } from "../../src/llm/ai-sdk-provider.js";
import { LlmClient } from "../../src/llm/client.js";
import type { LlmCallEvent } from "../../src/llm/client.js";

const closeServers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closeServers.splice(0).map(close => close())); });
async function start(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  closeServers.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener");
  return `http://127.0.0.1:${address.port}/v1`;
}

const responseBody = {
  id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "fixture-model",
  output: [{ id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }],
  usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
};

describe("real SDK transport against an unpaid loopback provider", () => {
  it("sends image bytes and strict output through the actual SDK while retaining only metadata in the observer", async () => {
    let requestBody: unknown;
    let authorization: string | undefined;
    const baseURL = await start((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: unknown) => { if (Buffer.isBuffer(chunk)) chunks.push(chunk); });
      request.on("end", () => {
        requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        authorization = request.headers.authorization;
        response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(responseBody));
      });
    });
    const events: LlmCallEvent[] = [];
    const provider = new AiSdkLlmProvider({ environment: { OPENAI_API_KEY: "fixture-only-not-a-real-key" }, pricing: () => ({ inputUsdPerMillion: 1, outputUsdPerMillion: 2 }) });
    const client = new LlmClient(provider, event => { events.push(event); });
    const png = new Uint8Array([137,80,78,71,13,10,26,10]);
    const result = await client.callStructured({ taskType: "transport-test", model: { provider: "openai", id: "fixture-model", baseURL, reasoningEffort: "high" }, prompt: "Private fixture context must not enter the observer", maxOutputTokens: 100,
      images: [{ data: png, mediaType: "image/png" }] }, z.object({ ok: z.boolean() }).strict());
    expect(result).toMatchObject({ status: "accepted", value: { ok: true }, usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.00012 } });
    expect(authorization).toBe("Bearer fixture-only-not-a-real-key");
    const serialized = JSON.stringify(requestBody);
    expect(serialized).toContain(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
    expect(serialized).toContain('"effort":"high"');
    expect(serialized).toContain('"strict":true');
    expect(serialized).toContain('"store":false');
    expect(serialized).not.toContain("forceReasoning");
    expect(JSON.stringify(events)).not.toContain("Private fixture context");
    expect(JSON.stringify(events)).not.toContain("fixture-only-not-a-real-key");
  });
  it("does not conceal extra billable HTTP retries behind one budget authorization", async () => {
    let attempts = 0;
    const baseURL = await start((_request, response) => { attempts += 1; response.writeHead(500, { "Content-Type": "application/json" }); response.end('{"error":{"message":"fixture failure","type":"server_error"}}'); });
    const provider = new AiSdkLlmProvider({ environment: { OPENAI_API_KEY: "fixture-only" }, pricing: () => ({ inputUsdPerMillion: 1, outputUsdPerMillion: 2 }) });
    await expect(provider.generateObject({ taskType: "transport-error", model: { provider: "openai", id: "fixture-model", baseURL }, prompt: "test", maxOutputTokens: 10 }, z.object({ ok: z.boolean() }))).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

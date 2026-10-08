import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { createAccesswrightMcpServer } from "../../src/mcp/server.js";
import type { McpAgentVerifier } from "../../src/mcp/session.js";

const sessionId = "aaaabbbb-cccc-4ddd-8eee-111122223333";

it("exposes real MCP scan/verify/close protocol calls, rejecting stale session IDs", async () => {
  const calls: string[] = [];
  const verifier = {
    scan: () => {
      calls.push("scan");
      return Promise.resolve({ sessionId, routes: ["/"], tasks: [{
        id: "task-1", ruleId: "aria-valid-attr", criterion: "4.1.2", route: "codemod" as const,
        source: { file: "app/page.tsx", line: 1, column: 1 }, routes: ["/"],
      }], baselineChecks: [{ check: "build", status: "passed" }] });
    },
    verify: (id: string) => {
      calls.push("verify:" + id);
      return Promise.resolve({ accepted: true, stage: "complete" as const, check: "ok", reason: null, evidenceDir: null });
    },
    close: () => {
      calls.push("close");
      return Promise.resolve();
    },
  } satisfies Pick<McpAgentVerifier, "scan" | "verify" | "close">;
  const server = createAccesswrightMcpServer(verifier);
  const client = new Client({ name: "fixture-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map(item => item.name).sort()).toEqual(["close", "scan", "verify"]);

    const scanned = await client.callTool({ name: "scan", arguments: {} });
    expect(scanned.isError).not.toBe(true);
    const textItems = z.array(z.object({ type: z.literal("text"), text: z.string() }).passthrough());
    expect(textItems.parse(scanned.content)[0]?.type).toBe("text");
    const invalid = await client.callTool({
      name: "verify", arguments: { sessionId: "00000000-0000-4000-8000-000000000001", taskId: "task-1" },
    });
    expect(invalid.isError).toBe(true);
    expect(calls).toEqual(["scan"]);

    const verified = await client.callTool({
      name: "verify", arguments: { sessionId, taskId: "task-1" },
    });
    expect(verified.isError).not.toBe(true);
    expect(textItems.parse(verified.content)[0]?.text).toContain('"accepted":true');
    expect(calls).toContain("verify:task-1");

    const closed = await client.callTool({ name: "close", arguments: { sessionId } });
    expect(closed.isError).not.toBe(true);
    expect(calls).toContain("close");
  } finally {
    await client.close();
    await server.close();
  }
});

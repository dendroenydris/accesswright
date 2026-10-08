import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { join } from "node:path";

it("compiled MCP binary speaks JSON-RPC over stdio without provider secrets or a Docker run for discovery", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp/server.js"), "--repo", process.cwd()],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      ACCESSWRIGHT_TMP_ROOT: process.env.ACCESSWRIGHT_TMP_ROOT ?? "/tmp/accesswright-mcp",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "accesswright-stdio-fixture", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(["close", "scan", "verify"]);
    const stale = await client.callTool({
      name: "verify",
      arguments: { sessionId: "00000000-0000-4000-8000-000000000001", taskId: "fixture" },
    });
    expect(stale.isError).toBe(true);
  } finally {
    await client.close();
  }
});

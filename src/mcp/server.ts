#!/usr/bin/env node
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { McpAgentVerifier } from "./session.js";
import { isMainModule } from "../entrypoint.js";

type Verifier = Pick<McpAgentVerifier, "scan" | "verify" | "close">;

function respond(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function failed(error: unknown) {
  const diagnostic = createHash("sha256")
    .update(error instanceof Error ? error.message : "unknown")
    .digest("hex").slice(0, 16);
  // Target output may contain source or credentials; never echo raw exceptions.
  return {
    isError: true,
    content: [{ type: "text" as const, text: "Accesswright MCP verification failed; diagnostic " + diagnostic }],
  };
}

/** Protocol boundary only; no source or screenshots are serialized to tool results. */
export function createAccesswrightMcpServer(verifier: Verifier): McpServer {
  const server = new McpServer({ name: "accesswright", version: "0.0.0" }, { maxToolInputElements: 40 });
  let currentSessionId: string | null = null;
  let busy = false;

  async function exclusive(operation: () => Promise<ReturnType<typeof respond> & { isError?: boolean }>) {
    if (busy) {
      return { isError: true, content: [{ type: "text" as const, text: "MCP verification is busy; retry after the current operation completes" }] };
    }
    busy = true;
    try { return await operation(); }
    finally { busy = false; }
  }

  server.registerTool("scan", {
    description: "Start an isolated accessibility scan and freeze source + browser + production baselines for this repository. No model calls.",
    inputSchema: {},
  }, async () => exclusive(async () => {
    try {
      const result = await verifier.scan();
      currentSessionId = result.sessionId;
      return respond(result);
    } catch (error) {
      currentSessionId = null;
      return failed(error);
    }
  }));

  server.registerTool("verify", {
    description: "After editing project source, verify one task against the frozen scan using real browser and final production checks. Never writes host source.",
    inputSchema: {
      sessionId: z.string().uuid(),
      taskId: z.string().min(1).max(1024),
    },
  }, async ({ sessionId, taskId }) => exclusive(async () => {
    if (sessionId !== currentSessionId) {
      return { isError: true, content: [{ type: "text" as const, text: "MCP scan session is stale or unknown" }] };
    }
    try {
      return respond(await verifier.verify(taskId));
    } catch (error) {
      return failed(error);
    }
  }));

  server.registerTool("close", {
    description: "Clean up the owned MCP scanner session, its Docker containers and temporary source snapshots.",
    inputSchema: { sessionId: z.string().uuid() },
  }, async ({ sessionId }) => exclusive(async () => {
    if (sessionId !== currentSessionId) {
      return { isError: true, content: [{ type: "text" as const, text: "MCP scan session is stale or unknown" }] };
    }
    try {
      await verifier.close();
      currentSessionId = null;
      return respond({ closed: true });
    } catch (error) {
      return failed(error);
    }
  }));

  return server;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--repo" || !args[1] || !isAbsolute(args[1])) {
    throw new Error("Usage: accesswright-mcp --repo /absolute/path/to/next-project");
  }
  const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const verifier = new McpAgentVerifier({
    repoPath: resolve(args[1]),
    runtimeRoot,
    tempRoot: resolve(process.env.ACCESSWRIGHT_TMP_ROOT || join(tmpdir(), "accesswright-mcp")),
  });
  const server = createAccesswrightMcpServer(verifier);
  const shutdown = () => { void verifier.close().finally(() => process.exit(0)); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", () => { void verifier.close(); });
  await server.connect(new StdioServerTransport());
}

if (await isMainModule(import.meta.url)) {
  main().catch(error => {
    const diagnostic = createHash("sha256")
      .update(error instanceof Error ? error.message : "unknown")
      .digest("hex").slice(0, 16);
    process.stderr.write("accesswright-mcp: startup failed; diagnostic " + diagnostic + "\n");
    process.exitCode = 1;
  });
}

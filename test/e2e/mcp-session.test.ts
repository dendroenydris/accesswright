import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { McpAgentVerifier } from "../../src/mcp/session.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";

it("scans real Next.js in isolated Docker and verifies an agent-edited source file through production checks", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const repoPath = await mkdtemp(join(tempRoot, "mcp-real-fixture-"));
  await createNextIntegrationFixture(repoPath);
  const manifest = await readFile(join(repoPath, "package.json"), "utf8");
  const verifier = new McpAgentVerifier({
    repoPath,
    tempRoot,
    runtimeRoot: process.cwd(),
    offline: true,
  });
  try {
    const scan = await verifier.scan();
    const task = scan.tasks.find(item => item.ruleId === "aria-valid-attr" && item.source?.file === "components/Controls.tsx");
    expect(task).toBeDefined();
    expect(scan.routes).toContain("/");
    const sourcePath = join(repoPath, "components/Controls.tsx");
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('aria-bogus="invalid"');
    const repaired = source.replace(' aria-bogus="invalid"', "");
    await writeFile(sourcePath, repaired);
    const result = await verifier.verify(task!.id);
    expect(result, JSON.stringify(result)).toMatchObject({
      accepted: true, stage: "complete", check: "ok", reason: null,
    });
    expect(await readFile(sourcePath, "utf8")).toBe(repaired);
    expect(await readFile(join(repoPath, "package.json"), "utf8")).toBe(manifest);
    expect(result.evidenceDir).not.toBeNull();
    if (result.evidenceDir) {
      const final = JSON.parse(await readFile(join(result.evidenceDir, "final-verification.json"), "utf8")) as { result?: { failures?: unknown[] } };
      expect(final.result?.failures).toEqual([]);
    }
    console.log("MCP real Docker/Next verification evidence:", result.evidenceDir);
  } finally {
    await verifier.close();
  }
});

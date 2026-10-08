import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { DockerRepairSession } from "../../src/runner/repair-session.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";

it("scans an actual Next.js static-export build in a secret-free Docker app/browser pair", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const repoPath = await mkdtemp(join(tempRoot, "static-export-next-"));
  await createNextIntegrationFixture(repoPath);
  const staticConfig = 'export default { output: "export", reactStrictMode: true, poweredByHeader: false };\n';
  await writeFile(join(repoPath, "next.config.mjs"), staticConfig);
  let session: DockerRepairSession | undefined;
  try {
    session = await DockerRepairSession.prepare({
      repoPath, tempRoot, runtimeRoot: process.cwd(),
      config: { scan: { mobile: true, darkScheme: false } },
      retainEvidence: false,
    });
    expect(session.productionBaseline.length).toBeGreaterThan(0);
    expect(session.productionBaseline.some(page => page.route === "/")).toBe(true);
    expect(session.routes).toContain("/help");
    expect(session.baselineChecks.find(check => check.check === "build")?.status).toBe("passed");
    expect(session.observations.some(page => page.sourceIndex?.length)).toBe(true);
    expect(await readFile(join(repoPath, "next.config.mjs"), "utf8")).toBe(staticConfig);
    console.log("Static-export Next.js production/browser proof:", session.evidenceDir);
  } finally {
    await session?.close();
  }
});

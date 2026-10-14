import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { DockerRepairSession } from "../../src/runner/repair-session.js";
import { runRepair } from "../../src/core/repair.js";

it("repairs from a baseline measured by another session on identical source, and refuses changed source", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const fixture = await mkdtemp(join(tempRoot, "shared-baseline-"));
  await createNextIntegrationFixture(fixture);
  const config = { offline: true, scan: { mobile: true, darkScheme: false } };
  const lead = await DockerRepairSession.prepare({ repoPath: fixture, tempRoot, runtimeRoot: process.cwd(), privateDiagnostics: true, config });
  const baseline = await lead.sharedBaseline();
  await lead.close();
  const started = Date.now();
  const follower = await DockerRepairSession.prepare({ repoPath: fixture, tempRoot, runtimeRoot: process.cwd(), privateDiagnostics: true, config, baseline });
  try {
    console.log(`follower preparation ${Date.now() - started} ms`);
    expect(follower.routes).toEqual(baseline.routes);
    expect(follower.baselineChecks).toEqual(baseline.baselineChecks);
    const result = await runRepair(follower, { noLlm: true });
    expect(result.status).toBe("verified");
    expect(result.fixed).toBeGreaterThan(0);
    expect(follower.finalChecks.map(check => check.status)).toEqual(["passed", "passed", "passed", "passed"]);
  } finally { await follower.close(); }
  await writeFile(join(fixture, "app/help/page.tsx"), 'export default function Help() { return <p>Changed source</p>; }\n');
  await expect(DockerRepairSession.prepare({ repoPath: fixture, tempRoot, runtimeRoot: process.cwd(), config, baseline })).rejects.toThrow(/byte-identical/);
});

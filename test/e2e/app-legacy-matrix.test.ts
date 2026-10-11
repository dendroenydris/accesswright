import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { DockerRepairSession } from "../../src/runner/repair-session.js";
import { runRepair } from "../../src/core/repair.js";

for (const next of ["13.5.11", "14.2.35"] as const) {
  it(`maps and repairs Next ${next} App Router through webpack source mapping`, async () => {
    const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, `app-${next}-`));
    await createNextIntegrationFixture(root, next);
    const configuration = await readFile(join(root, "next.config.mjs"), "utf8");
    const session = await DockerRepairSession.prepare({ repoPath: root, tempRoot, runtimeRoot: process.cwd(), retainEvidence: true, privateDiagnostics: true, config: { offline: true, scan: { mobile: true, darkScheme: false } } });
    try {
      expect(session.routes).toEqual(["/", "/help"]);
      expect(session.baselineChecks.map(check => check.status), JSON.stringify(session.baselineChecks)).toEqual(["passed", "passed", "passed", "passed"]);
      const mapped = session.baselineObservations.flatMap(page => page.violations).filter(violation => violation.ruleId === "aria-valid-attr").map(violation => violation.source?.file);
      expect(mapped).toContain("components/Controls.tsx");
      const result = await runRepair(session, { noLlm: true });
      expect(result.status).toBe("verified");
      expect(result.fixed).toBeGreaterThan(0);
      expect(session.finalChecks.map(check => check.status)).toEqual(["passed", "passed", "passed", "passed"]);
      expect(await readFile(join(root, "next.config.mjs"), "utf8")).toBe(configuration);
      console.log(`Next ${next} App Router compatibility evidence: ${session.evidenceDir}`);
    } finally { await session.close(); }
  });
}

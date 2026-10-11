import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createPagesIntegrationFixture } from "../fixtures/pages-integration.js";
import { DockerRepairSession } from "../../src/runner/repair-session.js";
import { runRepair } from "../../src/core/repair.js";

for (const [next, language] of [["12.3.7", "jsx"], ["13.5.11", "tsx"], ["14.2.35", "jsx"], ["15.5.27", "tsx"], ["16.3.8", "jsx"]] as const) {
  it(`maps and repairs Next ${next} Pages Router ${language}, a dynamic route and fetched HTTP data`, async () => {
    const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
    await mkdir(tempRoot, { recursive: true });
    const root = await mkdtemp(join(tempRoot, `pages-${next}-${language}-`));
    const expected = await createPagesIntegrationFixture(root, next, language);
    const configuration = await readFile(join(root, "next.config.mjs"), "utf8");
    const session = await DockerRepairSession.prepare({ repoPath: root, tempRoot, runtimeRoot: process.cwd(), retainEvidence: true, privateDiagnostics: true, config: { offline: true, scan: { mobile: true } } });
    try {
      expect(session.routes).toEqual(["/", "/item/alpha"]);
      expect(session.baselineChecks.map(check => check.status), JSON.stringify(session.baselineChecks)).toEqual(["passed", "passed", "passed", "passed"]);
      const actual = session.baselineObservations.flatMap(page => page.violations).filter(violation => violation.ruleId === "aria-valid-attr").map(violation => violation.source);
      expect(actual.sort((a, b) => (a?.file ?? "").localeCompare(b?.file ?? ""))).toEqual(expected.sort((a, b) => a.file.localeCompare(b.file)));
      expect(session.baselineObservations.filter(page => page.route === "/").every(page => page.aria.some(node => node.name === "External fixture record"))).toBe(true);
      expect(session.inspection.privateFilesPresent).toEqual([]);
      expect(session.inspection.processEnvironmentNames).not.toContain("OPENAI_API_KEY");
      const result = await runRepair(session, { noLlm: true });
      expect(result).toMatchObject({ status: "verified", fixed: 2 });
      expect(session.finalChecks.map(check => check.status)).toEqual(["passed", "passed", "passed", "passed"]);
      expect(await readFile(join(root, "next.config.mjs"), "utf8")).toBe(configuration);
      await writeFile(join(session.evidenceDir, "compatibility-report.json"), JSON.stringify({ date: new Date().toISOString(), next, language, router: "pages", routes: session.routes, expected, actual, result, checks: session.finalChecks, externalData: "controlled HTTP service, distinct from Next.js, inside the no-secret target sandbox" }, null, 2));
      console.log(`Next ${next} ${language} compatibility evidence: ${session.evidenceDir}`);
    } finally { await session.close(); }
  });
}

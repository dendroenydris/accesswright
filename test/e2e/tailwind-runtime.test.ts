import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { repairRepository } from "../../src/core/repository.js";
import { createTailwindIntegrationFixture } from "../fixtures/tailwind-integration.js";

it("uses actual Tailwind CSS computed colors and proposes shared-token changes without applying them", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "tailwind-fixture-"));
  await createTailwindIntegrationFixture(root);
  const css = await readFile(join(root, "app/globals.css"), "utf8");
  const result = await repairRepository({ repoPath: root, tempRoot, runtimeRoot: process.cwd(), offline: true, noLlm: true, retainEvidence: true });
  expect(result.report, JSON.stringify(result.report)).toMatchObject({ status: "verified", fixed: 1, applied: true, providerVerification: "not-run" });
  const page = await readFile(join(root, "app/page.tsx"), "utf8");
  expect(page).toContain('id="palette-target" className="text-gray-700 bg-white"');
  expect(page).toContain('id="passing-palette" className="text-gray-700 bg-white"');
  expect(page).toContain('color: "var(--brand-muted)"');
  expect(await readFile(join(root, "app/globals.css"), "utf8")).toBe(css);
  expect(result.report.outcomes.some(outcome => outcome.status === "needs-human" && outcome.reason?.includes("shared-token:--brand-muted"))).toBe(true);
  expect(result.report.checks.map(check => check.status)).toEqual(["passed", "passed", "passed", "passed"]);
  console.log(`Real Tailwind 4.3.3 evidence: ${result.evidenceDir}`);
});

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";

/** Checks rendered semantic ground truth independently of whether axe accepted the fix. */
export async function assertSaveButtonEvidence(evidenceDir: string): Promise<void> {
  const final = z.object({ productionPasses: z.number().int().positive() }).parse(JSON.parse(await readFile(join(evidenceDir, "final-verification.json"), "utf8")));
  const before = z.array(BrowserObservationSchema).parse(JSON.parse(await readFile(join(evidenceDir, "production-baseline-observations.json"), "utf8")));
  const after = z.array(BrowserObservationSchema).parse(JSON.parse(await readFile(join(evidenceDir, `production-final-${final.productionPasses}-observations.json`), "utf8")));
  const home = before.filter(page => page.route === "/");
  expect(home.map(page => page.condition).sort()).toEqual(["desktop-light", "mobile-light"]);
  for (const page of home) {
    const targets = page.aria.filter(node => node.role === "button" && node.name === "");
    expect(targets).toHaveLength(1);
    const target = targets[0];
    if (!target) throw new Error("Controlled baseline must expose the unnamed real button");
    const candidate = after.find(item => item.route === page.route && item.condition === page.condition);
    expect(candidate).toBeDefined();
    expect(candidate?.aria.find(node => node.id === target.id)).toMatchObject({ role: "button", name: "Save changes", interactive: true });
    expect(candidate?.violations.some(violation => violation.ruleId === "button-name")).toBe(false);
    expect(candidate?.incomplete.some(violation => violation.ruleId === "button-name")).toBe(false);
  }
}

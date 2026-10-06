import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import { z } from "zod";

import { extractSourceLocationFromHtml } from "./source-location.js";
import type { SourceLocation } from "./source-location.js";

const targetPartSchema = z.union([z.string(), z.array(z.string())]);

const axeNodeSchema = z.object({
  target: z.array(targetPartSchema),
  html: z.string(),
  failureSummary: z.string().nullable().optional(),
});

const axeRuleSchema = z.object({
  id: z.string(),
  impact: z.string().nullable(),
  tags: z.array(z.string()),
  description: z.string(),
  help: z.string(),
  helpUrl: z.string(),
  nodes: z.array(axeNodeSchema),
});

const axeResultBoundarySchema = z.object({
  violations: z.array(axeRuleSchema),
  incomplete: z.array(axeRuleSchema),
});

export interface ViolationInstance {
  ruleId: string;
  impact: string | null;
  route: string;
  target: string[];
  html: string;
  failureSummary: string | null;
  source: SourceLocation | null;
}

export interface NormalizedAxeResults {
  violations: ViolationInstance[];
  incomplete: ViolationInstance[];
}

export interface PageScanResult extends NormalizedAxeResults {
  ariaTree: string;
  screenshotPath: string | null;
}

function normalizeTarget(target: ReadonlyArray<string | string[]>): string[] {
  return target.map((part) => (typeof part === "string" ? part : part.join(" >> ")));
}

function normalizeRules(
  route: string,
  rules: z.infer<typeof axeRuleSchema>[],
): ViolationInstance[] {
  return rules.flatMap((rule) =>
    rule.nodes.map((node) => ({
      ruleId: rule.id,
      impact: rule.impact,
      route,
      target: normalizeTarget(node.target),
      html: node.html,
      failureSummary: node.failureSummary ?? null,
      source: extractSourceLocationFromHtml(node.html),
    })),
  );
}

export function normalizeAxeResults(route: string, raw: unknown): NormalizedAxeResults {
  const parsed = axeResultBoundarySchema.parse(raw);
  return {
    violations: normalizeRules(route, parsed.violations),
    incomplete: normalizeRules(route, parsed.incomplete),
  };
}

export async function scanPage(
  page: Page,
  route: string,
  screenshotPath?: string,
): Promise<PageScanResult> {
  const axeResults = await new AxeBuilder({ page }).exclude("nextjs-portal").analyze();
  const normalized = normalizeAxeResults(route, axeResults);
  const ariaTree = await page.locator("body").ariaSnapshot();

  if (screenshotPath !== undefined) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }

  return {
    ...normalized,
    ariaTree,
    screenshotPath: screenshotPath ?? null,
  };
}

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { z } from "zod";
import { defaults } from "../config.js";
import { ViolationSchema } from "../types/schemas.js";
import type { Violation } from "../types/schemas.js";
import type { ScanCondition } from "./browser-facts.js";

const issueSchema = z.object({
  ruleId: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/), reasonId: z.union([z.string(), z.number()]).optional(),
  value: z.tuple([z.enum(["VIOLATION", "RECOMMENDATION", "INFORMATION"]), z.enum(["PASS", "FAIL", "POTENTIAL", "MANUAL"])]),
  target: z.array(z.string().min(1)).min(1), snippet: z.string(), message: z.string(),
}).strict();
const reportSchema = z.object({ numExecuted: z.number().int().positive(), results: z.array(issueSchema).max(defaults.secondCheckerMaxResults) }).strict();

// Only reviewed equivalent failures share axe rule identities; broader IBM checks stay manual.
const ruleMappings: Readonly<Record<string, string>> = {
  img_alt_valid: "image-alt", page_title_exists: "document-title", "html_lang_exists:Fail_3": "html-has-lang",
};

export function normalizeIbmResults(route: string, condition: ScanCondition, raw: unknown) {
  const report = reportSchema.parse(raw);
  const violations: Violation[] = [], incomplete: Violation[] = [];
  for (const issue of report.results) {
    if (issue.value[1] === "PASS") continue;
    const ruleId = ruleMappings[`${issue.ruleId}:${issue.reasonId}`] ?? ruleMappings[issue.ruleId] ?? `ibm-${issue.ruleId.replaceAll("_", "-")}`;
    const item = ViolationSchema.parse({ ruleId, impact: null, route, condition,
      target: issue.target, html: issue.snippet, failureSummary: issue.message, source: null });
    if (issue.value[0] === "VIOLATION" && issue.value[1] === "FAIL") violations.push(item);
    else incomplete.push(item);
  }
  return { violations, incomplete };
}

/** Cross-checker dedup keeps the larger occurrence count, never a set that hides repeated failures. */
export function mergeCheckerFindings(axe: readonly Violation[], ibm: readonly Violation[]): Violation[] {
  const counts = new Map<string, number>();
  const identity = (v: Violation) => JSON.stringify([v.ruleId, v.route, v.condition, v.target]);
  for (const item of axe) { const key = identity(item); counts.set(key, (counts.get(key) ?? 0) + 1); }
  const seen = new Map<string, number>(), merged = [...axe];
  for (const item of ibm) {
    const key = identity(item), count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > (counts.get(key) ?? 0)) merged.push(item);
  }
  return merged;
}

export async function scanIbmPage(page: Page, route: string, condition: ScanCondition, axe: readonly Violation[]) {
  const require = createRequire(import.meta.url);
  const metadata = z.object({ name: z.literal("accessibility-checker-engine"), version: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/), license: z.literal("Apache-2.0") })
    .parse(JSON.parse(await readFile(require.resolve("accessibility-checker-engine/package.json"), "utf8")) as unknown);
  await page.addScriptTag({ path: require.resolve("accessibility-checker-engine/ace.js") });
  const raw: unknown = await page.evaluate(async ({ findings, limit, mappings }) => {
    const engine = (globalThis as unknown as { ace: { Checker: new () => { check: (node: Document, policies: string[]) => Promise<{ numExecuted: number; results: Array<{ ruleId: string; reasonId?: string | number; value: [string, string]; node: Node; path: { dom?: string }; snippet: string; message: string }> }> } } }).ace;
    const report = await new engine.Checker().check(document, ["IBM_Accessibility"]);
    if (report.results.length > limit) throw new Error("IBM checker result capacity exceeded");
    const known = findings.map(item => {
      let node: Element | null = null;
      try { if (item.target.length === 1) node = document.querySelector(item.target[0] ?? ""); } catch { /* Frame/shadow locators remain separate findings. */ }
      return { ...item, node };
    });
    return { numExecuted: report.numExecuted, results: report.results.map(issue => {
      const node = issue.node instanceof Document ? issue.node.documentElement : issue.node;
      const rule = mappings[`${issue.ruleId}:${issue.reasonId}`] ?? mappings[issue.ruleId] ?? `ibm-${issue.ruleId.replaceAll("_", "-")}`;
      const matching = known.find(item => item.ruleId === rule && item.node !== null && item.node === node);
      const target = issue.value[1] === "PASS" ? ["pass"] : matching?.target ?? [`xpath=${issue.path.dom ?? ""}`];
      if (issue.value[1] !== "PASS" && !matching && !issue.path.dom) throw new Error("IBM finding has no resolvable identity");
      return { ruleId: issue.ruleId, ...(issue.reasonId === undefined ? {} : { reasonId: issue.reasonId }), value: issue.value,
        target, snippet: issue.snippet, message: issue.message };
    }) };
  }, { findings: axe.map(item => ({ ruleId: item.ruleId, target: item.target })), limit: defaults.secondCheckerMaxResults, mappings: ruleMappings });
  return { ...normalizeIbmResults(route, condition, raw), version: metadata.version };
}

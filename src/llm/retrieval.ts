import { createHash } from "node:crypto";
import { defaults } from "../config.js";
import { getRepairGuidance, llmGuidanceRuleIds } from "./guidance.js";
import type { FixTask } from "../types/schemas.js";

/** Ablation corpus is the existing reviewed rule table, not an external WCAG index or learned fix memory. */
export function retrieveRepairGuidance(task: FixTask) {
  const documents = llmGuidanceRuleIds.map(id => ({ id, text: getRepairGuidance(id) }));
  const words = new Set(`${task.ruleId} ${task.violations.map(item => item.failureSummary ?? "").join(" ")}`.toLowerCase().match(/[a-z]+/g) ?? []);
  const ranked = documents.map(document => ({ ...document, score: [...new Set(`${document.id} ${document.text}`.toLowerCase().match(/[a-z]+/g) ?? [])].filter(word => words.has(word)).length }))
    .filter(document => document.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, defaults.evalRetrievedGuidanceMaxDocuments);
  return { corpus: "reviewed-rule-table" as const, corpusDigest: createHash("sha256").update(JSON.stringify(documents)).digest("hex"),
    documentIds: ranked.map(document => document.id), guidance: ranked.map(document => `${document.id}: ${document.text}`).join("\n") };
}

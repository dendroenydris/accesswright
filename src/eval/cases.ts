import { z } from "zod";
import { ScanConditionSchema, violationKey } from "../scanner/browser-facts.js";
import type { BrowserObservation } from "../scanner/observations.js";
import { ViolationSchema } from "../types/schemas.js";
import type { Violation } from "../types/schemas.js";
import { MutationSchema } from "./operators.js";
import type { Mutation } from "./operators.js";

const referenceSchema = z.object({ route: z.string(), condition: ScanConditionSchema, nodeId: z.string(), target: z.array(z.string()),
  role: z.string().nullable(), name: z.string(), text: z.string(), interactive: z.boolean(), language: z.string().nullable() }).strict();
export const RenderedCaseSchema = z.object({ mutation: MutationSchema, references: z.array(referenceSchema).min(1), observedTargets: z.array(ViolationSchema).default([]) }).strict();
export type RenderedCase = z.infer<typeof RenderedCaseSchema>;
export interface ExcludedCase { id: string; reason: string }
const sameTarget = (left: readonly string[], right: readonly string[]) => JSON.stringify(left) === JSON.stringify(right);

/** Semantic truth is captured from the unmodified rendered repository BEFORE any proposal is generated. */
export function freezeRenderedCases(mutations: readonly Mutation[], observations: readonly BrowserObservation[]) {
  const eligible: RenderedCase[] = [], excluded: ExcludedCase[] = [];
  for (const mutation of mutations) {
    const references: RenderedCase["references"] = [];
    let originallyBroken = false;
    for (const page of observations) {
      const locations = (page.sourceIndex ?? []).filter(item => {
        if (mutation.operator === "break-label") return item.nodeId.endsWith(`|#${mutation.referenceValue ?? ""}`) && ["input", "select", "textarea"].includes(item.tagName);
        return item.mapping === "direct" && item.source.file === mutation.file && item.source.line === mutation.source.line && item.source.column === mutation.source.column && item.tagName === mutation.tagName;
      });
      for (const location of locations) {
        const node = page.aria.find(node => node.id === location.nodeId);
        if (!node && mutation.operator !== "remove-lang") continue;
        const findings = [...page.violations, ...page.incomplete];
        if (findings.some(finding => sameTarget(finding.target, location.target) || page.contexts.some(context => context.nodeId === location.nodeId && sameTarget(context.target, finding.target)))) originallyBroken = true;
        if (mutation.operator === "remove-lang" && !page.documentLanguage?.trim()) originallyBroken = true;
        if (["remove-alt", "remove-button-name", "remove-link-name", "break-label"].includes(mutation.operator) && !node?.name.trim()) originallyBroken = true;
        references.push({ route: page.route, condition: page.condition, nodeId: location.nodeId, target: location.target, role: node?.role ?? null, name: node?.name ?? "", text: node?.text ?? "", interactive: node?.interactive ?? false, language: page.documentLanguage ?? null });
      }
    }
    if (references.length === 0 || originallyBroken) excluded.push({ id: mutation.id, reason: originallyBroken ? "original-target-not-clean" : "no-rendered-source-correspondence" });
    else eligible.push(RenderedCaseSchema.parse({ mutation, references }));
  }
  return { eligible, excluded };
}

function matches(item: RenderedCase, page: BrowserObservation, violation: Violation): boolean {
  if (violation.ruleId !== item.mutation.ruleId) return false;
  if (item.observedTargets.some(target => violationKey(target) === violationKey(violation))) return true;
  return item.references.some(reference => reference.route === page.route && reference.condition === page.condition &&
    (sameTarget(reference.target, violation.target) || page.contexts.some(context => context.nodeId === reference.nodeId && sameTarget(context.target, violation.target))));
}

/** Only actually triggered mutations enter the denominator. Rejected injection reasons remain explicit. */
export function injectedTargets(cases: readonly RenderedCase[], injected: readonly BrowserObservation[]) {
  const eligible: RenderedCase[] = [], excluded: ExcludedCase[] = [];
  for (const item of cases) {
    const targets = injected.flatMap(page => page.violations.filter(violation => matches(item, page, violation)));
    if (!targets.length) excluded.push({ id: item.mutation.id, reason: "injection-did-not-trigger-target" });
    else eligible.push({ ...item, observedTargets: targets });
  }
  return { eligible, excluded };
}

type ReferenceFacts = { role: string | null; name: string; text: string; interactive: boolean };
const sameFacts = (node: ReferenceFacts, reference: ReferenceFacts) =>
  node.role === reference.role && node.interactive === reference.interactive && node.name === reference.name && node.text === reference.text;

/**
 * Node ids built from React useId values or DOM paths can change between builds (8starlabs/ui: `#base-ui-_R_6jadlb_`
 * became `#base-ui-_R_39l7b_`). When the id is gone, count nodes with identical facts instead: the fixed page must keep
 * at least as many as the unpatched baseline page, so a deleted or renamed node still fails.
 */
function restored(reference: ReferenceFacts & { nodeId: string }, page: BrowserObservation, baselinePage: BrowserObservation | undefined): boolean {
  const node = page.aria.find(node => node.id === reference.nodeId);
  if (node !== undefined) return sameFacts(node, reference);
  const count = page.aria.filter(node => sameFacts(node, reference)).length;
  return count > 0 && count >= (baselinePage?.aria.filter(node => sameFacts(node, reference)).length ?? Number.POSITIVE_INFINITY);
}

export function scoreCases(cases: readonly RenderedCase[], after: readonly BrowserObservation[], finalGatePassed: boolean, baseline: readonly BrowserObservation[] = []) {
  return cases.map(item => {
    const scopeComplete = item.references.every(reference => after.some(page => page.route === reference.route && page.condition === reference.condition));
    const unresolved = after.some(page => [...page.violations, ...page.incomplete].some(violation => matches(item, page, violation)));
    const checkerAccepted = finalGatePassed && scopeComplete && !unresolved;
    const semanticallyCorrect = scopeComplete && item.references.every(reference => {
      const page = after.find(page => page.route === reference.route && page.condition === reference.condition);
      if (!page) return false;
      if (item.mutation.operator === "remove-lang") return page.documentLanguage === reference.language && Boolean(reference.language);
      return restored(reference, page, baseline.find(item => item.route === reference.route && item.condition === reference.condition));
    });
    return { id: item.mutation.id, operator: item.mutation.operator, checkerAccepted, semanticallyCorrect, correctlyFixed: checkerAccepted && semanticallyCorrect };
  });
}

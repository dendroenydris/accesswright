import type { BrowserObservation } from "../scanner/observations.js";
import type { RenderedCase } from "./cases.js";

/** Compare untouched, originally clean rendered nodes. File-scope anomalies are review flags, not invented semantic labels. */
export function compareCleanControls(before: readonly BrowserObservation[], after: readonly BrowserObservation[], cases: readonly RenderedCase[], editedFiles: readonly string[], allowedFiles: ReadonlySet<string>) {
  const excluded = new Set(cases.flatMap(item => item.references.map(reference => reference.nodeId)));
  for (const page of before) {
    const findings = [...page.violations, ...page.incomplete];
    for (const context of page.contexts) if (context.nodeId && findings.some(item => JSON.stringify(item.target) === JSON.stringify(context.target))) excluded.add(context.nodeId);
  }
  const current = new Map(after.flatMap(page => page.aria).map(node => [node.id, node]));
  const controls = new Map(before.flatMap(page => page.aria).filter(node => !excluded.has(node.id) && (node.interactive || node.protectedContent || node.name.trim() || node.text.trim())).map(node => [node.id, node]));
  let changed = 0;
  for (const node of controls.values()) {
    const found = current.get(node.id);
    if (!found || found.role !== node.role || found.name !== node.name || found.text !== node.text || found.interactive !== node.interactive) changed += 1;
  }
  return { observed: controls.size, changed, unexpectedEditedFiles: [...new Set(editedFiles.filter(file => !allowedFiles.has(file)))].sort() };
}

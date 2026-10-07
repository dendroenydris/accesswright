/** Technical cross-references, not a statement of legal applicability or conformity. */
export const referenceEdition = "EN 301 549 V3.2.1 (2021-03)" as const;
export const referenceSource = "https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf";

// This edition's chapter 9 mirrors WCAG 2.1 A/AA. Only reviewed criteria used by
// this package are mapped here; WCAG 2.2 additions must not acquire invented clauses.
const reviewedCriteria = new Set(["1.1.1", "1.3.1", "1.4.3", "1.4.10", "1.4.11", "2.1.1", "2.4.2", "2.4.3", "2.4.4", "2.4.7", "3.1.1", "3.3.2", "4.1.1", "4.1.2"]);
export function criterionReference(criterion: string) {
  return { criterion, en301549: reviewedCriteria.has(criterion) ? `9.${criterion}` : null, edition: referenceEdition, source: referenceSource };
}

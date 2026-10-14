import { en301549Clause } from "./wcag.js";

/** Technical cross-references, not a statement of legal applicability or conformity. */
export const referenceEdition = "EN 301 549 V3.2.1 (2021-03)" as const;
export const referenceSource = "https://www.etsi.org/deliver/etsi_en/301500_301599/301549/03.02.01_60/en_301549v030201p.pdf";

export function criterionReference(criterion: string) {
  return { criterion, en301549: en301549Clause(criterion), edition: referenceEdition, source: referenceSource };
}

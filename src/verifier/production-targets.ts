import { createHash } from "node:crypto";
import type { FixTask } from "../types/schemas.js";
import { violationKey } from "../scanner/browser-facts.js";
import type { PageVerificationState } from "./per-patch.js";

/** A selected fix must remain effective in production, not merely avoid new failures. */
export function unresolvedProductionTargets(tasks: readonly FixTask[], after: PageVerificationState): string[] {
  const unresolved = new Set([...after.violations, ...(after.incomplete ?? [])].map(violationKey));
  return tasks.filter(task => task.violations.some(violation => unresolved.has(violationKey(violation)))).map(task =>
    `production-target:${createHash("sha256").update(task.id).digest("hex").slice(0, 16)}`,
  );
}

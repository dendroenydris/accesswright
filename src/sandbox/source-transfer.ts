import { applySourcePatch, SourcePatchRejectedError } from "./source-boundary.js";
import type { Patch } from "../types/schemas.js";

/** Both the host snapshot and every target-container source must be restored before safe continuation. */
export async function applyTransferredPatch(root: string, patch: Patch, transfer: (path: string) => Promise<void>): Promise<Patch> {
  const normalized = await applySourcePatch(root, patch);
  try {
    for (const change of normalized.changes) await transfer(change.path);
    return normalized;
  } catch (error) {
    try {
      await applySourcePatch(root, { taskId: patch.taskId, changes: normalized.changes.map(change => ({ ...change, before: change.after, after: change.before })) });
      for (const change of normalized.changes) await transfer(change.path);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Container source rollback could not be verified; abort this repair session", { cause: rollbackError });
    }
    throw new SourcePatchRejectedError("Candidate source transfer failed; all host and container sources were restored");
  }
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { resolveSafeSource } from "../sandbox/source-boundary.js";
import { generateMutations } from "./operators.js";
import type { Operator } from "./protocol.js";
import type { EvalReference } from "./resume.js";

/**
 * A frozen reference may avoid repeating an expensive *original* baseline on
 * resume only when every AST mutation exactly matches the original pinned
 * source bytes. Every resumed candidate still gets a fresh Docker build,
 * browser scan, per-patch verdict and final production verifier.
 *
 * The reference identity, implementation digest and original test selection
 * must have already passed loadEvalResumeState() validation.
 */
export async function verifyFrozenReferenceSource(
  sourceRoot: string,
  reference: EvalReference,
  operators: readonly Operator[],
): Promise<void> {
  const eligible = reference.rendered.eligible;
  if (eligible.length > 10000) throw new Error("Frozen reference exceeds the mutation bound");
  const allowed = new Set(operators);
  const grouped = new Map<string, typeof eligible>();
  const identifiers = new Set<string>();
  for (const item of eligible) {
    if (!allowed.has(item.mutation.operator)) {
      throw new Error("Frozen reference contains an operator excluded by the protocol");
    }
    if (identifiers.has(item.mutation.id)) throw new Error("Frozen reference has duplicate mutations");
    identifiers.add(item.mutation.id);
    if (item.observedTargets.length !== 0) {
      throw new Error("Original frozen reference cannot include injected target observations");
    }
    grouped.set(item.mutation.file, [...(grouped.get(item.mutation.file) ?? []), item]);
  }
  for (const [file, items] of grouped) {
    const safe = await resolveSafeSource(sourceRoot, file);
    const source = await readFile(safe, "utf8");
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const regenerated = new Map(generateMutations(file, source).map(item => [item.id, item]));
    for (const item of items) {
      if (item.mutation.sourceHash !== sourceHash) {
        throw new Error("Pinned source changed since the original frozen baseline");
      }
      const canonical = regenerated.get(item.mutation.id);
      if (!canonical || JSON.stringify(canonical) !== JSON.stringify(item.mutation)) {
        throw new Error("Frozen reference mutation does not match the pinned source AST");
      }
    }
  }
}

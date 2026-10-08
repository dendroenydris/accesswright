import { createHash } from "node:crypto";
import type { FixTask } from "../types/schemas.js";
import { violationKey } from "../scanner/browser-facts.js";
import { RenderedCaseSchema } from "./cases.js";
import type { RenderedCase } from "./cases.js";

/** Seeded selection happens once before outcomes. Repeated-component mutations use separate isolated batches. */
export function planCaseBatches(input: readonly RenderedCase[], seed: number, maximum: number): RenderedCase[][] {
  if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid evaluation seed or case bound");
  const cases = input.map(item => RenderedCaseSchema.parse(item));
  if (new Set(cases.map(item => item.mutation.id)).size !== cases.length) throw new Error("Duplicate rendered case");
  const key = (item: RenderedCase) => createHash("sha256").update(`${seed}:${item.mutation.id}`).digest("hex");
  const selected = cases.sort((a, b) => key(a).localeCompare(key(b))).slice(0, maximum);
  const batches: RenderedCase[][] = [];
  for (const item of selected) {
    const batch = batches.find(batch => batch.every(other => other.mutation.component !== item.mutation.component &&
      (other.mutation.file !== item.mutation.file || other.mutation.end <= item.mutation.start || item.mutation.end <= other.mutation.start)));
    if (batch) batch.push(item);
    else batches.push([item]);
  }
  return batches;
}

export function taskMatchesCases(task: FixTask, cases: readonly RenderedCase[]): boolean {
  const targets = new Set(cases.filter(item => item.mutation.ruleId === task.ruleId).flatMap(item => item.observedTargets.map(violationKey)));
  return task.violations.some(violation => targets.has(violationKey(violation)));
}

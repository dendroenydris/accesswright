import { getRuleDefinition } from "../planner/rules.js";
import type { FixTask, Violation } from "../types/schemas.js";

export interface AccessibleNodeFact {
  id: string;
  role: string | null;
  name: string;
  text: string;
  interactive: boolean;
  headingLevel?: number;
}

export interface PageVerificationState {
  violations: Violation[];
  aria: AccessibleNodeFact[];
  probeFailures: string[];
}

export type PerPatchCheck =
  | "ok"
  | "target"
  | "new-violation"
  | "probe"
  | "aria-tree";

export interface PerPatchVerificationResult {
  accepted: boolean;
  check: PerPatchCheck;
  reason: string | null;
}

export interface PerPatchVerificationInput {
  task: FixTask;
  before: PageVerificationState;
  after: PageVerificationState;
}

function violationIdentity(violation: Violation): string {
  return [
    violation.ruleId,
    violation.route,
    violation.target.join(" >> "),
  ].join("|");
}

function reject(
  check: Exclude<PerPatchCheck, "ok">,
  reason: string,
): PerPatchVerificationResult {
  return { accepted: false, check, reason };
}

function verifyAriaTree(
  task: FixTask,
  before: readonly AccessibleNodeFact[],
  after: readonly AccessibleNodeFact[],
): PerPatchVerificationResult | null {
  const permissions = getRuleDefinition(task.ruleId).ariaPermissions;
  const afterById = new Map(after.map((node) => [node.id, node]));

  for (const previous of before) {
    const current = afterById.get(previous.id);
    if (current === undefined) {
      const decorative =
        previous.text.trim().length === 0 &&
        previous.name.trim().length === 0 &&
        !previous.interactive;

      if (!decorative) {
        return reject(
          "aria-tree",
          `Accessible node disappeared or became hidden: ${previous.id}`,
        );
      }
      continue;
    }

    if (previous.text.length > 0 && previous.text !== current.text) {
      return reject(
        "aria-tree",
        `Visible text changed or disappeared at ${previous.id}`,
      );
    }

    if (previous.interactive && !current.interactive) {
      return reject(
        "aria-tree",
        `Interactive node became non-interactive: ${previous.id}`,
      );
    }

    if (previous.name.length > 0 && current.name.length === 0) {
      return reject(
        "aria-tree",
        `Accessible name disappeared at ${previous.id}`,
      );
    }

    if (
      previous.role !== current.role &&
      !permissions.allowRoleChange
    ) {
      return reject(
        "aria-tree",
        `Role changed without rule permission at ${previous.id}: ${previous.role ?? "none"} -> ${current.role ?? "none"}`,
      );
    }

    if (
      previous.headingLevel !== current.headingLevel &&
      previous.headingLevel !== undefined &&
      current.headingLevel !== undefined &&
      !permissions.allowHeadingLevelChange
    ) {
      return reject(
        "aria-tree",
        `Heading level changed without rule permission at ${previous.id}`,
      );
    }
  }

  return null;
}

export function verifyPerPatch(
  input: PerPatchVerificationInput,
): PerPatchVerificationResult {
  const targetIdentities = new Set(input.task.violations.map(violationIdentity));
  const afterIdentities = new Set(input.after.violations.map(violationIdentity));

  for (const target of targetIdentities) {
    if (afterIdentities.has(target)) {
      return reject("target", `Target violation remains: ${target}`);
    }
  }

  const beforeIdentities = new Set(input.before.violations.map(violationIdentity));
  for (const violation of input.after.violations) {
    const identity = violationIdentity(violation);
    if (!beforeIdentities.has(identity)) {
      return reject("new-violation", `New violation introduced: ${identity}`);
    }
  }

  if (input.after.probeFailures.length > 0) {
    return reject(
      "probe",
      `Dynamic verifier probe failed: ${input.after.probeFailures.join(", ")}`,
    );
  }

  const ariaFailure = verifyAriaTree(
    input.task,
    input.before.aria,
    input.after.aria,
  );
  if (ariaFailure !== null) return ariaFailure;

  return { accepted: true, check: "ok", reason: null };
}

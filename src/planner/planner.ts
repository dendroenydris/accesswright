import { FixTaskSchema } from "../types/schemas.js";
import type { FixTask, FixRoute, SourceLocation, Violation } from "../types/schemas.js";
import { getRuleDefinition } from "./rules.js";

export interface PlannerOptions {
  noLlm?: boolean;
}

const impactRank: Readonly<Record<string, number>> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

function sourceKey(source: SourceLocation | null): string {
  if (source === null) return "unmapped";
  return `${source.file}:${source.line}:${source.column}`;
}

function isEditableProjectSource(source: SourceLocation | null): boolean {
  if (source === null || source.file.startsWith("/")) return false;
  return !source.file.split("/").includes("node_modules");
}

function plannedRoute(violation: Violation, options: PlannerOptions): FixRoute {
  if (!isEditableProjectSource(violation.source)) return "human";
  const definition = getRuleDefinition(violation.ruleId);
  if (options.noLlm === true && definition.route === "llm") return "human";
  return definition.route;
}

function taskId(
  violation: Violation,
  criterion: string,
  route: FixRoute,
): string {
  const target = violation.source === null
    ? `${violation.route}:${violation.target.join("|")}`
    : sourceKey(violation.source);
  return `${route}:${criterion}:${violation.ruleId}:${target}`;
}

function groupKey(
  violation: Violation,
  criterion: string,
  route: FixRoute,
): string {
  return taskId(violation, criterion, route);
}

export function planFixTasks(
  violations: readonly Violation[],
  options: PlannerOptions = {},
): FixTask[] {
  const groups = new Map<string, {
    seed: Violation;
    violations: Violation[];
    routes: Set<string>;
    route: FixRoute;
    criterion: string;
  }>();

  for (const violation of violations) {
    const definition = getRuleDefinition(violation.ruleId);
    const route = plannedRoute(violation, options);
    const key = groupKey(violation, definition.criterion, route);
    const existing = groups.get(key);

    if (existing === undefined) {
      groups.set(key, {
        seed: violation,
        violations: [violation],
        routes: new Set([violation.route]),
        route,
        criterion: definition.criterion,
      });
    } else {
      existing.violations.push(violation);
      existing.routes.add(violation.route);
    }
  }

  const tasks = [...groups.values()].map((group) => {
    const definition = getRuleDefinition(group.seed.ruleId);
    return FixTaskSchema.parse({
      id: taskId(group.seed, group.criterion, group.route),
      ruleId: group.seed.ruleId,
      criterion: group.criterion,
      kind: definition.kind,
      route: group.route,
      source: group.seed.source,
      routes: [...group.routes].sort(),
      violations: group.violations,
    });
  });

  return tasks.sort((left, right) => {
    const leftImpact = Math.min(
      ...left.violations.map((violation) => impactRank[violation.impact ?? ""] ?? 4),
    );
    const rightImpact = Math.min(
      ...right.violations.map((violation) => impactRank[violation.impact ?? ""] ?? 4),
    );
    if (leftImpact !== rightImpact) return leftImpact - rightImpact;
    return left.id.localeCompare(right.id);
  });
}

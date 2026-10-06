import { describe, expect, it } from "vitest";

import {
  AccesswrightConfigSchema,
  FixTaskSchema,
  PatchSchema,
  ViolationSchema,
} from "../../src/types/schemas.js";

describe("AccesswrightConfigSchema", () => {
  it("fills deterministic-mode defaults without requiring model configuration", () => {
    expect(AccesswrightConfigSchema.parse({})).toEqual({
      routes: [],
      ignore: { rules: [], paths: [] },
      scan: { mobile: true, darkScheme: false },
      offline: false,
    });
  });

  it("accepts bounded routes, ignores, scan conditions, budgets, and model choices", () => {
    expect(
      AccesswrightConfigSchema.parse({
        routes: ["/", "/posts/example"],
        ignore: { rules: ["image-alt"], paths: ["app/legacy/**"] },
        scan: { mobile: false, darkScheme: true },
        maxCostUsd: 3,
        model: {
          provider: "openai",
          id: "gpt-6-luna",
          reasoningEffort: "high",
        },
        escalationModel: {
          provider: "anthropic",
          id: "claude-example",
        },
        offline: true,
      }),
    ).toMatchObject({ maxCostUsd: 3, offline: true });
  });

  it("rejects unknown keys and invalid routes or budgets", () => {
    expect(() => AccesswrightConfigSchema.parse({ surprise: true })).toThrow();
    expect(() => AccesswrightConfigSchema.parse({ routes: ["relative"] })).toThrow();
    expect(() => AccesswrightConfigSchema.parse({ maxCostUsd: -1 })).toThrow();
  });
});

describe("ViolationSchema", () => {
  it("accepts a mapped axe violation", () => {
    expect(
      ViolationSchema.parse({
        ruleId: "aria-valid-attr",
        impact: "critical",
        route: "/",
        target: ["[aria-bogus]"],
        html: '<div aria-bogus="x"></div>',
        failureSummary: "invalid aria",
        source: { file: "app/page.tsx", line: 8, column: 7 },
      }),
    ).toMatchObject({ ruleId: "aria-valid-attr" });
  });

  it("rejects non-positive source coordinates", () => {
    expect(() =>
      ViolationSchema.parse({
        ruleId: "label",
        impact: "critical",
        route: "/",
        target: ["input"],
        html: "<input>",
        failureSummary: null,
        source: { file: "app/page.tsx", line: 0, column: 1 },
      }),
    ).toThrow();
  });
});

describe("FixTaskSchema", () => {
  it("requires a deterministic route value", () => {
    expect(() =>
      FixTaskSchema.parse({
        id: "task-1",
        ruleId: "aria-valid-attr",
        criterion: "4.1.2",
        kind: "syntactic",
        route: "magic",
        source: { file: "app/page.tsx", line: 8, column: 7 },
        routes: ["/"],
        violations: [],
      }),
    ).toThrow();
  });
});

describe("PatchSchema", () => {
  it("accepts source-only file changes", () => {
    expect(
      PatchSchema.parse({
        taskId: "task-1",
        changes: [
          {
            path: "app/page.tsx",
            before: '<div aria-bogus="x" />',
            after: "<div />",
          },
        ],
      }),
    ).toMatchObject({ taskId: "task-1" });
  });

  it("rejects manifest edits", () => {
    expect(() =>
      PatchSchema.parse({
        taskId: "task-1",
        changes: [{ path: "package.json", before: "{}", after: "{}" }],
      }),
    ).toThrow(/source file/i);
  });
});

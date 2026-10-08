import { expect, it } from "vitest";

import {
  planPullRequestSuggestions,
  parseRightSideChangedLines,
} from "../../src/reporter/pr-suggestions.js";

const group = {
  id: "fix-button",
  ruleId: "button-name",
  criterion: "4.1.2",
  perPatchAccepted: true as const,
  changes: [{
    path: "components/Button.tsx",
    before: [
      "export function Button() {",
      "  return (",
      '    <button aria-label="">Save</button>',
      "  );",
      "}",
      "",
    ].join("\n"),
    after: [
      "export function Button() {",
      "  return (",
      '    <button aria-label="Save">Save</button>',
      "  );",
      "}",
      "",
    ].join("\n"),
  }],
};

it("parses only right-side added or replaced lines from a GitHub patch", () => {
  const lines = parseRightSideChangedLines([
    "@@ -1,5 +1,5 @@",
    " export function Button() {",
    "   return (",
    '-    <button aria-label="">Save</button>',
    '+    <button aria-label="Save draft">Save</button>',
    "   );",
    " }",
  ].join("\n"));
  expect([...lines]).toEqual([3]);
});

it("creates a suggestion only when the verified replacement is fully inside the PR diff", () => {
  const plan = planPullRequestSuggestions({
    groups: [group],
    files: [{
      path: "components/Button.tsx",
      patch: [
        "@@ -1,5 +1,5 @@",
        " export function Button() {",
        "   return (",
        '-    <button aria-label="">Save</button>',
        '+    <button aria-label="Save draft">Save</button>',
        "   );",
        " }",
      ].join("\n"),
    }],
  });
  expect(plan.suggestions).toEqual([{
    fixId: "fix-button",
    path: "components/Button.tsx",
    startLine: 3,
    endLine: 3,
    replacement: '    <button aria-label="Save">Save</button>',
  }]);
  expect(plan.cliHandoffs).toEqual([]);
});

it("keeps verified fixes outside the PR diff as CLI handoffs instead of broadening review writes", () => {
  const plan = planPullRequestSuggestions({
    groups: [group],
    files: [{
      path: "components/Button.tsx",
      patch: [
        "@@ -1,1 +1,1 @@",
        "-export function Button() {",
        "+export function Button(props) {",
      ].join("\n"),
    }],
  });
  expect(plan.suggestions).toEqual([]);
  expect(plan.cliHandoffs).toEqual([{
    fixId: "fix-button",
    path: "components/Button.tsx",
    reason: "verified-change-outside-pr-diff",
  }]);
});

it("fails closed on multi-file or insertion-only suggestions that cannot be anchored exactly", () => {
  const insertion = {
    ...group,
    changes: [{
      ...group.changes[0],
      after: group.changes[0].before.replace(
        "  return (",
        '  const label = "Save";\n  return (',
      ),
    }],
  };
  const plan = planPullRequestSuggestions({
    groups: [insertion],
    files: [{
      path: "components/Button.tsx",
      patch: [
        "@@ -1,2 +1,3 @@",
        " export function Button() {",
        '+  const draft = "x";',
        "   return (",
      ].join("\n"),
    }],
  });
  expect(plan.suggestions).toEqual([]);
  expect(plan.cliHandoffs[0]?.reason).toMatch(/anchor|outside|shape/);
});

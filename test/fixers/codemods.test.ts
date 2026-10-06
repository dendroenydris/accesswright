import { describe, expect, it } from "vitest";

import { applyCodemod } from "../../src/fixers/codemods/index.js";
import type { FixTask, Violation } from "../../src/types/schemas.js";

function task(
  ruleId: string,
  source: NonNullable<Violation["source"]>,
  html: string,
): FixTask {
  return {
    id: `codemod:test:${ruleId}`,
    ruleId,
    criterion: ruleId === "tabindex" ? "2.4.3" : "4.1.2",
    kind: "syntactic",
    route: "codemod",
    source,
    routes: ["/"],
    violations: [
      {
        ruleId,
        impact: "critical",
        route: "/",
        target: ["div"],
        html,
        failureSummary: "fixture",
        source,
      },
    ],
  };
}

describe("applyCodemod aria-valid-attr", () => {
  const source = `export default function Page() {
  return (
    <main>
      <div aria-label="kept" aria-bogus="remove-me">Hello</div>
    </main>
  );
}
`;

  it("removes invalid ARIA attributes and preserves valid ones", () => {
    const patch = applyCodemod(
      source,
      task(
        "aria-valid-attr",
        { file: "app/page.tsx", line: 4, column: 7 },
        '<div aria-label="kept" aria-bogus="remove-me">Hello</div>',
      ),
    );

    expect(patch).not.toBeNull();
    expect(patch?.changes[0]?.after).toContain('aria-label="kept"');
    expect(patch?.changes[0]?.after).not.toContain("aria-bogus");
  });

  it("is idempotent after the invalid attribute is gone", () => {
    const first = applyCodemod(
      source,
      task(
        "aria-valid-attr",
        { file: "app/page.tsx", line: 4, column: 7 },
        '<div aria-label="kept" aria-bogus="remove-me">Hello</div>',
      ),
    );
    expect(first).not.toBeNull();

    const second = applyCodemod(
      first?.changes[0]?.after ?? "",
      task(
        "aria-valid-attr",
        { file: "app/page.tsx", line: 4, column: 7 },
        '<div aria-label="kept">Hello</div>',
      ),
    );
    expect(second).toBeNull();
  });
});

describe("applyCodemod tabindex", () => {
  it("normalizes a positive literal tabIndex to zero", () => {
    const source = `export const X = () => (
  <button tabIndex={3}>Open</button>
);
`;
    const patch = applyCodemod(
      source,
      task(
        "tabindex",
        { file: "components/X.tsx", line: 2, column: 3 },
        '<button tabindex="3">Open</button>',
      ),
    );

    expect(patch?.changes[0]?.after).toContain("tabIndex={0}");
  });

  it("does not guess when tabIndex is computed", () => {
    const source = `export const X = ({ priority }: { priority: number }) => (
  <button tabIndex={priority}>Open</button>
);
`;

    expect(
      applyCodemod(
        source,
        task(
          "tabindex",
          { file: "components/X.tsx", line: 2, column: 3 },
          '<button tabindex="3">Open</button>',
        ),
      ),
    ).toBeNull();
  });

  it("returns null when the source coordinate does not identify the JSX element", () => {
    const source = `export const X = () => <button tabIndex={3}>Open</button>;
`;
    expect(
      applyCodemod(
        source,
        task(
          "tabindex",
          { file: "components/X.tsx", line: 99, column: 1 },
          '<button tabindex="3">Open</button>',
        ),
      ),
    ).toBeNull();
  });
});

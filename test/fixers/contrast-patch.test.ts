import { describe, expect, it } from "vitest";

import { applyInlineContrastFix } from "../../src/fixers/contrast-patch.js";
import type { FixTask, Violation } from "../../src/types/schemas.js";

function contrastTask(): FixTask {
  const source = { file: "app/page.tsx", line: 3, column: 5 };
  const item: Violation = {
    ruleId: "color-contrast",
    impact: "serious",
    route: "/",
    target: ["p"],
    html: '<p style="color:#aaa;background-color:#fff">Low contrast</p>',
    failureSummary: "contrast",
    source,
  };
  return {
    id: "optimizer:1.4.3:color-contrast:app/page.tsx:3:5",
    ruleId: "color-contrast",
    criterion: "1.4.3",
    kind: "layout",
    route: "optimizer",
    source,
    routes: ["/"],
    violations: [item],
  };
}

describe("applyInlineContrastFix", () => {
  it("rewrites an inline literal foreground to the closest passing color", () => {
    const sourceText = `export default function Page() {
  return (
    <p style={{ color: "#aaa", backgroundColor: "#fff" }}>Low contrast</p>
  );
}
`;

    const patch = applyInlineContrastFix(sourceText, contrastTask());

    expect(patch).not.toBeNull();
    expect(patch?.changes[0]?.after).not.toContain('color: "#aaa"');
    expect(patch?.changes[0]?.after).toContain('backgroundColor: "#fff"');
  });

  it("is idempotent once the rewritten literal passes", () => {
    const sourceText = `export default function Page() {
  return (
    <p style={{ color: "#aaa", backgroundColor: "#fff" }}>Low contrast</p>
  );
}
`;
    const first = applyInlineContrastFix(sourceText, contrastTask());
    expect(first).not.toBeNull();

    const second = applyInlineContrastFix(
      first?.changes[0]?.after ?? "",
      contrastTask(),
    );
    expect(second).toBeNull();
  });

  it("does not rewrite shared or computed design tokens", () => {
    const sourceText = `export default function Page() {
  return (
    <p style={{ color: theme.text, backgroundColor: "#fff" }}>Text</p>
  );
}
`;

    expect(applyInlineContrastFix(sourceText, contrastTask())).toBeNull();
  });

  it("does not guess a background when it is not an inline literal", () => {
    const sourceText = `export default function Page() {
  return (
    <p style={{ color: "#aaa" }}>Text</p>
  );
}
`;

    expect(applyInlineContrastFix(sourceText, contrastTask())).toBeNull();
  });
});

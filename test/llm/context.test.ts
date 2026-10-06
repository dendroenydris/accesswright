import { describe, expect, it } from "vitest";

import {
  buildRepairContext,
  findComponentCallSites,
} from "../../src/llm/context.js";

describe("findComponentCallSites", () => {
  it("finds JSX call sites across files in stable file/line order", () => {
    const result = findComponentCallSites(
      {
        "app/a/page.tsx": `export function A() {
  return <Avatar name="A" />;
}
`,
        "app/b/page.tsx": `export function B() {
  return (
    <div>
      <Avatar name="B" />
    </div>
  );
}
`,
        "components/Other.tsx": "export const Other = () => <span />;\n",
      },
      "Avatar",
    );

    expect(result.map((item) => [item.file, item.line, item.column])).toEqual([
      ["app/a/page.tsx", 2, 10],
      ["app/b/page.tsx", 4, 7],
    ]);
    expect(result[0]?.source).toContain('<Avatar name="A" />');
  });

  it("does not confuse similarly named components", () => {
    expect(
      findComponentCallSites(
        {
          "app/page.tsx": "export default () => <AvatarGroup />;\n",
        },
        "Avatar",
      ),
    ).toEqual([]);
  });
});

describe("buildRepairContext", () => {
  it("builds a bounded stable context around the mapped source line", () => {
    const lines = Array.from(
      { length: 200 },
      (_, index) => `const line${index + 1} = ${index + 1};`,
    ).join("\n");

    const context = buildRepairContext({
      source: {
        file: "components/Avatar.tsx",
        line: 100,
        column: 1,
        text: lines,
      },
      callSites: [
        {
          file: "app/z/page.tsx",
          line: 8,
          column: 3,
          source: '<Avatar name="Z" />',
        },
        {
          file: "app/a/page.tsx",
          line: 4,
          column: 3,
          source: '<Avatar name="A" />',
        },
      ],
      page: {
        title: "People",
        surroundingText: "Team members",
        caption: null,
        linkTarget: "/people/alice",
      },
      screenshotPath: "/tmp/crop.png",
    });

    expect(context.component.file).toBe("components/Avatar.tsx");
    expect(context.component.sourceExcerpt).toContain("const line100");
    expect(context.component.sourceExcerpt.length).toBeLessThanOrEqual(8_000);
    expect(context.callSites.map((item) => item.file)).toEqual([
      "app/a/page.tsx",
      "app/z/page.tsx",
    ]);
    expect(context.page.linkTarget).toBe("/people/alice");
    expect(context.screenshotPath).toBe("/tmp/crop.png");
  });

  it("truncates oversized page text rather than growing the prompt without bound", () => {
    const context = buildRepairContext({
      source: {
        file: "app/page.tsx",
        line: 1,
        column: 1,
        text: "export default () => <img />;\n",
      },
      callSites: [],
      page: {
        title: "Page",
        surroundingText: "x".repeat(20_000),
        caption: null,
        linkTarget: null,
      },
      screenshotPath: null,
    });

    expect(context.page.surroundingText.length).toBeLessThanOrEqual(4_000);
  });
});

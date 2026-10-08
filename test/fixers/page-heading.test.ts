import { expect, it } from "vitest";

import { applyHeadingOrderFix } from "../../src/fixers/page-heading.js";
import type { BrowserObservation } from "../../src/scanner/observations.js";
import type { FixTask, Violation } from "../../src/types/schemas.js";

const sourceText = `export default function Page() {
  return (
    <>
      <h1 id="title">Title</h1>
      <h4 id="detail">Detail</h4>
    </>
  );
}
`;

const violation: Violation = {
  ruleId: "heading-order",
  impact: "moderate",
  route: "/",
  target: ["#detail"],
  html: '<h4 id="detail">Detail</h4>',
  failureSummary: "Heading levels should only increase by one",
  condition: "desktop-light",
  source: { file: "app/page.tsx", line: 5, column: 7 },
};

const task: FixTask = {
  id: "codemod:1.3.1:heading-order:app/page.tsx:5:7",
  ruleId: "heading-order",
  criterion: "1.3.1",
  kind: "global",
  route: "codemod",
  source: violation.source,
  routes: ["/"],
  violations: [violation],
};

function observation(mapping: "direct" | "ancestor" = "direct"): BrowserObservation {
  return {
    route: "/",
    condition: "desktop-light",
    checkerVersion: "fixture",
    documentLanguage: "en",
    documentTitle: "Fixture",
    sourceIndex: [],
    violations: [violation],
    incomplete: [],
    aria: [
      { id: "/|desktop-light|#title", role: "heading", name: "Title", text: "Title", interactive: false, headingLevel: 1 },
      { id: "/|desktop-light|#detail", role: "heading", name: "Detail", text: "Detail", interactive: false, headingLevel: 4 },
    ],
    ariaTree: "",
    probeFailures: [],
    probeUnavailable: [],
    contexts: [{
      nodeId: "/|desktop-light|#detail",
      target: ["#detail"],
      source: violation.source,
      mapping,
      pageTitle: "Fixture",
      surroundingText: "Detail",
      imageCaption: null,
      linkTarget: null,
      screenshot: null,
      foreground: "rgb(0, 0, 0)",
      background: "rgb(255, 255, 255)",
      contrastTarget: 4.5,
      palette: [],
    }],
    screenshot: "fixture-page.png",
    darkMediaDetected: false,
    sourceFiles: ["app/page.tsx"],
  };
}

it("uses the rendered cross-component outline to repair a skipped native heading level", () => {
  const decision = applyHeadingOrderFix(sourceText, task, [observation()]);
  expect(decision.reason).toBeNull();
  expect(decision.patch?.changes[0]?.after).toContain('<h2 id="detail">Detail</h2>');
  expect(decision.patch?.changes[0]?.after).toContain('<h1 id="title">Title</h1>');
});

it("does not rewrite an ancestor-mapped or semantically ambiguous heading", () => {
  expect(applyHeadingOrderFix(sourceText, task, [observation("ancestor")])).toMatchObject({
    patch: null,
    reason: "heading-source-is-not-direct",
  });
});

it("does not invent a heading level without a previous rendered heading", () => {
  const page = observation();
  page.aria = page.aria.slice(1);
  expect(applyHeadingOrderFix(sourceText, task, [page])).toMatchObject({
    patch: null,
    reason: "no-previous-rendered-heading",
  });
});

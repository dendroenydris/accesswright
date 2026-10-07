import { expect, it } from "vitest";
import { applyRenderedContrastFix } from "../../src/fixers/runtime-contrast.js";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";
import { planFixTasks } from "../../src/planner/planner.js";
import { contrastRatio } from "../../src/fixers/contrast.js";

function fixture(source: string, palette = [{ className: "text-gray-400", color: "#aaaaaa" }, { className: "text-gray-700", color: "#374151" }, { className: "text-black", color: "#000000" }]) {
  const location = { file: "app/page.tsx", line: 1, column: source.indexOf("<p") + 1 };
  const violation = { ruleId: "color-contrast", impact: "serious", route: "/", target: ["#target"], html: "<p id='target'>Readable text</p>", failureSummary: "Low contrast", source: location, condition: "desktop-light" as const };
  const observation = BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", violations: [violation], incomplete: [], aria: [], ariaTree: "", probeFailures: [], probeUnavailable: [], screenshot: "page.png", darkMediaDetected: false,
    contexts: [{ target: ["#target"], source: location, mapping: "direct", pageTitle: "Fixture", surroundingText: "Readable text", imageCaption: null, linkTarget: null, screenshot: "crop.png", foreground: "#aaaaaa", background: "#ffffff", contrastTarget: 4.5, palette }] });
  const task = planFixTasks([violation])[0];
  if (!task) throw new Error("Mapped contrast fixture task required");
  return { task, observations: [observation] };
}

it("snaps a local static Tailwind class to the closest observed passing runtime color", () => {
  const source = 'export default function Page() { return <p id="target" className="text-gray-400 p-4">Readable text</p>; }';
  const { task, observations } = fixture(source);
  const result = applyRenderedContrastFix(source, task, observations);
  expect(result.patch?.changes[0]?.after).toContain('className="text-gray-700 p-4"');
  expect(result.patch?.changes[0]?.after).toContain("Readable text");
  expect(result.reason).toBeNull();
});

it("retains palette class identity through browser Lab-to-hex quantization", () => {
  const source = 'export default function Page() { return <p id="target" className="text-gray-400">Readable text</p>; }';
  const { task, observations } = fixture(source, [
    { className: "text-gray-400", color: "lab(65.9269 -0.832707 -8.17473)" },
    { className: "text-gray-700", color: "lab(27.1134 -0.956401 -12.3224)" },
  ]);
  observations[0].contexts[0].foreground = "lab(65.9269 -0.832707 -8.17473)";
  expect(applyRenderedContrastFix(source, task, observations).patch?.changes[0]?.after).toContain('className="text-gray-700"');
});

it("uses actual inherited background and the measured large-text threshold for a local color literal", () => {
  const source = 'export default function Page() { return <p id="target" style={{ color: "#aaaaaa" }}>Readable text</p>; }';
  const { task, observations } = fixture(source);
  observations[0].contexts[0].contrastTarget = 3;
  const result = applyRenderedContrastFix(source, task, observations);
  const color = /color: "([^"]+)"/.exec(result.patch?.changes[0]?.after ?? "")?.[1];
  expect(color).toBeDefined();
  expect(contrastRatio(color ?? "#fff", "#fff")).toBeGreaterThanOrEqual(3);
});

it("proposes a shared-token change but never rewrites the token or substitutes an arbitrary local override", () => {
  const source = 'export default function Page() { return <p id="target" style={{ color: "var(--brand-muted)" }}>Readable text</p>; }';
  const { task, observations } = fixture(source);
  const result = applyRenderedContrastFix(source, task, observations);
  expect(result.patch).toBeNull();
  expect(result.reason).toContain("shared-token:--brand-muted");
  expect(result.reason).toContain("proposed=");
  expect(result.reason).toContain("deltaE2000=");
});

it("does not invent unavailable Tailwind classes, colors, or ambiguous component overrides", () => {
  const source = 'export default function Page() { return <p id="target" className="text-gray-400">Readable text</p>; }';
  const { task, observations } = fixture(source, [{ className: "text-gray-400", color: "#aaaaaa" }]);
  expect(applyRenderedContrastFix(source, task, observations).patch).toBeNull();
  observations[0].contexts[0].background = null;
  expect(applyRenderedContrastFix(source, task, observations).reason).toMatch(/background/);
  observations[0].contexts[0].background = "#ffffff";
  observations[0].contexts[0].mapping = "ancestor";
  expect(applyRenderedContrastFix(source, task, observations).patch).toBeNull();
});

it("leaves dynamic and multi-condition class expressions for review instead of broad AST replacement", () => {
  for (const classAttribute of ['className={theme}', 'className="text-gray-400 dark:text-gray-700"']) {
    const source = `export default function Page() { return <p id="target" ${classAttribute}>Readable text</p>; }`;
    const { task, observations } = fixture(source);
    expect(applyRenderedContrastFix(source, task, observations).patch).toBeNull();
  }
});

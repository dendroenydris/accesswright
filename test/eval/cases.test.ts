import { expect, it } from "vitest";
import type { Violation } from "../../src/types/schemas.js";
import { generateMutations } from "../../src/eval/operators.js";
import { freezeRenderedCases, scoreCases, injectedTargets } from "../../src/eval/cases.js";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";

const source = 'export default function Page(){ return <button id="save" aria-label="Save changes"><svg aria-hidden="true" /></button>; }';
const mutation = generateMutations("app/page.tsx", source).find(item => item.operator === "remove-button-name");
if (!mutation) throw new Error("Missing test operator");
const page = BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", violations: [], incomplete: [], aria: [{ id: "/|desktop-light|#save", role: "button", name: "Save changes", text: "", interactive: true }], ariaTree: "", probeFailures: [], probeUnavailable: [], contexts: [], screenshot: "page.png", darkMediaDetected: false, sourceFiles: ["app/page.tsx"], sourceIndex: [{ nodeId: "/|desktop-light|#save", target: ["#save"], source: mutation.source, tagName: "button", mapping: "direct" }] });
const violation: Violation = { ruleId: "button-name", route: "/", condition: "desktop-light", target: ["#save"], source: mutation.source, impact: "critical", html: "<button/>", failureSummary: null };

it("freezes actual rendered names rather than treating model output as semantic truth", () => {
  const frozen = freezeRenderedCases([mutation], [page]);
  expect(frozen.eligible).toHaveLength(1);
  const bad = { ...page, aria: page.aria.map(node => ({ ...node, name: "Wrong action" })) };
  expect(scoreCases(frozen.eligible, [bad], true)[0]).toMatchObject({ checkerAccepted: true, semanticallyCorrect: false, correctlyFixed: false });
  expect(scoreCases(frozen.eligible, [page], true)[0]).toMatchObject({ correctlyFixed: true });
});
it("requires the mutation to cause an actual checker finding before counting a scored case", () => {
  const frozen = freezeRenderedCases([mutation], [page]).eligible;
  expect(injectedTargets(frozen, [page]).eligible).toHaveLength(0);
  const broken = { ...page, violations: [violation], contexts: [{ target: ["#save"], source: mutation.source, mapping: "direct" as const, pageTitle: "Test", surroundingText: "", imageCaption: null, linkTarget: null, screenshot: null, nodeId: "/|desktop-light|#save", foreground: "#000000", background: "#ffffff", contrastTarget: 4.5, palette: [] }] };
  expect(injectedTargets(frozen, [broken]).eligible).toHaveLength(1);
});
it("does not count hidden, missing or inconclusive targets as corrected", () => {
  const frozen = freezeRenderedCases([mutation], [page]).eligible;
  expect(scoreCases(frozen, [], true)[0]?.correctlyFixed).toBe(false);
  expect(scoreCases(frozen, [{ ...page, incomplete: [violation] }], true)[0]?.correctlyFixed).toBe(false);
  expect(scoreCases(frozen, [{ ...page, aria: [] }], true)[0]?.correctlyFixed).toBe(false);
});
it("excludes unmapped and originally violating controls before looking at repair outcomes", () => {
  expect(freezeRenderedCases([mutation], [{ ...page, sourceIndex: [] }]).eligible).toEqual([]);
  const broken = { ...page, violations: [violation], contexts: [{ target: ["#save"], source: mutation.source, mapping: "direct" as const, pageTitle: "Test", surroundingText: "", imageCaption: null, linkTarget: null, screenshot: null, nodeId: "/|desktop-light|#save", foreground: "#000000", background: "#ffffff", contrastTarget: 4.5, palette: [] }] };
  expect(freezeRenderedCases([mutation], [broken]).eligible).toEqual([]);
});

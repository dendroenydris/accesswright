import { expect, it } from "vitest";
import { normalizeSourceIndex } from "../../src/scanner/source-index.js";

const raw = { nodeId: "/|desktop-light|#save", selector: "#save", tagName: "button", visible: true, annotations: [{ path: "/workspace/components/Button.tsx:3:7:button", row: null, column: null, depth: 0 }] };
it("indexes a clean rendered node to the same stable identity used by the accessibility facts", () => {
  expect(normalizeSourceIndex([raw])).toEqual([{ nodeId: raw.nodeId, target: ["#save"], tagName: "button", mapping: "direct", source: { file: "components/Button.tsx", line: 3, column: 7 } }]);
});
it("selects a project call site rather than proposing edits inside a third-party package", () => {
  const entries = normalizeSourceIndex([{ ...raw, annotations: [{ ...raw.annotations[0], path: "/workspace/node_modules/ui/Button.js:1:1:button" }, { ...raw.annotations[0], path: "/workspace/app/page.tsx:9:3:section", depth: 1 }] }]);
  expect(entries[0]).toMatchObject({ mapping: "ancestor", source: { file: "app/page.tsx", line: 9, column: 3 } });
});
it("never indexes hidden nodes or untrusted paths outside editable source", () => {
  expect(normalizeSourceIndex([{ ...raw, visible: false }, { ...raw, annotations: [{ ...raw.annotations[0], path: "/private/secret.ts:1:1:div" }] }, { ...raw, annotations: [{ ...raw.annotations[0], path: "/workspace/../secret.ts:1:1:div" }] }])).toEqual([]);
});
it("supports split inspector metadata without serializing the source HTML", () => {
  expect(normalizeSourceIndex([{ ...raw, annotations: [{ path: "app/page.tsx", row: "2", column: "4", depth: 0 }] }])[0]?.source).toEqual({ file: "app/page.tsx", line: 2, column: 4 });
});

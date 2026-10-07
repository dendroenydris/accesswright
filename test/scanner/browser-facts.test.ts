import { describe, expect, it } from "vitest";
import { mergeBrowserFacts, scanConditions, violationKey } from "../../src/scanner/browser-facts.js";
import type { BrowserDomFact } from "../../src/scanner/browser-facts.js";

function dom(overrides: Partial<BrowserDomFact> = {}): BrowserDomFact {
  return { marker: "n1", id: "/|desktop-light|#save", text: "", visible: true, ariaHidden: false, nativeInteractive: true, disabled: false, protectedContent: false, ...overrides };
}
describe("browser-derived accessibility facts", () => {
  it("uses the browser's computed name, role and focusability, not HTML guesses", () => {
    const facts = mergeBrowserFacts([dom()], { n1: { ignored: false, role: "button", name: "Save changes", focusable: true } });
    expect(facts).toEqual([{ id: "/|desktop-light|#save", role: "button", name: "Save changes", text: "", interactive: true, protectedContent: false }]);
  });
  it("does not hide visible generic text merely because the AX node is ignored", () => {
    const facts = mergeBrowserFacts([dom({ nativeInteractive: false, text: "Important" })], { n1: { ignored: true, role: "none", name: "", focusable: false } });
    expect(facts[0]).toMatchObject({ text: "Important", role: "generic", interactive: false });
  });
  it.each([{ visible: false }, { ariaHidden: true }])("keeps hidden content out of the after tree: %j", (overrides) => {
    expect(mergeBrowserFacts([dom(overrides)], {})).toEqual([]);
  });
  it("tracks disabled controls and conservatively protects unnamed informative images", () => {
    const facts = mergeBrowserFacts([dom({ disabled: true, protectedContent: true })], {});
    expect(facts[0]).toMatchObject({ interactive: false, protectedContent: true });
  });
  it("preserves actual heading levels", () => {
    expect(mergeBrowserFacts([dom({ nativeInteractive: false })], { n1: { ignored: false, role: "heading", name: "Title", focusable: false, headingLevel: 3 } })[0]).toMatchObject({ headingLevel: 3 });
  });
  it("distinguishes desktop, mobile and dark instances without breaking old records", () => {
    const item = { ruleId: "target-size", route: "/", target: ["#button"] };
    expect(violationKey(item)).not.toBe(violationKey({ ...item, condition: "mobile-light" }));
    expect(scanConditions({ mobile: true, darkScheme: true })).toEqual(["desktop-light", "mobile-light", "desktop-dark"]);
    expect(scanConditions({ mobile: false, darkScheme: false })).toEqual(["desktop-light"]);
  });
});

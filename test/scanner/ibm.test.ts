import { expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { defaults } from "../../src/config.js";
import { mergeCheckerFindings, normalizeIbmResults, scanIbmPage } from "../../src/scanner/ibm.js";

const issue = { ruleId: "img_alt_valid", reasonId: "fail_no_alt", value: ["VIOLATION", "FAIL"], target: ["#logo"], snippet: "<img>", message: "Missing name" };
const report = (results: unknown[]) => ({ numExecuted: 3, results });
const finding = normalizeIbmResults("/", "desktop-light", report([issue])).violations[0];

it("maps reviewed equivalent rules and retains broader/unknown IBM failures for human review", () => {
  const result = normalizeIbmResults("/", "desktop-dark", report([issue, { ...issue, ruleId: "page_title_exists" },
    { ...issue, ruleId: "html_lang_exists", reasonId: "Fail_3" }, { ...issue, ruleId: "html_lang_exists", reasonId: "Fail_4" },
    { ...issue, ruleId: "aria_attribute_exists" }]));
  expect(result.violations.map(item => item.ruleId)).toEqual(["image-alt", "document-title", "html-has-lang", "ibm-html-lang-exists", "ibm-aria-attribute-exists"]);
  expect(result.violations.every(item => item.condition === "desktop-dark" && item.impact === null && item.source === null)).toBe(true);
});

it("separates potential/manual/recommendation results and never counts passes as findings", () => {
  const result = normalizeIbmResults("/", "desktop-light", report([issue,
    { ...issue, value: ["VIOLATION", "POTENTIAL"] }, { ...issue, value: ["VIOLATION", "MANUAL"] },
    { ...issue, value: ["RECOMMENDATION", "FAIL"] }, { ...issue, value: ["INFORMATION", "FAIL"] }, { ...issue, value: ["VIOLATION", "PASS"] }]));
  expect(result.violations).toHaveLength(1);expect(result.incomplete).toHaveLength(4);
});

it("deduplicates cross-checker occurrences with max multiplicity and preserves original axe objects", () => {
  if (!finding) throw new Error("Fixture finding missing");
  const axe = [finding, finding], second = { ...finding, html: "Different engine snippet" };
  const original = JSON.stringify(axe);
  expect(mergeCheckerFindings(axe, [second])).toEqual(axe);
  expect(mergeCheckerFindings([finding], [second, second])).toHaveLength(2);
  expect(mergeCheckerFindings(axe, [second, second, second])).toHaveLength(3);
  expect(mergeCheckerFindings(axe, [{ ...second, target: ["#another"] }, { ...second, condition: "mobile-light" }])).toHaveLength(4);
  expect(mergeCheckerFindings([], [second, second])).toHaveLength(2);
  expect(JSON.stringify(axe)).toBe(original);expect(mergeCheckerFindings(axe, [second])[0]).toBe(finding);
});

it.each([
  { numExecuted: 0, results: [] }, { results: [{}] }, { results: [{ ...issue, value: ["VIOLATION", "unknown"] }] },
  { results: [{ ...issue, target: [] }] }, { results: [{ ...issue, ruleId: "arbitrary/private" }] },
])("fails closed on malformed or empty engine runs %j", extra => { expect(() => normalizeIbmResults("/", "desktop-light", { ...report([]), ...extra })).toThrow(); });

it("bounds result arrays rather than silently truncating the second checker", () => {
  expect(() => normalizeIbmResults("/", "desktop-light", report(Array.from({ length: defaults.secondCheckerMaxResults + 1 }, () => issue)))).toThrow();
});

it("uses the pinned local engine and exact DOM identity for dedup without leaking raw DOM nodes", async () => {
  const logo = {}, other = {}, html = {};
  class FakeDocument {
    documentElement = html;
    querySelector(selector: string) { if (selector === "#logo") return logo; if (selector === "bad[") throw new Error("Invalid selector"); return null; }
  }
  const document = new FakeDocument();
  const check = vi.fn<() => Promise<unknown>>().mockResolvedValue({ numExecuted: 4, results: [
    { ...issue, target: undefined, node: logo, path: { dom: "/html/body/img[1]" } },
    { ...issue, target: undefined, node: other, path: { dom: "/html/body/img[2]" } },
    { ...issue, target: undefined, node: document, ruleId: "page_title_exists", path: { dom: "/html" } },
    { ...issue, target: undefined, node: null, value: ["VIOLATION", "PASS"], path: {} },
  ] });
  vi.stubGlobal("Document", FakeDocument);vi.stubGlobal("document", document);
  vi.stubGlobal("ace", { Checker: class { check = check; } });
  const page = { addScriptTag: vi.fn<(options: { path: string }) => Promise<void>>().mockResolvedValue(undefined),
    evaluate: vi.fn(async (fn: (args: unknown) => Promise<unknown>, args: unknown) => await fn(args)) };
  try {
    const result = await scanIbmPage(page as unknown as Page, "/", "desktop-light", finding ? [finding] : []);
    expect(result.version).toBe("4.0.34");expect(check).toHaveBeenCalledWith(document, ["IBM_Accessibility"]);
    expect(page.addScriptTag.mock.calls[0]?.[0].path).toContain("accessibility-checker-engine/ace.js");
    expect(result.violations.map(item => item.target)).toEqual([["#logo"], ["xpath=/html/body/img[2]"], ["xpath=/html"]]);
    expect(result.violations).toHaveLength(3);expect(JSON.stringify(result)).not.toContain('"node"');
    check.mockRejectedValueOnce(new Error("Engine failed"));await expect(scanIbmPage(page as unknown as Page, "/", "desktop-light", [])).rejects.toThrow("Engine failed");
    check.mockResolvedValueOnce({ numExecuted: 1, results: [{ ...issue, node: other, path: {} }] });
    await expect(scanIbmPage(page as unknown as Page, "/", "desktop-light", [])).rejects.toThrow(/identity/);
  } finally { vi.unstubAllGlobals(); }
});

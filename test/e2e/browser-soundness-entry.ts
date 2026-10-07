import { readdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { scanBrowserPage } from "../../src/scanner/browser-scan.js";
import { observationsToState } from "../../src/scanner/observations.js";
import { verifyPerPatch } from "../../src/verifier/per-patch.js";
import { getRuleDefinition } from "../../src/planner/rules.js";
import type { FixTask } from "../../src/types/schemas.js";

const chart = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="white"/><path d="M5 50 L30 35 L60 25 L90 5" stroke="blue" fill="none"/></svg>')}`;
const content = `<h1 id="title">Fixture</h1><button id="target" aria-bogus="x">Save</button><p id="content">Important information</p><img id="chart" alt="Revenue rises" src="${chart}" width="100" height="60"><a id="help" href="/help">Help</a>`;
const css = "body{color:#000;background:#fff;font-family:Arial,sans-serif}button,a{color:#000;background:#fff;padding:16px;display:inline-block}button{border:1px solid #000;box-shadow:none}button:focus-visible,a:focus-visible{outline:2px solid blue;outline-offset:2px}";
function html(body: string, extra = "") { return `<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verifier fixture</title><style>${css}${extra}</style></head><body><main>${body}</main></body></html>`; }
const repaired = content.replace(' aria-bogus="x"', "");
const cases = [
  { name: "delete-visible", expected: false, rule: "aria-valid-attr", before: html(content), after: html(repaired.replace('<p id="content">Important information</p>', "")) },
  { name: "aria-hide-visible", expected: false, rule: "aria-valid-attr", before: html(content), after: html(repaired.replace('id="content"', 'id="content" aria-hidden="true"')) },
  // The author stylesheet sets display:inline-block, which overrides the user-agent hidden rule.
  // Set display:none explicitly and assert the rendered precondition instead of relabeling a visible control as hidden.
  { name: "hide-focusable", expected: false, rule: "aria-valid-attr", before: html(content), after: html(repaired.replace('id="target"', 'id="target" style="display:none"')) },
  { name: "display-none", expected: false, rule: "aria-valid-attr", before: html(content), after: html(repaired, "main{display:none}") },
  { name: "remove-focus-outline", expected: false, rule: "aria-valid-attr", before: html(content), after: html(repaired, "#target:focus-visible{outline:none}") },
  { name: "hover-contrast-regression", expected: false, rule: "aria-valid-attr", before: html(content), after: html(repaired, "#help:hover{color:#eee}") },
  { name: "empty-informative-alt", expected: false, rule: "aria-valid-attr", before: html(content), after: html(repaired.replace('alt="Revenue rises"', 'alt=""')) },
  { name: "invalid-role", expected: false, rule: "aria-valid-attr", before: html(content), after: html(repaired.replace('id="target"', 'id="target" role="not-a-real-role"')) },
  { name: "decorative-icon", expected: true, rule: "aria-valid-attr", before: html(content+'<span id="icon" role="img" style="display:inline-block;width:8px;height:8px"></span>'), after: html(repaired+'<span id="icon" role="img" aria-hidden="true" style="display:inline-block;width:8px;height:8px"></span>') },
  { name: "redundant-landmark", expected: true, rule: "landmark-unique", before: html('<h1 id="title">Navigation</h1><nav id="one"><a id="a" href="/a">A</a></nav><nav id="two"><a id="b" href="/b">B</a></nav>'), after: html('<h1 id="title">Navigation</h1><nav id="one"><a id="a" href="/a">A</a></nav><div id="two"><a id="b" href="/b">B</a></div>') },
  { name: "heading-level", expected: true, rule: "heading-order", before: html('<h1 id="title">Document</h1><h2 id="section">Section</h2><h4 id="subsection">Subsection</h4>'), after: html('<h1 id="title">Document</h1><h2 id="section">Section</h2><h3 id="subsection">Subsection</h3>') },
  { name: "semantic-button-name", expected: true, rule: "button-name", before: html('<h1 id="title">Editor</h1><p id="hint">Save changes</p><button id="target"></button>'), after: html('<h1 id="title">Editor</h1><p id="hint">Save changes</p><button id="target" aria-label="Save changes"></button>') },
];

const browser = await chromium.launch({ headless: true });
const results: Array<{ name: string; expected: boolean; accepted: boolean; check: string; reason: string | null; beforeFacts: number; afterFacts: number }> = [];
try {
  for (const [index, sample] of cases.entries()) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
    const page = await context.newPage();
    try {
      await page.setContent(sample.before, { waitUntil: "load" });
      const before = await scanBrowserPage(page, { route: "/", condition: "desktop-light", generation: `case-${index}-before`, evidenceDir: "/evidence" });
      const targets = before.violations.filter(violation => violation.ruleId === sample.rule);
      if (targets.length === 0) throw new Error(`Fixture did not contain its declared target: ${sample.name} (${before.violations.map(item => item.ruleId).join(",")})`);
      await page.setContent(sample.after, { waitUntil: "load" });
      if (sample.name === "hide-focusable" && await page.locator("#target").isVisible()) {
        throw new Error("Invalid harmful fixture: the control must actually be hidden in the rendered page");
      }
      const after = await scanBrowserPage(page, { route: "/", condition: "desktop-light", generation: `case-${index}-after`, evidenceDir: "/evidence" });
      const task: FixTask = { id: sample.name, ruleId: sample.rule, criterion: getRuleDefinition(sample.rule).criterion, kind: "human", route: "human", source: null, routes: ["/"], violations: targets };
      const result = verifyPerPatch({ task, before: observationsToState([before]), after: observationsToState([after]) });
      results.push({ name: sample.name, expected: sample.expected, ...result, beforeFacts: before.aria.length, afterFacts: after.aria.length });
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
const report = {
  kind: "real-browser-verifier-soundness", provider: "none", results,
  harmfulRejected: results.filter(item => !item.expected && !item.accepted).length,
  legitimateAccepted: results.filter(item => item.expected && item.accepted).length,
  failures: results.filter(item => item.expected !== item.accepted).map(item => item.name),
  screenshots: (await readdir("/evidence")).filter(name => name.endsWith(".png")).length,
};
await writeFile("/evidence/report.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (report.failures.length > 0) process.exitCode = 1;

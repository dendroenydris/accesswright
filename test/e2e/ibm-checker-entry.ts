import assert from "node:assert/strict";
import { chromium } from "playwright";
import { scanBrowserPage } from "../../src/scanner/browser-scan.js";
import { assertContainerRuntime } from "../../src/runner/worker-boundary.js";

await assertContainerRuntime();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
try {
  const page = await context.newPage();
  await page.setContent('<!doctype html><html><head><title>Second checker fixture</title></head><body><main><h1>Fixture</h1><img id="logo" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"></main></body></html>');
  const options = { route: "/", condition: "desktop-light", evidenceDir: "/evidence", interactionProbes: false } as const;
  const axe = await scanBrowserPage(page, { ...options, generation: "axe", ibm: false });
  assert.equal(axe.ibmCheckerVersion, undefined);
  const combined = await scanBrowserPage(page, { ...options, generation: "ibm", ibm: true });
  assert.equal(combined.ibmCheckerVersion, "4.0.34");
  assert.equal(axe.violations.filter(v => v.ruleId === "image-alt").length, 1);
  assert.equal(combined.violations.filter(v => v.ruleId === "image-alt").length, 1);
  assert.equal(combined.violations.filter(v => v.ruleId === "html-has-lang").length, 1);
  assert(combined.violations.length >= axe.violations.length);
  console.log(JSON.stringify({ kind: "real-isolated-ibm-scanner", axeVersion: axe.checkerVersion,
    ibmVersion: combined.ibmCheckerVersion, imageInstances: 1, missingLanguageInstances: 1,
    before: axe.violations.length, combined: combined.violations.length, incomplete: combined.incomplete.length, paid: 0 }));
} finally { await context.close(); await browser.close(); }

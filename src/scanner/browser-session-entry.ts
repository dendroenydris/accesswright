import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { defaults } from "../config.js";
import { crawlSameOriginPaths } from "../routes/discovery.js";
import { BrowserCommandSchema, BrowserScanOutputSchema, CrawlOutputSchema } from "../runner/session-protocol.js";
import { scanBrowserPage } from "./browser-scan.js";
import { scanConditions } from "./browser-facts.js";
import type { BrowserObservation } from "./observations.js";

await access("/.dockerenv");
if (process.platform !== "linux") throw new Error("Pinned browser scans require Docker");
const command = BrowserCommandSchema.parse(JSON.parse(process.argv[2] ?? "null"));

if (command.action === "ready") {
  const deadline = Date.now() + defaults.readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL(command.route, command.baseUrl), { redirect: "manual", signal: AbortSignal.timeout(10000) });
      ready = response.status >= 200 && response.status < 300;
      await response.body?.cancel();
      if (ready) break;
    } catch { /* A starting application can temporarily refuse connections. */ }
    await delay(250);
  }
  if (!ready) throw new Error(`Application did not serve a successful ready response for ${command.route}`);
  console.log(JSON.stringify({ ready: true }));
} else {
  const browser = await chromium.launch({ headless: true });
  async function navigate(page: Page, path: string): Promise<void> {
    const response = await page.goto(new URL(path, command.baseUrl).href, { waitUntil: "load", timeout: defaults.browserNavigationTimeoutMs });
    if (new URL(page.url()).origin !== command.baseUrl) throw new Error("Refusing a cross-origin application redirect");
    if (response === null || !response.ok()) throw new Error(`Application route is not healthy: ${path} (HTTP ${response?.status() ?? "none"})`);
  }
  try {
    if (command.action === "crawl") {
      const context = await browser.newContext({ viewport: defaults.desktop, serviceWorkers: "block" });
      try {
        const paths = await crawlSameOriginPaths(command.baseUrl, async path => {
          const page = await context.newPage();
          try { await navigate(page, path); return await page.locator("a[href]").evaluateAll(nodes => nodes.map(node => node.getAttribute("href") ?? "")); }
          finally { await page.close(); }
        }, { maxDepth: command.maxDepth, maxPages: command.maxPages });
        console.log(JSON.stringify(CrawlOutputSchema.parse({ paths })));
      } finally { await context.close(); }
    } else {
      const observations: BrowserObservation[] = [];
      for (const route of command.routes) {
        let darkSupported = false;
        for (const condition of scanConditions({ mobile: command.mobile, darkScheme: command.dark })) {
          if (condition === "desktop-dark" && !darkSupported) continue;
          const context = await browser.newContext({ viewport: condition === "mobile-light" ? defaults.mobile : defaults.desktop,
            colorScheme: condition === "desktop-dark" ? "dark" : "light", serviceWorkers: "block" });
          try {
            const page = await context.newPage();
            const runtimeFailures: string[] = [];
            page.on("pageerror", error => { runtimeFailures.push(`runtime:${route}:${condition}:${createHash("sha256").update(error.message).digest("hex").slice(0, 16)}`); });
            await navigate(page, route);
            const result = await scanBrowserPage(page, { route, condition, generation: command.generation, evidenceDir: "/evidence", interactionProbes: command.interactions });
            result.probeFailures.push(...runtimeFailures);
            if (condition === "desktop-light") darkSupported = result.darkMediaDetected;
            observations.push(result);
          } finally { await context.close(); }
        }
      }
      console.log(JSON.stringify(BrowserScanOutputSchema.parse({ observations })));
    }
  } finally { await browser.close(); }
}

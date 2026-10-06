import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "playwright";

import { crawlSameOriginPaths } from "../routes/discovery.js";
import { parseContainerCommand } from "./container-command.js";
import { scanPage } from "./scan.js";

function screenshotName(route: string): string {
  if (route === "/") return "root.png";
  return `${route.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "")}.png`;
}

const command = parseContainerCommand(process.argv.slice(2));
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  if (command.kind === "crawl") {
    const paths = await crawlSameOriginPaths(
      command.baseUrl,
      async (path) => {
        await page.goto(new URL(path, command.baseUrl).toString(), {
          waitUntil: "domcontentloaded",
        });
        return page.locator("a[href]").evaluateAll((elements) =>
          elements.flatMap((element) => {
            const href = element.getAttribute("href");
            return href === null ? [] : [href];
          }),
        );
      },
      { maxDepth: command.maxDepth, maxPages: command.maxPages },
    );
    process.stdout.write(`${JSON.stringify({ paths })}\n`);
  } else {
    await mkdir(command.screenshotDir, { recursive: true });
    const results = [];
    for (const route of command.routes) {
      await page.goto(new URL(route, command.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
      });
      const result = await scanPage(page, route, join(command.screenshotDir, screenshotName(route)));
      results.push(result);
    }
    process.stdout.write(`${JSON.stringify({ results })}\n`);
  }

  await context.close();
} finally {
  await browser.close();
}

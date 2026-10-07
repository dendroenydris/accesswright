import { readFile, readdir } from "node:fs/promises";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

it("runs the real browser soundness set in ordinary CI without model credentials", async () => {
  const text = await readFile(".github/workflows/ci.yml", "utf8");
  const ci = z.object({ permissions: z.object({ contents: z.literal("read") }), jobs: z.object({ browser: z.object({ steps: z.array(z.record(z.string(), z.unknown())) }) }) }).parse(parse(text));
  expect(ci.jobs.browser.steps.some(step => typeof step.run === "string" && step.run.includes("test/e2e/browser-soundness.test.ts"))).toBe(true);
  expect(text).not.toContain("secrets.OPENAI");
});

it("keeps product Action integration separate from retired live-key workflows", async () => {
  const text = await readFile(".github/workflows/backlog-integration.yml", "utf8");
  const workflow = z.object({ on: z.object({ workflow_dispatch: z.unknown() }), permissions: z.object({ contents: z.literal("write"), "pull-requests": z.literal("write") }).strict() }).parse(parse(text));
  expect(workflow.on).toHaveProperty("workflow_dispatch");
  expect(text).toContain("no-llm: 'true'");
  expect(text).toContain("max-cost-usd: '0'");
  expect(text).not.toMatch(/OPENAI_API_KEY|secrets\.OPENAI|LIVE_BROWSER/);
  expect(await readdir(".github/workflows")).not.toContain("verify-openai-model.yml");
});

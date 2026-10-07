import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserObservationSchema } from "../../src/scanner/observations.js";
import { gatherRepairContext } from "../../src/llm/gather-context.js";
import { resolveExecutionModel } from "../../src/llm/execution-policy.js";
import type { FixTask } from "../../src/types/schemas.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const task: FixTask = { id: "button-name-task", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm", source: { file: "components/Save.tsx", line: 1, column: 29 }, routes: ["/"], violations: [{ ruleId: "button-name", route: "/", impact: "critical", target: ["#save"], html: "<button />", failureSummary: null, source: { file: "components/Save.tsx", line: 1, column: 29 } }] };

describe("deterministic rendered LLM context", () => {
  it("collects source, related call sites, rendered meaning and the actual screenshot bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "aw-context-")); roots.push(root);
    await mkdir(join(root, "components")); await mkdir(join(root, "app")); await mkdir(join(root, "evidence"));
    await writeFile(join(root, "components/Save.tsx"), 'export const Save = () => <button id="save" />;');
    await writeFile(join(root, "app/page.tsx"), 'import { Save } from "../components/Save"; export default function Page() { return <Save />; }');
    const png = new Uint8Array([137,80,78,71,13,10,26,10]);
    await writeFile(join(root, "evidence/target.png"), png);
    const page = BrowserObservationSchema.parse({ route: "/", condition: "desktop-light", violations: task.violations, incomplete: [], aria: [], ariaTree: "", probeFailures: [], probeUnavailable: [], screenshot: "page.png", sourceFiles: ["app/page.tsx", "components/Save.tsx"], darkMediaDetected: false, contexts: [{ target: ["#save"], source: task.source, mapping: "direct", pageTitle: "Editor", surroundingText: "Save changes", imageCaption: null, linkTarget: null, screenshot: "target.png", foreground: "rgb(0,0,0)", background: "rgb(255,255,255)", contrastTarget: 4.5, palette: [] }] });
    const result = await gatherRepairContext({ root, evidenceDir: join(root, "evidence"), task, observations: [page] });
    expect(result.context.component.sourceExcerpt).toContain('<button id="save"');
    expect(result.context.callSites[0]).toMatchObject({ file: "app/page.tsx", source: "<Save />" });
    expect(result.context.page.surroundingText).toBe("Save changes");
    expect(result.images[0]?.data).toEqual(png);
    expect(result.context.screenshotPath).toBeNull();
  });
  it("does not grant repository-controlled endpoints or arbitrary environment variables access to host credentials", () => {
    expect(() => resolveExecutionModel({ provider: "openai", id: "test", baseURL: "https://attacker.example/v1" })).toThrow(/trusted|endpoint/i);
    expect(() => resolveExecutionModel({ provider: "openai", id: "test", apiKeyEnv: "GITHUB_TOKEN" })).toThrow(/trusted|credential/i);
    expect(resolveExecutionModel({ provider: "openai", id: "test", reasoningEffort: "high" })).toEqual({ provider: "openai", id: "test", reasoningEffort: "high" });
    expect(resolveExecutionModel({ provider: "openai-compatible", id: "local", baseURL: "http://127.0.0.1:8080/v1", apiKeyEnv: "LOCAL_MODEL_KEY" }, true)).toMatchObject({ provider: "openai-compatible", id: "local" });
  });
});

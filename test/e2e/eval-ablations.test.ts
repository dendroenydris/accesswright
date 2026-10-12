import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { FakeLlmProvider } from "../helpers/fake-provider.js";
import { experimentalEvalSystems, freezeProtocol } from "../../src/eval/protocol.js";
import { runEvaluation } from "../../src/eval/runner.js";
import { retrieveRepairGuidance } from "../../src/llm/retrieval.js";

it.each(experimentalEvalSystems)("runs %s with fake tools and unchanged real Docker verification", async system => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-evaluation");await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot, "fake-ablation-")), fixture = join(root, "fixture");
  await createNextIntegrationFixture(fixture);
  const source = 'export default function Controls() { return <section aria-label="Actions"><p>Save changes</p><button id="seeded" aria-label="Save changes" type="button" style={{ width: 44, height: 44 }}><svg aria-hidden="true" width="12" height="12"><path d="M0 0h12v12H0z" /></svg></button></section>; }\n';
  await writeFile(join(fixture, "components/Controls.tsx"), source);
  const frozen = await freezeProtocol(join(root, "protocol.json"), { version: 1, corpus: "controlled-fixtures", frozenAt: new Date().toISOString(),
    selection: "Owned fake-provider ablation wiring and verifier gates, not public effectiveness or a general coding-agent benchmark", repositories: [{ repository: "fixture/ablation", sha: "a".repeat(40), license: "MIT", split: "dev" }],
    model: { provider: "openai", id: "fixture-model" }, operators: ["remove-button-name"], systems: [system], seeds: { dev: [1], test: [1] }, maxCasesPerRepository: 1, targetTestCases: 1 });
  const taskId = "placeholder", patch = { taskId, changes: [{ path: "components/Controls.tsx", before: '<button id="seeded"', after: '<button id="seeded" hidden' }] };
  const actions = system === "A-retrieval" ? [patch, { ...patch, changes: [{ ...patch.changes[0], after: '<button id="seeded" aria-label="Save changes"' }] }] : [
    ...(system === "A-tool-loop" ? [{ action: "read-context" }] : []), { action: "read-source", path: "components/Controls.tsx" }, { action: "propose", patch },
    { action: "propose", patch: { ...patch, changes: [{ ...patch.changes[0], after: '<button id="seeded" aria-label="Save changes"' }] } },
  ];
  const provider = new FakeLlmProvider(actions.map(object => ({ object, usage: { inputTokens: 200, outputTokens: 50, costUsd: 0.0003 } })));
  try {
    const result = await runEvaluation({ frozen, split: "dev", runtimeRoot: process.cwd(), tempRoot, outputDir: join(root, "results"), cacheRoot: join(root, "cache"),
      fixtureRoots: { "fixture/ablation": fixture }, maxRunCostUsd: 0.1, pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, providerFactory: () => ({ generateObject: (request, schema) => {
        const id = /^Task ID: (.+)$/m.exec(request.prompt)?.[1];if (!id) throw new Error("Actual task ID missing");
        // The fixture's chosen action stays fake; only the real planner's task identity is substituted.
        for (const action of actions) { if ("patch" in action && action.patch) action.patch.taskId = id;else if ("taskId" in action) action.taskId = id; }
        return provider.generateObject(request, schema);
      } }), onProgress: event => console.log(JSON.stringify(event)) });
    expect(result.cells).toHaveLength(1);const cell = result.cells[0];
    expect(cell, JSON.stringify(cell && { status: cell.status, reason: cell.reason })).toMatchObject({ status: "completed", providerMode: "fake", providerEvidence: "fake-provider", controls: { changed: 0 }, usage: { unknownUsage: false } });
    expect(cell?.cases[0]).toMatchObject({ checkerAccepted: true, semanticallyCorrect: true, correctlyFixed: true });
    expect(cell?.verification.some(item => !item.accepted)).toBe(true);expect(cell?.verification.some(item => item.accepted)).toBe(true);
    expect(cell?.report?.checks.map(check => check.status)).toEqual(["passed", "passed", "passed", "passed"]);expect(provider.requests).toHaveLength(actions.length);
    if (system === "A-retrieval") {
      const retrieved = retrieveRepairGuidance({ id: "fixture", ruleId: "button-name", criterion: "4.1.2", kind: "semantic", route: "llm", source: { file: "components/Controls.tsx", line: 1, column: 1 }, routes: ["/"], violations: [] });
      expect(provider.requests[0]?.prompt).toContain(retrieved.documentIds[0]);expect(provider.requests[0]?.prompt).toContain("Guidance:");
    } else {
      expect(provider.requests.at(-1)?.prompt).toContain('"action":"propose","check":');
      expect(provider.requests.at(-1)?.prompt).toContain('"source":');
      if (system === "B2") expect(provider.requests.every(request => request.images?.length === 0)).toBe(true);
      else expect(provider.requests.at(-1)?.images?.[0]?.data.byteLength).toBeGreaterThan(8);
      const trace = await readFile(join(tempRoot, cell?.evidenceId ?? "missing", "evidence", "run.jsonl"), "utf8");
      expect(trace).toContain('"step":"eval-tool"');expect(trace).not.toContain(source);
    }
    expect(await readFile(join(fixture, "components/Controls.tsx"), "utf8")).toBe(source);
    console.log(`Owned fake-provider ${system} Docker evidence: ${result.outputDir}`);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

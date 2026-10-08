import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { freezeProtocol } from "../../src/eval/protocol.js";
import { runEvaluation } from "../../src/eval/runner.js";

it("scores B1 false semantics, A1 rejection, and A retry against the same actual rendered mutation", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-evaluation");
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(join(tempRoot,"seeded-comparison-"));
  const fixture = join(root,"fixture");
  await createNextIntegrationFixture(fixture);
  const source = 'export default function Controls() { return <section aria-label="Actions"><p>Save changes</p><button id="seeded" aria-label="Save changes" type="button" style={{ width: 44, height: 44 }}><svg aria-hidden="true" width="12" height="12"><path d="M0 0h12v12H0z" /></svg></button></section>; }\n';
  await writeFile(join(fixture,"components/Controls.tsx"),source);
  const frozen = await freezeProtocol(join(root,"protocol.json"), { version:1,corpus:"controlled-fixtures",frozenAt:new Date().toISOString(),selection:"Owned fixture proves evaluation semantics and retry isolation, not public benchmark performance",repositories:[{repository:"fixture/seeded",sha:"a".repeat(40),license:"MIT",split:"dev"}],model:{provider:"openai",id:"fixture-model",reasoningEffort:"high"},operators:["remove-button-name"],systems:["B1","A1","A"],seeds:{dev:[1],test:[1]},maxCasesPerRepository:1,targetTestCases:300 });
  const calls = new Map<string, number>();
  const result = await runEvaluation({ frozen, split:"dev", runtimeRoot:process.cwd(),tempRoot,outputDir:join(root,"results"),cacheRoot:join(root,"cache"),fixtureRoots:{"fixture/seeded":fixture},maxRunCostUsd:0.1,pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2},
    providerFactory: system => ({ generateObject: request => {
      const count = (calls.get(system) ?? 0) + 1; calls.set(system,count);
      const taskId = /^Task ID: (.+)$/m.exec(request.prompt)?.[1];
      if (!taskId) throw new Error("The real task identity must reach the proposal");
      if (system === "B1") { expect(request.images).toBeUndefined(); expect(request.prompt).not.toContain("Guidance:"); }
      else expect(request.images?.[0]?.data.byteLength).toBeGreaterThan(8);
      const replacement = system === "B1" ? '<button id="seeded" aria-label="Delete account"' : count === 1 ? '<button id="seeded" hidden' : '<button id="seeded" aria-label="Save changes"';
      return Promise.resolve({object:{taskId,changes:[{path:"components/Controls.tsx",before:'<button id="seeded"',after:replacement}]},usage:{inputTokens:200,outputTokens:50,costUsd:0.0003}});
    } }),
    onProgress: event => console.log(JSON.stringify(event)),
  });
  expect(result.cells).toHaveLength(3);
  expect(new Set(result.cells.flatMap(cell=>cell.cases.map(item=>item.id))).size).toBe(1);
  expect(result.cells.every(cell=>cell.status==="completed"), JSON.stringify(result.cells.map(({system,status,reason})=>({system,status,reason})))).toBe(true);
  expect(result.cells.find(cell=>cell.system==="B1")?.cases[0]).toMatchObject({checkerAccepted:true,semanticallyCorrect:false,correctlyFixed:false});
  expect(result.cells.find(cell=>cell.system==="A1")?.cases[0]?.correctlyFixed).toBe(false);
  expect(result.cells.find(cell=>cell.system==="A")?.cases[0]?.correctlyFixed).toBe(true);
  expect(calls).toEqual(new Map([["B1",1],["A1",1],["A",2]]));
  expect(result.cells.every(cell=>cell.providerEvidence==="fake-provider" && cell.controls.changed===0)).toBe(true);
  for (const cell of result.cells) expect(cell.report?.checks.map(check=>check.status)).toEqual(["passed","passed","passed","passed"]);
  expect(await readFile(join(fixture,"components/Controls.tsx"),"utf8")).toBe(source);
  console.log(`Controlled B1/A1/A real-browser evaluation evidence: ${result.outputDir}`);
});

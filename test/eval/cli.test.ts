import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseEvalArgs, runEvaluationCli } from "../../src/eval/cli.js";

it("exposes the compiled evaluation CLI as the reproducible npm entrypoint", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  expect(manifest.scripts?.eval).toBe("node dist/src/eval/cli.js");
});

it("defaults evaluation to zero-cost deterministic work and requires an explicit output destination", () => {
  expect(parseEvalArgs(["--protocol","eval/frozen.json","--output","/tmp/results","--split","dev"])).toMatchObject({protocol:"eval/frozen.json",output:"/tmp/results",split:"dev",systems:["deterministic"]});
  expect(() => parseEvalArgs(["--protocol","eval/frozen.json"])).toThrow(/output/i);
  expect(parseEvalArgs(["--output","/tmp/results","--resume"])).toMatchObject({resume:true,systems:["deterministic"]});
  expect(() => parseEvalArgs(["--output","/tmp/results","--resume","--resume"])).toThrow(/duplicate/i);
});
it("preserves explicit subsets and rejects unknown, duplicate, malformed, or empty selection flags", () => {
  expect(parseEvalArgs(["--output","/tmp/results","--systems","B1,A1,A","--seeds","1,2,3","--repositories","owner/a,owner/b","--max-cases","4"])).toMatchObject({systems:["B1","A1","A"],seeds:[1,2,3],repositories:["owner/a","owner/b"],caseLimit:4});
  for (const flags of [["--systems","fake"],["--seeds","NaN"],["--max-cases","0"],["--max-cases","1.2"],["--foo","bar"],["--systems","A","--systems","A1"],["--repositories",""]]) {
    expect(() => parseEvalArgs(["--output","/tmp/results",...flags])).toThrow();
  }
});
it.each(["B2", "A-retrieval", "A-tool-loop"])("refuses live CLI %s before protocol reading or model authentication", async system => {
  await expect(runEvaluationCli(["--output", "/unused-output", "--protocol", "/missing-protocol", "--systems", system])).rejects.toThrow(/fake-provider injection/);
});

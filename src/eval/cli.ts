#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { readFrozenProtocol, EvalSystemSchema } from "./protocol.js";
import type { EvalSystem } from "./protocol.js";
import { runEvaluation } from "./runner.js";
import { DurableSpendLedger } from "../llm/durable-spend.js";
import { authenticateOpenAIModel, readLiveAuthorization } from "../llm/live-authorization.js";

export interface EvalCliArgs {
  protocol:string; output:string; split:"dev"|"test"; systems:EvalSystem[];
  seeds?:number[]; repositories?:string[]; caseLimit?:number;
  tempRoot?:string; cacheRoot?:string; authorization?:string;
  resume?:boolean;
}
export function parseEvalArgs(args: readonly string[]): EvalCliArgs {
  const values = new Map<string,string>();
  const allowed = new Set(["--protocol","--output","--split","--systems","--seeds","--repositories","--max-cases","--tmp-root","--cache-root","--authorization"]);
  for(let index=0;index<args.length;){
    const name=args[index];
    if(name==="--resume"){
      if(values.has(name))throw new Error("Duplicate option: --resume");
      values.set(name,"true");
      index+=1;
      continue;
    }
    const value=args[index+1];
    if(!name||!allowed.has(name))throw new Error(`Unknown evaluation argument: ${name ?? "missing"}`);
    if(values.has(name))throw new Error(`Duplicate option: ${name}`);
    if(!value?.trim()||value.startsWith("--"))throw new Error(`Missing value for ${name}`);
    values.set(name,value);
    index+=2;
  }
  const output=values.get("--output"); if(!output)throw new Error("An explicit --output directory is required");
  const systems=(values.get("--systems")??"deterministic").split(",").map(value=>EvalSystemSchema.parse(value));
  if(new Set(systems).size!==systems.length)throw new Error("Duplicate systems");
  const seeds=values.has("--seeds")?values.get("--seeds")?.split(",").map(value=>z.number().int().nonnegative().safe().parse(value.trim()?Number(value):NaN)):undefined;
  const repositories=values.has("--repositories")?values.get("--repositories")?.split(",").map(value=>z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).parse(value)):undefined;
  const caseLimit=values.has("--max-cases")?z.number().int().positive().max(1000).parse(Number(values.get("--max-cases"))):undefined;
  return {protocol:values.get("--protocol")??"eval/protocol-20261012.json",output,split:z.enum(["dev","test"]).parse(values.get("--split")??"dev"),systems,
    ...(seeds?{seeds}:{}),...(repositories?{repositories}:{}),...(caseLimit===undefined?{}:{caseLimit}),
    ...(values.has("--tmp-root")?{tempRoot:values.get("--tmp-root")}:{}),...(values.has("--cache-root")?{cacheRoot:values.get("--cache-root")}:{}),...(values.has("--authorization")?{authorization:values.get("--authorization")}:{}),
    ...(values.has("--resume")?{resume:true}:{}),
  };
}

export async function runEvaluationCli(args: readonly string[]) {
  const options=parseEvalArgs(args);
  const frozen=await readFrozenProtocol(resolve(options.protocol));
  const runtimeRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../../..");
  const tempRoot=resolve(options.tempRoot??process.env.ACCESSWRIGHT_TMP_ROOT??join(tmpdir(),"accesswright-evaluation"));
  const common={...options,frozen,runtimeRoot,tempRoot,outputDir:resolve(options.output),cacheRoot:resolve(options.cacheRoot??join(tempRoot,"eval-source-cache")),onProgress:(event:Record<string,string|number|boolean|null>)=>{process.stdout.write(`${JSON.stringify(event)}\n`);}};
  if(options.systems.every(system=>system==="deterministic"))return runEvaluation(common);
  if(!options.authorization)throw new Error("Live evaluation requires an explicit --authorization metadata file and cumulative budget ledger");
  const authorization=await readLiveAuthorization(resolve(options.authorization));
  const model=frozen.protocol.model;
  if(model.provider!=="openai"||model.id!==authorization.model||model.reasoningEffort!==authorization.reasoningEffort||model.baseURL||model.apiKeyEnv)throw new Error("The frozen model is outside the priced operator authorization");
  const ledger=await DurableSpendLedger.open(authorization.ledgerPath);
  const snapshot=await ledger.snapshot();
  if(snapshot.blocked||snapshot.remainingUsd<=0)throw new Error("The cumulative allowance cannot authorize additional live work");
  process.stdout.write(`${JSON.stringify({phase:"authentication",...await authenticateOpenAIModel(model.id)})}\n`);
  return runEvaluation({...common,pricing:authorization.pricing,maxRunCostUsd:authorization.maxRunCostUsd,durableBudget:{ledger,maxInputTokens:authorization.maxInputTokens,expiresAt:authorization.expiresAt}});
}
const invoked=process.argv[1];
if(invoked&&import.meta.url===pathToFileURL(resolve(invoked)).href){
  runEvaluationCli(process.argv.slice(2)).then(result=>{process.stdout.write(`${JSON.stringify({phase:"complete",outputDir:result.outputDir,cells:result.cells.length})}\n`);if(result.cells.some(cell=>cell.status!=="completed"))process.exitCode=2;}).catch(error=>{process.stderr.write(`accesswright eval: ${error instanceof Error?error.message:"Evaluation failed"}\n`);process.exitCode=1;});
}

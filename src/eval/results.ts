import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EvalCellSchema, aggregateEvaluation, renderEvaluationReport } from "./report.js";
import type { EvalCell } from "./report.js";

/** Rebuild summaries from completed immutable cells after interruption; never resumes or repeats paid execution. */
export async function readEvaluationCells(directory: string): Promise<EvalCell[]> {
  const names=(await readdir(directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).sort();
  if(names.length>50000)throw new Error("Too many result cells");
  const cells: EvalCell[]=[];
  for(const name of names){
    const path=join(directory,name);
    const stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error("A result cell must be a regular file, not a symbolic link");
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      if((await file.stat()).size>4*1024*1024)throw new Error("Result cell exceeds its size bound");
      cells.push(EvalCellSchema.parse(JSON.parse(await file.readFile("utf8"))));
    } finally {await file.close();}
  }
  return cells;
}
const invoked=process.argv[1];
if(invoked&&import.meta.url===pathToFileURL(resolve(invoked)).href){
  const directory=process.argv[2];
  if(!directory||process.argv.length>4||(process.argv[3]!==undefined&&process.argv[3]!=="--json")){process.stderr.write("Usage: node results.js <result-directory> [--json]\n");process.exitCode=1;}
  else readEvaluationCells(resolve(directory)).then(cells=>{const summary=aggregateEvaluation(cells);process.stdout.write(process.argv[3]==="--json"?`${JSON.stringify(summary,null,2)}\n`:renderEvaluationReport(summary));}).catch(error=>{process.stderr.write(`Result reconstruction failed: ${error instanceof Error?error.message:"unknown"}\n`);process.exitCode=1;});
}

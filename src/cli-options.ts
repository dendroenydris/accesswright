import { defaults } from "./config.js";

export interface CliArgs {
  repoPath: string;
  noLlm: boolean;
  dryRun: boolean;
  retainEvidence: boolean;
  trustProviderConfig: boolean;
  offline?: boolean;
  maxTasks: number;
  maxCostUsd: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
}

export function parseCliArgs(input: readonly string[]): CliArgs {
  const args = input[0] === "fix" ? input.slice(1) : [...input];
  const options: Omit<CliArgs, "repoPath"> = { noLlm: false, dryRun: false, retainEvidence: false, trustProviderConfig: false, maxTasks: defaults.maxTasks, maxCostUsd: defaults.maxRunCostUsd };
  const positional: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) throw new Error("Missing CLI argument");
    if (!argument.startsWith("--")) { positional.push(argument); continue; }
    if (seen.has(argument)) throw new Error(`Duplicate option: ${argument}`);
    seen.add(argument);
    if (argument === "--no-llm") options.noLlm = true;
    else if (argument === "--offline") options.offline = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--retain-evidence") options.retainEvidence = true;
    else if (argument === "--trust-provider-config") options.trustProviderConfig = true;
    else if (["--max-tasks", "--max-cost-usd", "--input-usd-per-million", "--output-usd-per-million"].includes(argument)) {
      const text = args[++index];
      if (text === undefined || text.trim().length === 0) throw new Error(`Missing value for ${argument}`);
      const value = Number(text);
      if (!Number.isFinite(value) || value < 0 || (argument === "--max-tasks" && (!Number.isInteger(value) || value < 1))) throw new Error(`Invalid numeric value for ${argument}`);
      if (argument === "--max-tasks") options.maxTasks = value;
      else if (argument === "--max-cost-usd") options.maxCostUsd = value;
      else if (argument === "--input-usd-per-million") options.inputUsdPerMillion = value;
      else options.outputUsdPerMillion = value;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (positional.length !== 1 || positional[0] === undefined) throw new Error("Exactly one repository path is required: accesswright fix <repo> [options]");
  if ((options.inputUsdPerMillion === undefined) !== (options.outputUsdPerMillion === undefined)) throw new Error("Both input and output model prices are required");
  return { repoPath: positional[0], ...options };
}

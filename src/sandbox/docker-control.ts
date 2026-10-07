import { execa } from "execa";
import { defaults } from "../config.js";
import { buildDockerCliEnvironment, buildDockerRunArgs } from "./docker.js";
import type { DockerRunOptions } from "./docker.js";

export async function dockerControl(args: readonly string[]): Promise<string> {
  const result = await execa("docker", args, { env: buildDockerCliEnvironment(process.env), extendEnv: false,
    timeout: defaults.dockerControlTimeoutMs, forceKillAfterDelay: 5000 });
  return result.stdout.trim();
}

/** Creation and start are separate so cleanup ownership is recorded even when start hangs. */
export function createDetachedContainer(options: DockerRunOptions): Promise<string> {
  if (!options.name || options.detach !== true) throw new Error("A named detached container is required");
  const args = buildDockerRunArgs(options).slice(1).filter(argument => argument !== "--detach");
  return dockerControl(["create", ...args]);
}

import { execa } from "execa";
import { defaults } from "../config.js";

export interface DockerRunOptions {
  image: string;
  repoPath?: string;
  command: readonly string[];
  environment?: Readonly<Record<string, string>>;
  offline?: boolean;
  name?: string;
  detach?: boolean;
  network?: string;
  noNewPrivileges?: boolean;
  extraVolumes?: readonly { hostPath: string; containerPath: string; readOnly?: boolean }[];
  publishPorts?: readonly { hostPort?: number; containerPort: number }[];
}

const secretLikeName = /(api[_-]?key|token|secret|password|credential)/i;

function assertSafeContainerEnvironment(environment: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(environment)) {
    if (secretLikeName.test(name)) {
      throw new Error(`Refusing secret-like environment variable in sandbox: ${name}`);
    }
  }
}

export function buildDockerRunArgs(options: DockerRunOptions): string[] {
  const environment = options.environment ?? {};
  assertSafeContainerEnvironment(environment);

  const args = [
    "run",
    "--rm",
    "--init",
    "--workdir",
    "/workspace",
  ];

  if (options.repoPath !== undefined) {
    args.push("--volume", `${options.repoPath}:/workspace`);
  }

  if (options.name !== undefined) {
    args.push("--name", options.name);
  }
  if (options.detach === true) {
    args.push("--detach");
  }
  if (options.offline === true) {
    args.push("--network", "none");
  }
  if (options.network !== undefined) {
    if (options.offline === true) throw new Error("Choose either an isolated named network or no network");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(options.network)) throw new Error("Invalid Docker network name");
    args.push("--network", options.network);
  }
  if (options.noNewPrivileges === true) args.push("--security-opt", "no-new-privileges:true");

  for (const port of options.publishPorts ?? []) {
    const host = port.hostPort === undefined ? "" : String(port.hostPort);
    args.push("--publish", `127.0.0.1:${host}:${port.containerPort}`);
  }

  for (const volume of options.extraVolumes ?? []) {
    const suffix = volume.readOnly === true ? ":ro" : "";
    args.push("--volume", `${volume.hostPath}:${volume.containerPath}${suffix}`);
  }

  for (const [name, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--env", `${name}=${value}`);
  }

  args.push(options.image, ...options.command);
  return args;
}

export function buildDockerCliEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const name of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    const value = hostEnvironment[name];
    if (value !== undefined) {
      result[name] = value;
    }
  }

  return result;
}

export async function runDockerContainer(options: DockerRunOptions): Promise<string> {
  const result = await execa("docker", buildDockerRunArgs(options), {
    env: buildDockerCliEnvironment(process.env),
    extendEnv: false,
    timeout: defaults.dockerControlTimeoutMs,
    forceKillAfterDelay: 5000,
  });
  return result.stdout.trim();
}

export function buildDockerCopyArgs(
  source: string,
  container: string,
  destination: string,
): string[] {
  return ["cp", source, `${container}:${destination}`];
}

export async function dockerCopy(
  source: string,
  container: string,
  destination: string,
): Promise<void> {
  await execa("docker", buildDockerCopyArgs(source, container, destination), {
    env: buildDockerCliEnvironment(process.env),
    extendEnv: false,
    timeout: defaults.dockerControlTimeoutMs,
    forceKillAfterDelay: 5000,
  });
}

/** Controlled browser output only; callers validate each flat evidence filename before copying. */
export async function dockerCopyToHost(container: string, source: string, destination: string): Promise<void> {
  await execa("docker", ["cp", `${container}:${source}`, destination], { env: buildDockerCliEnvironment(process.env), extendEnv: false,
    timeout: defaults.dockerCopyTimeoutMs, forceKillAfterDelay: 5000 });
}

export function parseDockerPublishedPort(output: string): number {
  const firstLine = output.trim().split("\n")[0] ?? "";
  const match = /:(\d+)$/.exec(firstLine);
  if (match?.[1] === undefined) {
    throw new Error(`Unable to parse Docker published port: ${output.trim()}`);
  }

  const port = Number.parseInt(match[1], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Docker published port: ${match[1]}`);
  }
  return port;
}

export async function getDockerPublishedPort(
  container: string,
  containerPort: number,
): Promise<number> {
  const result = await execa("docker", ["port", container, `${containerPort}/tcp`], {
    env: buildDockerCliEnvironment(process.env),
    extendEnv: false,
    timeout: defaults.dockerControlTimeoutMs,
    forceKillAfterDelay: 5000,
  });
  return parseDockerPublishedPort(result.stdout);
}

export async function dockerExec(
  container: string,
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<string> {
  assertSafeContainerEnvironment(environment);
  const args = ["exec", "--workdir", "/workspace"];
  for (const [name, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(container, ...command);

  const result = await execa("docker", args, {
    env: buildDockerCliEnvironment(process.env),
    extendEnv: false,
    timeout: defaults.dockerControlTimeoutMs,
    forceKillAfterDelay: 5000,
  });
  return result.stdout;
}

export interface DockerExecResultOptions {
  environment?: Readonly<Record<string, string>>;
  user?: string;
  timeoutMs?: number;
}

export async function dockerExecResult(container: string, command: readonly string[], options: DockerExecResultOptions = {}) {
  const environment = options.environment ?? {};
  assertSafeContainerEnvironment(environment);
  const args = ["exec", "--workdir", "/workspace"];
  if (options.user !== undefined) {
    if (!/^[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)?$/.test(options.user)) throw new Error("Invalid container user");
    args.push("--user", options.user);
  }
  for (const [name, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) args.push("--env", `${name}=${value}`);
  args.push(container, ...command);
  const result = await execa("docker", args, { env: buildDockerCliEnvironment(process.env), extendEnv: false, reject: false,
    timeout: options.timeoutMs ?? defaults.productionCheckTimeoutMs, forceKillAfterDelay: 5000, maxBuffer: 32 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? (result.timedOut ? 124 : 1), timedOut: result.timedOut };
}

export async function dockerExecDetached(
  container: string,
  command: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<void> {
  assertSafeContainerEnvironment(environment);
  const args = ["exec", "--detach", "--workdir", "/workspace"];
  for (const [name, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(container, ...command);

  await execa("docker", args, {
    env: buildDockerCliEnvironment(process.env),
    extendEnv: false,
    timeout: defaults.dockerControlTimeoutMs,
    forceKillAfterDelay: 5000,
  });
}

export async function stopDockerContainer(container: string): Promise<void> {
  await execa("docker", ["rm", "--force", container], {
    env: buildDockerCliEnvironment(process.env),
    extendEnv: false,
    timeout: defaults.dockerControlTimeoutMs,
    forceKillAfterDelay: 5000,
  });
}

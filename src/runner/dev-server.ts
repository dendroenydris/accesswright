import {
  dockerCopy,
  dockerExec,
  dockerExecDetached,
  getDockerPublishedPort,
  runDockerContainer,
  stopDockerContainer,
} from "../sandbox/docker.js";
import type { DockerRunOptions } from "../sandbox/docker.js";
import { sourceMappingPluginInstallSpec } from "./instrumentation.js";

export interface DevServerContainerOptions {
  workspace: string;
  image: string;
  accesswrightNodeModules: string;
  accesswrightRuntime: string;
  npmCache: string;
  containerName: string;
  port: number;
}

export interface DevServerHandle {
  containerName: string;
  url: string;
  stop: () => Promise<void>;
}

function buildInstallAndStartCommand(port: number, cachePath: string): string {
  return [
    `npm ci --ignore-scripts --cache ${cachePath}`,
    `npm install --ignore-scripts --no-save --package-lock=false ${sourceMappingPluginInstallSpec} --cache ${cachePath}`,
    `npm run dev -- --hostname 0.0.0.0 --port ${port}`,
  ].join(" && ");
}

export function buildDevServerContainerOptions(
  options: DevServerContainerOptions,
): DockerRunOptions {
  return {
    image: options.image,
    repoPath: options.workspace,
    name: options.containerName,
    detach: true,
    publishPorts: [{ containerPort: options.port }],
    extraVolumes: [
      {
        hostPath: options.accesswrightNodeModules,
        containerPath: "/accesswright/node_modules",
        readOnly: true,
      },
      {
        hostPath: options.accesswrightRuntime,
        containerPath: "/accesswright/dist",
        readOnly: true,
      },
      {
        hostPath: options.npmCache,
        containerPath: "/npm-cache",
      },
    ],
    environment: {
      NEXT_TELEMETRY_DISABLED: "1",
    },
    command: [
      "bash",
      "-lc",
      buildInstallAndStartCommand(options.port, "/npm-cache"),
    ],
  };
}

export function buildCopiedDevServerContainerOptions(
  options: DevServerContainerOptions,
): DockerRunOptions {
  return {
    image: options.image,
    name: options.containerName,
    detach: true,
    publishPorts: [{ containerPort: options.port }],
    extraVolumes: [
      {
        hostPath: options.accesswrightNodeModules,
        containerPath: "/accesswright/node_modules",
        readOnly: true,
      },
      {
        hostPath: options.accesswrightRuntime,
        containerPath: "/accesswright/dist",
        readOnly: true,
      },
      {
        hostPath: options.npmCache,
        containerPath: "/npm-cache",
      },
    ],
    environment: {
      NEXT_TELEMETRY_DISABLED: "1",
    },
    command: ["sleep", "infinity"],
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.status < 500) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }

  throw new Error(`Dev server did not become ready at ${url}`, { cause: lastError });
}

export async function startDevServer(
  options: DevServerContainerOptions,
  readyTimeoutMs = 90_000,
): Promise<DevServerHandle> {
  const dockerOptions = buildDevServerContainerOptions(options);
  await runDockerContainer(dockerOptions);

  try {
    const hostPort = await getDockerPublishedPort(options.containerName, options.port);
    const url = `http://127.0.0.1:${hostPort}`;
    await waitForHttp(url, readyTimeoutMs);

    return {
      containerName: options.containerName,
      url,
      stop: () => stopDockerContainer(options.containerName),
    };
  } catch (error) {
    await stopDockerContainer(options.containerName).catch(() => undefined);
    throw error;
  }
}

export async function startCopiedDevServer(
  options: DevServerContainerOptions,
  readyTimeoutMs = 90_000,
): Promise<DevServerHandle> {
  await runDockerContainer(buildCopiedDevServerContainerOptions(options));

  try {
    await dockerExec(options.containerName, [
      "mkdir",
      "-p",
      "/workspace",
    ]);
    await dockerCopy(`${options.workspace}/.`, options.containerName, "/workspace");

    await dockerExecDetached(
      options.containerName,
      [
        "bash",
        "-lc",
        `${buildInstallAndStartCommand(options.port, "/npm-cache")} > /tmp/accesswright-dev.log 2>&1`,
      ],
      { NEXT_TELEMETRY_DISABLED: "1" },
    );

    const hostPort = await getDockerPublishedPort(options.containerName, options.port);
    const url = `http://127.0.0.1:${hostPort}`;
    await waitForHttp(url, readyTimeoutMs);

    return {
      containerName: options.containerName,
      url,
      stop: () => stopDockerContainer(options.containerName),
    };
  } catch (error) {
    const log = await dockerExec(options.containerName, [
      "bash",
      "-lc",
      "tail -200 /tmp/accesswright-dev.log 2>/dev/null || true",
    ]).catch(() => "");
    await stopDockerContainer(options.containerName).catch(() => undefined);
    throw new Error(
      `Copied dev server failed${log.trim().length === 0 ? "" : `:\n${log.trim()}`}`,
      { cause: error },
    );
  }
}

import { execa } from "execa";
import { z } from "zod";
import { buildDockerCliEnvironment, dockerCopy, dockerExec, runDockerContainer, stopDockerContainer } from "./docker.js";
import type { DockerRunOptions } from "./docker.js";

export interface IsolatedSessionOptions {
  name: string; image: string; runtime: string; dependencies: string; packageJson: string; evidence: string; offline: boolean;
}
export interface IsolatedSessionPlan {
  application: DockerRunOptions;
  browser: DockerRunOptions;
  network: { name: string; internal: boolean };
}

export function buildIsolatedSessionPlan(options: IsolatedSessionOptions): IsolatedSessionPlan {
  z.string().regex(/^accesswright-[a-z0-9][a-z0-9-]{0,50}$/).parse(options.name);
  const runtime = [
    { hostPath: options.runtime, containerPath: "/accesswright/dist", readOnly: true },
    { hostPath: options.dependencies, containerPath: "/accesswright/node_modules", readOnly: true },
    { hostPath: options.packageJson, containerPath: "/accesswright/package.json", readOnly: true },
  ];
  return {
    application: { image: options.image, name: `${options.name}-app`, detach: true, extraVolumes: runtime, noNewPrivileges: true,
      environment: { NEXT_TELEMETRY_DISABLED: "1" }, command: ["sleep", "infinity"] },
    browser: { image: options.image, name: `${options.name}-browser`, detach: true, network: `${options.name}-network`, noNewPrivileges: true,
      extraVolumes: [...runtime, { hostPath: options.evidence, containerPath: "/evidence", readOnly: false }], command: ["sleep", "infinity"] },
    network: { name: `${options.name}-network`, internal: options.offline },
  };
}

export class IsolatedDockerSession {
  readonly plan: IsolatedSessionPlan;
  private applicationCreated = false;
  private browserCreated = false;
  private networkCreated = false;
  private connected = false;

  constructor(options: IsolatedSessionOptions) { this.plan = buildIsolatedSessionPlan(options); }
  get application(): string { return this.plan.application.name ?? ""; }
  get browser(): string { return this.plan.browser.name ?? ""; }

  async create(workspace: string): Promise<void> {
    const networkArgs = ["network", "create", ...(this.plan.network.internal ? ["--internal"] : []), this.plan.network.name];
    try {
      await execa("docker", networkArgs, { env: buildDockerCliEnvironment(process.env), extendEnv: false });
      this.networkCreated = true;
      await runDockerContainer(this.plan.application);
      this.applicationCreated = true;
      await dockerExec(this.application, ["mkdir", "-p", "/workspace", "/tmp/accesswright"]);
      await dockerCopy(`${workspace}/.`, this.application, "/workspace");
      await dockerExec(this.application, ["chown", "-R", "pwuser:pwuser", "/workspace", "/tmp/accesswright"]);
      await runDockerContainer(this.plan.browser);
      this.browserCreated = true;
    } catch (error) { await this.close(); throw error; }
  }

  /** Install happens on Docker's bridge; afterward both processes use the run-scoped network. */
  async finishInstall(): Promise<void> {
    if (this.connected) return;
    await execa("docker", ["network", "connect", "--alias", "accesswright-app", this.plan.network.name, this.application], { env: buildDockerCliEnvironment(process.env), extendEnv: false });
    await execa("docker", ["network", "disconnect", "bridge", this.application], { env: buildDockerCliEnvironment(process.env), extendEnv: false });
    this.connected = true;
  }

  async close(): Promise<void> {
    const failures: string[] = [];
    if (this.browserCreated) {
      try { await stopDockerContainer(this.browser); this.browserCreated = false; } catch { failures.push("browser"); }
    }
    if (this.applicationCreated) {
      try { await stopDockerContainer(this.application); this.applicationCreated = false; } catch { failures.push("application"); }
    }
    if (this.networkCreated) {
      try { await execa("docker", ["network", "rm", this.plan.network.name], { env: buildDockerCliEnvironment(process.env), extendEnv: false }); this.networkCreated = false; }
      catch { failures.push("network"); }
    }
    if (failures.length > 0) throw new Error(`Sandbox cleanup failed for owned resources: ${failures.join(", ")}`);
  }
}

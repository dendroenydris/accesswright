import { join } from "node:path";
import { z } from "zod";
import { dockerCopy, dockerCopyToHost, dockerExec, stopDockerContainer } from "./docker.js";
import { dockerControl, createDetachedContainer } from "./docker-control.js";
import type { DockerRunOptions } from "./docker.js";

export interface IsolatedSessionOptions {
  name: string; image: string; runtime: string; dependencies: string; packageJson: string; evidence: string; offline: boolean;
  ioMode?: "bind" | "copy";
}
export interface IsolatedSessionPlan {
  application: DockerRunOptions;
  browser: DockerRunOptions;
  network: { name: string; internal: boolean };
  runtimeVolume?: string;
}

export function buildIsolatedSessionPlan(options: IsolatedSessionOptions): IsolatedSessionPlan {
  z.string().regex(/^accesswright-[a-z0-9][a-z0-9-]{0,50}$/).parse(options.name);
  const copy = options.ioMode === "copy";
  const runtime = copy ? [{ hostPath: `${options.name}-runtime`, containerPath: "/accesswright", readOnly: true }] : [
    { hostPath: options.runtime, containerPath: "/accesswright/dist", readOnly: true },
    { hostPath: options.dependencies, containerPath: "/accesswright/node_modules", readOnly: true },
    { hostPath: options.packageJson, containerPath: "/accesswright/package.json", readOnly: true },
  ];
  return {
    application: { image: options.image, name: `${options.name}-app`, detach: true, extraVolumes: runtime, noNewPrivileges: true,
      environment: { NEXT_TELEMETRY_DISABLED: "1" }, command: ["sleep", "infinity"] },
    browser: { image: options.image, name: `${options.name}-browser`, detach: true, network: `${options.name}-network`, noNewPrivileges: true,
      extraVolumes: copy ? runtime : [...runtime, { hostPath: options.evidence, containerPath: "/evidence", readOnly: false }], command: ["sleep", "infinity"] },
    network: { name: `${options.name}-network`, internal: options.offline },
    ...(copy ? { runtimeVolume: `${options.name}-runtime` } : {}),
  };
}

export class IsolatedDockerSession {
  readonly plan: IsolatedSessionPlan;
  private applicationCreated = false;
  private browserCreated = false;
  private networkCreated = false;
  private connected = false;

  private readonly options: IsolatedSessionOptions;
  private runtimeVolumeCreated = false;
  private preparationCreated = false;
  private readonly copiedEvidence = new Set<string>();

  constructor(options: IsolatedSessionOptions) {
    // A host platform does not authorize another copy of the dependency tree.
    // Mount failures are surfaced; copy mode requires an explicit caller choice.
    const ioMode = options.ioMode ?? "bind";
    this.options = { ...options, ioMode };
    this.plan = buildIsolatedSessionPlan(this.options);
  }

  private get preparation(): string { return `${this.options.name}-prepare`; }

  private async prepareCopiedRuntime(): Promise<void> {
    const volume = this.plan.runtimeVolume;
    if (!volume) return;
    await dockerControl(["volume", "create", "--label", `io.accesswright.session=${this.options.name}`, volume]);
    this.runtimeVolumeCreated = true;
    await createDetachedContainer({ image: this.options.image, name: this.preparation, detach: true, offline: true, noNewPrivileges: true,
      extraVolumes: [{ hostPath: volume, containerPath: "/accesswright", readOnly: false }], command: ["sleep", "infinity"] });
    this.preparationCreated = true;
    await dockerControl(["start", this.preparation]);
    await dockerExec(this.preparation, ["mkdir", "-p", "/accesswright/dist", "/accesswright/node_modules"]);
    await dockerCopy(`${this.options.runtime}/.`, this.preparation, "/accesswright/dist");
    await dockerCopy(`${this.options.dependencies}/.`, this.preparation, "/accesswright/node_modules");
    await dockerCopy(this.options.packageJson, this.preparation, "/accesswright/package.json");
    await dockerExec(this.preparation, ["chmod", "-R", "a+rX", "/accesswright"]);
    await stopDockerContainer(this.preparation);
    this.preparationCreated = false;
  }

  async syncEvidence(names: readonly string[]): Promise<void> {
    if (!this.plan.runtimeVolume) return;
    for (const name of [...new Set(names)]) {
      z.string().regex(/^[a-zA-Z0-9_-]+\.png$/).max(200).parse(name);
      if (this.copiedEvidence.has(name)) continue;
      await dockerCopyToHost(this.browser, `/evidence/${name}`, join(this.options.evidence, name));
      this.copiedEvidence.add(name);
    }
  }
  get application(): string { return this.plan.application.name ?? ""; }
  get browser(): string { return this.plan.browser.name ?? ""; }

  async create(workspace: string): Promise<void> {
    const networkArgs = ["network", "create", ...(this.plan.network.internal ? ["--internal"] : []), this.plan.network.name];
    try {
      await dockerControl(networkArgs);
      this.networkCreated = true;
      await this.prepareCopiedRuntime();
      await createDetachedContainer(this.plan.application);
      this.applicationCreated = true;
      await dockerControl(["start", this.application]);
      await dockerExec(this.application, ["mkdir", "-p", "/workspace", "/tmp/accesswright"]);
      await dockerCopy(`${workspace}/.`, this.application, "/workspace");
      await dockerExec(this.application, ["chown", "-R", "pwuser:pwuser", "/workspace", "/tmp/accesswright"]);
      await createDetachedContainer(this.plan.browser);
      this.browserCreated = true;
      await dockerControl(["start", this.browser]);
      await dockerExec(this.browser, ["mkdir", "-p", "/evidence"]);
    } catch (error) { await this.close(); throw error; }
  }

  /** Install happens on Docker's bridge; afterward both processes use the run-scoped network. */
  async finishInstall(): Promise<void> {
    if (this.connected) return;
    await dockerControl(["network", "connect", "--alias", "accesswright-app", this.plan.network.name, this.application]);
    await dockerControl(["network", "disconnect", "bridge", this.application]);
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
    if (this.preparationCreated) {
      try { await stopDockerContainer(this.preparation); this.preparationCreated = false; } catch { failures.push("preparation"); }
    }
    if (this.runtimeVolumeCreated && this.plan.runtimeVolume) {
      try { await dockerControl(["volume", "rm", this.plan.runtimeVolume]); this.runtimeVolumeCreated = false; } catch { failures.push("runtime-volume"); }
    }
    if (this.networkCreated) {
      try { await dockerControl(["network", "rm", this.plan.network.name]); this.networkCreated = false; }
      catch { failures.push("network"); }
    }
    if (failures.length > 0) throw new Error(`Sandbox cleanup failed for owned resources: ${failures.join(", ")}`);
  }
}

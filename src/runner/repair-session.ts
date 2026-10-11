import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { defaults } from "../config.js";
import { DockerRepairTransport } from "../sandbox/docker-repair-transport.js";
import { RepairSession } from "./repair-runtime.js";
import type { RepairSessionOptions } from "./repair-runtime.js";

export { UnsupportedRepositoryError } from "./repair-runtime.js";
export type { RepairSessionOptions } from "./repair-runtime.js";

export class DockerRepairSession extends RepairSession<DockerRepairTransport> {
  static prepare(options: RepairSessionOptions): Promise<DockerRepairSession> {
    return DockerRepairSession.prepareWithSandbox(options, async (evidenceDir, config) => new DockerRepairTransport({
      name: `accesswright-${randomUUID().slice(0, 12)}`, image: defaults.dockerImage,
      runtime: options.runtimeDistRoot ?? join(options.runtimeRoot, "dist"), dependencies: await realpath(join(options.runtimeRoot, "node_modules")),
      packageJson: join(options.runtimeRoot, "package.json"), evidence: evidenceDir, offline: config.offline,
    }));
  }
}

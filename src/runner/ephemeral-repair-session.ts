import { EphemeralRepairTransport } from "../sandbox/ephemeral-repair-transport.js";
import { assertSecretlessWorker, workerLayout } from "./worker-boundary.js";
import { RepairSession, UnsupportedRepositoryError } from "./repair-runtime.js";
import type { RepairSessionOptions } from "./repair-runtime.js";

export class EphemeralRepairSession extends RepairSession<EphemeralRepairTransport> {
  static async prepare(options: Pick<RepairSessionOptions, "repoPath" | "config">): Promise<EphemeralRepairSession> {
    await assertSecretlessWorker();
    if (options.repoPath !== workerLayout.input) throw new Error("Worker source must be a preloaded sanitized snapshot");
    return EphemeralRepairSession.prepareWithSandbox({ ...options, tempRoot: workerLayout.temporary, runtimeRoot: workerLayout.runtime,
      retainEvidence: false, privateDiagnostics: false }, (evidenceDir, config) => {
      if (config.offline) throw new UnsupportedRepositoryError("The ephemeral worker cannot enforce offline networking; use the Docker driver", evidenceDir);
      return Promise.resolve(new EphemeralRepairTransport(evidenceDir));
    });
  }
}

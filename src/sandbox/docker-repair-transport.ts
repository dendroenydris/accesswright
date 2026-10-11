import { dockerCopy, dockerExec, dockerExecResult } from "./docker.js";
import { IsolatedDockerSession } from "./session.js";
import type { RepairExecOptions, RepairTransport } from "./repair-transport.js";

export class DockerRepairTransport extends IsolatedDockerSession implements RepairTransport {
  readonly kind = "docker" as const;
  readonly baseUrl = "http://accesswright-app:3000" as const;

  exec(role: "application" | "browser", command: readonly string[], options?: RepairExecOptions) {
    return dockerExecResult(role === "application" ? this.application : this.browser, command, options);
  }
  copyToApplication(source: string, destination: string) { return dockerCopy(source, this.application, destination); }
  async ownWorkspace(paths: readonly string[]): Promise<void> {
    await dockerExec(this.application, ["chown", "-R", "pwuser:pwuser", ...paths]);
    // Webpack dev watchers (Next 12-14) can read a copied file before chown, cache EACCES, and ignore the
    // mtime-preserving ownership change. A fresh mtime makes them re-read the now-readable file.
    await dockerExec(this.application, ["touch", "-c", "-m", "--", ...paths]);
  }
}

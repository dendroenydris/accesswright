import { execa } from "execa";
import { z } from "zod";
import { defaults } from "../config.js";

/** Read-only Git commands with hooks/config helpers disabled. No target code is executed. */
export async function verifyCheckoutProvenance(repoPath: string, expectedSha: string): Promise<void> {
  const sha = z.string().regex(/^[a-f0-9]{40}$/).parse(expectedSha);
  const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  const git = async (args: string[]) => (await execa("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repoPath, env: environment, extendEnv: false, timeout: defaults.gitReadTimeoutMs, maxBuffer: defaults.maximumDiagnosticBytes,
  })).stdout.trim();
  if (await git(["rev-parse", "HEAD"]) !== sha) throw new Error("Checkout does not match its verified base SHA");
  if (await git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("Target checkout is not clean; unverified inputs were preserved");
}

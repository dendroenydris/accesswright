import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { parseActionEnvironment, verifyActionCheckout } from "../../src/action.js";

it("requires exact clean Git inputs before binding a Docker report to a base SHA", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-action-checkout-"));
  const git = async (args: string[]) => (await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgSign=false", ...args], { cwd: root })).stdout.trim();
  try {
    await git(["init"]);
    await writeFile(join(root, "page.tsx"), "export const value = 1;\n");
    await git(["add", "--", "page.tsx"]);
    await git(["commit", "-m", "fixture"]);
    const sha = await git(["rev-parse", "HEAD"]);
    await expect(verifyActionCheckout(root, sha)).resolves.toBeUndefined();
    await expect(verifyActionCheckout(root, "0".repeat(40))).rejects.toThrow(/SHA/);
    await writeFile(join(root, "page.tsx"), "export const value = 2;\n");
    await expect(verifyActionCheckout(root, sha)).rejects.toThrow(/clean/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects fork/privileged PR triggers instead of treating them as an authorized backlog run", () => {
  for (const event of ["pull_request", "pull_request_target", "workflow_run", "push"]) {
    expect(() => parseActionEnvironment({ GITHUB_REF_TYPE: "branch", GITHUB_EVENT_NAME: event })).toThrow(/trigger|dispatch/);
  }
});

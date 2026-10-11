import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, expect, it } from "vitest";
import { defaults } from "../../src/config.js";
import { createHostedInputBundle, materializeHostedInput } from "../../src/hosted/input-bundle.js";

const roots: string[] = [];
async function root() { const dir = await mkdtemp(join(tmpdir(), "aw-input-bundle-")); roots.push(dir); return dir; }
function file(path: string, bytes = Buffer.from("owned source\n")) {
  return { path, mode: "100644" as const, blobSha: createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex"), data: bytes.toString("base64") };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it("copies exact frozen binary Git blobs, executable modes and the shared private exclusions", async () => {
  const repoPath = await root(), destination = join(await root(), "source");
  await mkdir(join(repoPath, "app")); await mkdir(join(repoPath, ".aws"));
  await writeFile(join(repoPath, "package.json"), "{}\n"); await writeFile(join(repoPath, "app/page.tsx"), "source\n");
  await writeFile(join(repoPath, "asset.bin"), Buffer.from([0, 255, 10, 128, 0]));
  await writeFile(join(repoPath, "build.sh"), "exit 0\n");
  for (const path of [".env.local", ".npmrc", "AGENTS.md", "server.key", ".aws/config"]) await writeFile(join(repoPath, path), "private fixture marker");
  await symlink("app/page.tsx", join(repoPath, "linked.tsx"));
  const git = async (args: string[]) => (await execa("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", ...args], {
    cwd: repoPath, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, extendEnv: false,
  })).stdout.trim();
  await git(["init"]); await git(["add", "--", "package.json", "app/page.tsx", "asset.bin", "build.sh", ".env.local", ".npmrc", "AGENTS.md", "server.key", ".aws/config", "linked.tsx"]); await git(["update-index", "--chmod=+x", "build.sh"]);
  await git(["-c", "core.filemode=false", "commit", "-m", "fixture"]);
  await git(["config", "core.filemode", "false"]);
  const verifiedBaseSha = await git(["rev-parse", "HEAD"]);
  const bundle = await createHostedInputBundle({ runId: "run1", repoPath, verifiedBaseSha });
  expect(bundle.files.map(item => item.path)).toEqual(["app/page.tsx", "asset.bin", "build.sh", "package.json"]);
  await materializeHostedInput(bundle, destination);
  expect(await readFile(join(destination, "asset.bin"))).toEqual(Buffer.from([0, 255, 10, 128, 0]));
  expect(await readFile(join(destination, "app/page.tsx"), "utf8")).toBe("source\n");
  expect((await lstat(join(destination, "build.sh"))).mode & 0o100).toBe(0o100);
  await writeFile(join(repoPath, "app/page.tsx"), "dirty checkout");
  await expect(createHostedInputBundle({ runId: "run1", repoPath, verifiedBaseSha })).rejects.toThrow(/not clean/);
});

it.each(["../escape.tsx", "/absolute.tsx", "app//page.tsx", "app/./page.tsx", "C:\\escape.tsx", ".env.local", "app/credentials.ts", ".git/config", "node_modules/view.tsx"])("rejects unsafe input %s before writing", async path => {
  const destination = join(await root(), "source");
  await expect(materializeHostedInput({ runId: "run1", baseSha: "a".repeat(40), files: [file(path)] }, destination)).rejects.toThrow();
  await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["hash", "base64", "duplicate", "parent", "mode", "count", "bytes"])("preflights %s failures without leaving a partial source", async kind => {
  const files: Array<Record<string, unknown>> = [file("app/page.tsx")];
  if (kind === "hash") files[0].blobSha = "0".repeat(40);
  if (kind === "base64") files[0].data = "Zh==";
  if (kind === "duplicate") files.push(file("app/page.tsx"));
  if (kind === "parent") files.push(file("app"));
  if (kind === "mode") files[0].mode = "120000";
  if (kind === "count") files.push(...Array.from({ length: defaults.hostedMaxInputFiles }, (_, index) => file("files/" + index, Buffer.alloc(0))));
  if (kind === "bytes") files[0] = file("large.bin", Buffer.alloc(defaults.hostedMaxInputBytes + 1));
  const destination = join(await root(), "source");
  await expect(materializeHostedInput({ runId: "run1", baseSha: "a".repeat(40), files }, destination)).rejects.toThrow();
  await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves an existing directory or symlink instead of cleaning another owner's input", async () => {
  const directory = await root(), existing = join(directory, "source"), link = join(directory, "linked");
  await mkdir(existing); await writeFile(join(existing, "owned.txt"), "preserve"); await symlink(existing, link);
  const bundle = { runId: "run1", baseSha: "a".repeat(40), files: [file("view.tsx")] };
  await expect(materializeHostedInput(bundle, existing)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(materializeHostedInput(bundle, link)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(join(existing, "owned.txt"), "utf8")).toBe("preserve");
});

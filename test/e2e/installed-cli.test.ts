import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { z } from "zod";
import { defaults } from "../../src/config.js";
import { RunReportSchema } from "../../src/reporter/report.js";
import { dockerControl } from "../../src/sandbox/docker-control.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";

async function ownedContainers(root: string): Promise<string[]> {
  const names = (await dockerControl(["ps", "-a", "--format", "{{.Names}}"])).split("\n").filter(name => /^accesswright-.*-(app|browser)$/.test(name));
  const owned: string[] = [];
  for (const name of names) {
    const mounts = z.array(z.object({ Source: z.string() })).parse(JSON.parse(await dockerControl(["inspect", "--format", "{{json .Mounts}}", name])) as unknown);
    if (mounts.some(mount => {
      const path = relative(root, mount.Source.replace(/^\/host_mnt/, ""));
      return !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep);
    })) owned.push(name);
  }
  return owned;
}

it("installs the actual tarball and repairs through its npm command in Docker without modifying the target", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "accesswright-installed-cli-")));
  const consumer = join(root, "consumer"), target = join(root, "target");
  const environment = { PATH: process.env.PATH ?? "", HOME: root, DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: join(root, "docker-config"), ACCESSWRIGHT_TMP_ROOT: join(root, "runs"),
    npm_config_cache: join(root, "npm-cache"), npm_config_userconfig: join(root, "empty-npmrc"), npm_config_globalconfig: join(root, "empty-global-npmrc") };
  try {
    await mkdir(consumer); await mkdir(target); await mkdir(environment.DOCKER_CONFIG);
    await writeFile(environment.npm_config_userconfig, ""); await writeFile(environment.npm_config_globalconfig, "");
    await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, name: "accesswright-installed-cli-consumer", version: "1.0.0" }));
    const packed = await execa("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: process.cwd(), env: environment, extendEnv: false, timeout: defaults.gitReadTimeoutMs });
    const packages = z.array(z.object({ filename: z.string().regex(/^accesswright-[a-zA-Z0-9.-]+\.tgz$/) })).length(1).parse(JSON.parse(packed.stdout) as unknown);
    const filename = packages[0]?.filename;
    if (!filename) throw new Error("Missing packed product filename");
    await execa("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", join(root, filename)],
      { cwd: consumer, env: environment, extendEnv: false, timeout: defaults.installTimeoutMs });
    await createNextIntegrationFixture(target);
    const paths = ["components/Controls.tsx", "app/page.tsx"];
    const before = await Promise.all(paths.map(async path => createHash("sha256").update(await readFile(join(target, path))).digest("hex")));
    const executed = await execa(join(consumer, "node_modules/.bin/accesswright"), ["fix", target, "--no-llm", "--dry-run", "--offline"],
      { cwd: consumer, env: environment, extendEnv: false, timeout: defaults.productionCheckTimeoutMs * 2 });
    const report = RunReportSchema.parse(JSON.parse(executed.stdout) as unknown);
    expect(report).toMatchObject({ status: "verified", fixed: 2, applied: false, providerVerification: "not-run", unknownUsage: false, usage: { inputTokens: 0, outputTokens: 0, spentUsd: 0 } });
    expect(report.final.acceptedFixIds).toHaveLength(2); expect(report.final.failures).toEqual([]);
    for (const check of ["build", "typecheck", "lint", "tests"]) expect(report.checks.filter(result => result.check === check)).toEqual([expect.objectContaining({ available: true, status: "passed" })]);
    expect(await Promise.all(paths.map(async path => createHash("sha256").update(await readFile(join(target, path))).digest("hex")))).toEqual(before);
    expect(await ownedContainers(root)).toEqual([]);
  } finally {
    const networks = new Set<string>();
    for (const name of await ownedContainers(root)) {
      networks.add(name.replace(/-(app|browser)$/, "-network"));
      await dockerControl(["rm", "-f", name]);
    }
    const existing = (await dockerControl(["network", "ls", "--format", "{{.Name}}"])).split("\n");
    for (const name of networks) if (existing.includes(name)) await dockerControl(["network", "rm", name]);
    await rm(root, { recursive: true, force: true });
  }
});

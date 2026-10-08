import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { defaults } from "../../src/config.js";
import { dockerCopy, dockerCopyToHost, dockerExec, runDockerContainer, stopDockerContainer } from "../../src/sandbox/docker.js";
import { repairRepository } from "../../src/core/repository.js";
import { createNextIntegrationFixture } from "../fixtures/next-integration.js";
import { pinnedPnpmVersion } from "../../src/runner/install-plan.js";

it.each(["12.3.4", pinnedPnpmVersion])("repairs an actual pnpm %s locked app without rewriting its manifest or lockfile", async pnpmVersion => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const fixture = await mkdtemp(join(tempRoot, "pnpm-fixture-"));
  await createNextIntegrationFixture(fixture);
  const manifest = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(fixture, "package.json"), "utf8")));
  manifest.packageManager = `pnpm@${pnpmVersion}`;
  await writeFile(join(fixture, "package.json"), JSON.stringify(manifest, null, 2));
  const original = await readFile(join(fixture, "package.json"), "utf8");
  const container = `accesswright-lock-${randomUUID().slice(0, 12)}`;
  try {
    await runDockerContainer({ image: defaults.dockerImage, name: container, detach: true, command: ["sleep", "infinity"] });
    await dockerExec(container, ["mkdir", "-p", "/workspace"]);
    await dockerCopy(join(fixture, "package.json"), container, "/workspace/package.json");
    await dockerExec(container, ["npm", "install", "--prefix", "/tmp/tools", "--ignore-scripts", "--no-audit", "--no-fund", `pnpm@${pnpmVersion}`]);
    await dockerExec(container, ["sh", "-c", 'exec "$@"', "accesswright-lock-fixture", "/tmp/tools/node_modules/.bin/pnpm", "install", "--lockfile-only", "--ignore-scripts", "--config.manage-package-manager-versions=false"]);
    await dockerCopyToHost(container, "/workspace/pnpm-lock.yaml", join(fixture, "pnpm-lock.yaml"));
  } finally { await stopDockerContainer(container); }
  const lock = await readFile(join(fixture, "pnpm-lock.yaml"), "utf8");
  const result = await repairRepository({ repoPath: fixture, tempRoot, runtimeRoot: process.cwd(), noLlm: true, offline: true, retainEvidence: true, privateDiagnostics: true });
  expect(result.report.fixed).toBe(2);
  expect(result.report.status).toBe("verified");
  expect(result.report.checks.map(check => check.status)).toEqual(["passed", "passed", "passed", "passed"]);
  expect(await readFile(join(fixture, "package.json"), "utf8")).toBe(original);
  expect(await readFile(join(fixture, "pnpm-lock.yaml"), "utf8")).toBe(lock);
  console.log(`pnpm real integration evidence: ${result.evidenceDir}`);
});

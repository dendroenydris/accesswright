import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { defaults } from "../../src/config.js";
import { dockerExec } from "../../src/sandbox/docker.js";
import { IsolatedDockerSession } from "../../src/sandbox/session.js";

it("executes the pinned opt-in IBM engine in isolated Chromium and deduplicates equivalent DOM findings", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const evidence = await mkdtemp(join(tempRoot, "ibm-scanner-")), workspace = await mkdtemp(join(tempRoot, "ibm-workspace-"));
  const root = process.cwd();
  const session = new IsolatedDockerSession({ name: `accesswright-${randomUUID().slice(0, 12)}`, image: defaults.dockerImage, offline: true,
    runtime: join(root, "dist"), dependencies: await realpath(join(root, "node_modules")), packageJson: join(root, "package.json"), evidence });
  let output: string;
  try {
    await session.create(workspace);
    output = await dockerExec(session.browser, ["node", "/accesswright/dist/test/e2e/ibm-checker-entry.js"]);
  } finally { await session.close(); await rm(workspace, { recursive: true, force: true }); }
  const report = z.object({ kind: z.literal("real-isolated-ibm-scanner"), axeVersion: z.string(), ibmVersion: z.literal("4.0.34"),
    imageInstances: z.literal(1), missingLanguageInstances: z.literal(1), before: z.number(), combined: z.number(), incomplete: z.number(), paid: z.literal(0) }).strict().parse(JSON.parse(output));
  await writeFile(join(evidence, "report.json"), JSON.stringify(report));
  expect(report.combined).toBeGreaterThanOrEqual(report.before);
});

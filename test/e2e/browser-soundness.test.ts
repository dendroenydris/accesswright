import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { dockerExec } from "../../src/sandbox/docker.js";
import { IsolatedDockerSession } from "../../src/sandbox/session.js";
import { randomUUID } from "node:crypto";
import { defaults } from "../../src/config.js";

it("rejects all eight real DOM regressions and accepts four legitimate browser repairs", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const evidence = await mkdtemp(join(tempRoot, "browser-soundness-"));
  const root = process.cwd();
  const workspace = await mkdtemp(join(tempRoot, "browser-probe-workspace-"));
  const session = new IsolatedDockerSession({ name: `accesswright-${randomUUID().slice(0, 12)}`, image: defaults.dockerImage, offline: true,
    runtime: join(root, "dist"), dependencies: await realpath(join(root, "node_modules")), packageJson: join(root, "package.json"), evidence });
  let output: string;
  try {
    await session.create(workspace);
    output = await dockerExec(session.browser, ["node", "/accesswright/dist/test/e2e/browser-soundness-entry.js"]);
    const names = z.array(z.string()).parse(JSON.parse(await dockerExec(session.browser, ["node", "-e", "console.log(JSON.stringify(require('fs').readdirSync('/evidence').filter(name=>name.endsWith('.png'))))"])));
    await session.syncEvidence(names);
  } finally { await session.close(); }
  const report = z.object({ kind: z.literal("real-browser-verifier-soundness"), harmfulRejected: z.number(), legitimateAccepted: z.number(), failures: z.array(z.string()), screenshots: z.number() }).passthrough().parse(JSON.parse(output));
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  expect(report.failures).toEqual([]);
  expect(report.harmfulRejected).toBe(8);
  expect(report.legitimateAccepted).toBe(4);
  expect(report.screenshots).toBeGreaterThanOrEqual(24);
  console.log(`Browser evidence: ${evidence}`);
});

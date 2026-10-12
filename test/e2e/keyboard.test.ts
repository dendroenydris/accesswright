import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { defaults } from "../../src/config.js";
import { dockerExec } from "../../src/sandbox/docker.js";
import { IsolatedDockerSession } from "../../src/sandbox/session.js";

it("observes native forward/reverse focus, repeats and focus navigation in isolated Chromium", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");await mkdir(tempRoot, { recursive: true });
  const evidence = await mkdtemp(join(tempRoot, "keyboard-probe-")), workspace = await mkdtemp(join(tempRoot, "keyboard-workspace-"));
  const root = process.cwd();
  const session = new IsolatedDockerSession({ name: `accesswright-${randomUUID().slice(0, 12)}`, image: defaults.dockerImage, offline: true,
    runtime: join(root, "dist"), dependencies: await realpath(join(root, "node_modules")), packageJson: join(root, "package.json"), evidence });
  let output: string;
  try { await session.create(workspace);output = await dockerExec(session.browser, ["node", "/accesswright/dist/test/e2e/keyboard-entry.js"]); }
  finally { await session.close();await rm(workspace, { recursive: true, force: true }); }
  const report = z.object({ kind: z.literal("real-isolated-keyboard-probe"), cases: z.literal(3), forward: z.literal(2), reverse: z.literal(2), unreached: z.literal(1),
    repeatedSequences: z.literal(2), navigationStopped: z.literal(true), paid: z.literal(0) }).strict().parse(JSON.parse(output));
  await writeFile(join(evidence, "report.json"), JSON.stringify(report));expect(report.paid).toBe(0);
});

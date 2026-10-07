import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { runDockerContainer } from "../../src/sandbox/docker.js";
import { defaults } from "../../src/config.js";

it("rejects all eight real DOM regressions and accepts four legitimate browser repairs", async () => {
  const tempRoot = process.env.ACCESSWRIGHT_TMP_ROOT ?? join(tmpdir(), "accesswright-integration");
  await mkdir(tempRoot, { recursive: true });
  const evidence = await mkdtemp(join(tempRoot, "browser-soundness-"));
  const root = process.cwd();
  const output = await runDockerContainer({
    image: defaults.dockerImage, offline: true,
    command: ["node", "/accesswright/dist/test/e2e/browser-soundness-entry.js"],
    extraVolumes: [
      { hostPath: join(root, "dist"), containerPath: "/accesswright/dist", readOnly: true },
      { hostPath: join(root, "package.json"), containerPath: "/accesswright/package.json", readOnly: true },
      { hostPath: await realpath(join(root, "node_modules")), containerPath: "/accesswright/node_modules", readOnly: true },
      { hostPath: evidence, containerPath: "/evidence" },
    ],
  });
  const report = z.object({ kind: z.literal("real-browser-verifier-soundness"), harmfulRejected: z.number(), legitimateAccepted: z.number(), failures: z.array(z.string()), screenshots: z.number() }).passthrough().parse(JSON.parse(output));
  await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  expect(report.failures).toEqual([]);
  expect(report.harmfulRejected).toBe(8);
  expect(report.legitimateAccepted).toBe(4);
  expect(report.screenshots).toBeGreaterThanOrEqual(24);
  console.log(`Browser evidence: ${evidence}`);
});

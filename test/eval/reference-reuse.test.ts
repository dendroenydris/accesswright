import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { generateMutations } from "../../src/eval/operators.js";
import { verifyFrozenReferenceSource } from "../../src/eval/reference-reuse.js";
import type { EvalReference } from "../../src/eval/resume.js";

const content = 'export default function Page(){ return <button id="save" aria-label="Save changes">Save</button>; }\n';

it("accepts only exact AST mutations from the immutable pinned source and frozen operator set", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-reference-resume-"));
  try {
    await mkdir(join(root, "app"));
    await writeFile(join(root, "app/page.tsx"), content);
    const mutation = generateMutations("app/page.tsx", content).find(item => item.operator === "remove-button-name");
    expect(mutation).toBeDefined();
    const reference: EvalReference = {
      repository: { repository: "owner/test", sha: "a".repeat(40), license: "MIT", split: "test" },
      implementationDigest: "b".repeat(64),
      rendered: { eligible: [{
        mutation: mutation!,
        references: [{
          route: "/", condition: "desktop-light", nodeId: "/|desktop-light|#save", target: ["#save"],
          role: "button", name: "Save changes", text: "Save", interactive: true, language: "en",
        }], observedTargets: [],
      }], excluded: [] },
    };
    await expect(verifyFrozenReferenceSource(root, reference, ["remove-button-name"])).resolves.toBeUndefined();
    await expect(verifyFrozenReferenceSource(root, reference, ["invalid-aria"])).rejects.toThrow(/operator/i);
    await expect(verifyFrozenReferenceSource(root, {
      ...reference,
      rendered: { ...reference.rendered, eligible: reference.rendered.eligible.map(item => ({
        ...item, mutation: { ...item.mutation, after: "<button>tampered</button>" },
      })) },
    }, ["remove-button-name"])).rejects.toThrow(/mutation|match/i);
    await writeFile(join(root, "app/page.tsx"), content.replace("Save changes", "Submit changes"));
    await expect(verifyFrozenReferenceSource(root, reference, ["remove-button-name"])).rejects.toThrow(/source|changed|hash/i);
    expect((await readFile(join(root, "app/page.tsx"), "utf8")).includes("Submit changes")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

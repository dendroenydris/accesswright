import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchPinnedRepository } from "../../src/eval/repository.js";
import { prepareHostedCheckout } from "../../src/hosted/checkout.js";

vi.mock("../../src/eval/repository.js", () => ({ fetchPinnedRepository: vi.fn() }));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-hosted-checkout-"));
  vi.mocked(fetchPinnedRepository).mockImplementation(async directory => {
    const repo = join(directory, "owned-source"); await mkdir(repo); await writeFile(join(repo, "page.tsx"), "private-source-marker"); return repo;
  });
});
afterEach(async () => { vi.resetAllMocks(); await rm(root, { recursive: true, force: true }); });
function options() { return { runId: "run1", repository: "owned/fixture", verifiedBaseSha: "a".repeat(40), installationToken: "fixture-token",
  tempRoot: join(root, "checkout"), evidenceRoot: join(root, "evidence"), runtimeRoot: "/trusted/runtime" }; }

it("provides separate owned pinned checkouts and erases one lease without deleting another or the metadata receipts", async () => {
  const first = await prepareHostedCheckout(options()), second = await prepareHostedCheckout(options());
  expect(first.repoPath).not.toBe(second.repoPath); expect(first.verifiedBaseSha).toBe(options().verifiedBaseSha);
  await first.release(); await expect(access(first.repoPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(second.repoPath, "page.tsx"), "utf8")).toBe("private-source-marker");
  await first.release(); await second.release(); expect(await readdir(options().tempRoot)).toEqual([]);
  const log = await readFile(join(options().evidenceRoot, "run1/run.jsonl"), "utf8");
  expect(log).toContain("hosted-checkout-fetch"); expect(log).toContain("hosted-checkout-erasure");
  expect(log).not.toMatch(/private-source-marker|fixture-token|owned-source/);
});
it("erases failed private checkouts and redacts credential-bearing Git exceptions", async () => {
  vi.mocked(fetchPinnedRepository).mockImplementationOnce(async directory => {
    await writeFile(join(directory, "private-source"), "private-source-marker"); throw new Error("Git failure fixture-token private-source-marker");
  });
  await expect(prepareHostedCheckout(options())).rejects.toThrow(/^Trusted checkout preparation failed$/);
  expect(await readdir(options().tempRoot)).toEqual([]);
  const log = await readFile(join(options().evidenceRoot, "run1/run.jsonl"), "utf8");
  expect(log).toContain('"status":"error"'); expect(log).toContain("hosted-checkout-erasure"); expect(log).not.toMatch(/fixture-token|private-source-marker/);
});
it("rejects moving revisions and invalid run paths before creating a private checkout", async () => {
  await expect(prepareHostedCheckout({ ...options(), verifiedBaseSha: "main" })).rejects.toThrow();
  await expect(prepareHostedCheckout({ ...options(), runId: "../run1" })).rejects.toThrow();
  expect(fetchPinnedRepository).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});

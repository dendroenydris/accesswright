import { expect, it } from "vitest";
import { pinnedClonePlan, isVerifiedTransportExtra } from "../../src/eval/repository.js";

it("recognizes only untracked AppleDouble transport records, not arbitrary similarly named source", () => {
  const header = new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]);
  expect(isVerifiedTransportExtra("??", "src/._page.tsx", header)).toBe(true);
  expect(isVerifiedTransportExtra(" M", "src/._page.tsx", header)).toBe(false);
  expect(isVerifiedTransportExtra("??", "src/page.tsx", header)).toBe(false);
  expect(isVerifiedTransportExtra("??", "src/._page.tsx", new Uint8Array([1, 2, 3, 4]))).toBe(false);
  expect(isVerifiedTransportExtra("??", "../._page.tsx", header)).toBe(false);
});

it("downloads a fixed public GitHub commit without hooks, submodules, credentials or implicit branch movement", () => {
  const plan = pinnedClonePlan("owner/repo", "a".repeat(40));
  expect(plan.fetch).toContain("https://github.com/owner/repo.git");
  expect(plan.fetch).toContain("a".repeat(40));
  expect(plan.fetch).toContain("--depth=1");
  expect(plan.checkout).toEqual(["checkout", "--detach", "a".repeat(40)]);
  expect(plan.config).toContain("core.hooksPath=/dev/null");
  expect(plan.config).toContain("protocol.file.allow=never");
});
it("rejects arbitrary origins and moving refs before network access", () => {
  expect(() => pinnedClonePlan("https://evil.invalid/repo", "a".repeat(40))).toThrow();
  expect(() => pinnedClonePlan("owner/repo", "main")).toThrow();
  expect(() => pinnedClonePlan("owner/../repo", "a".repeat(40))).toThrow();
});

import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchPinnedRepository } from "../../src/eval/repository.js";

type GitFixtureOptions = { cwd: string; env: Record<string, string>; extendEnv: boolean };
const { git } = vi.hoisted(() => ({ git: vi.fn<(command: string, args: string[], options: GitFixtureOptions) => Promise<{ stdout: string }>>() }));
vi.mock("execa", () => ({ execa: git }));
const sha = "a".repeat(40), token = "fixture-installation-only";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aw-source-fetch-"));
  git.mockReset();
  git.mockImplementation(async (command, args, options) => {
    expect(command).toBe("git"); expect(options.extendEnv).toBe(false);
    if (args.includes("init")) {
      expect(args).toContain("--template="); await mkdir(join(options.cwd, ".git")); await writeFile(join(options.cwd, ".git/config"), "owned fixture only");
    }
    if (args.includes("checkout")) await writeFile(join(options.cwd, "page.tsx"), "owned source fixture");
    return { stdout: args.includes("rev-parse") ? sha : "" };
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("keeps the scoped installation credential only in scrubbed child runtime configuration, never arguments or stored config", async () => {
  const repo = await fetchPinnedRepository(root, "owned/fixture", sha, token);
  expect(await readFile(join(repo, "page.tsx"), "utf8")).toBe("owned source fixture");
  expect(await readFile(join(repo, ".git/config"), "utf8")).not.toContain(token);
  const authorization = "AUTHORIZATION: basic " + Buffer.from("x-access-token:" + token).toString("base64");
  for (const [, args, options] of git.mock.calls) {
    expect(args.join(" ")).not.toContain(token); expect(args.join(" ")).not.toContain(authorization);
    expect(options.env.GIT_CONFIG_COUNT).toBe("1"); expect(options.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(options.env.GIT_CONFIG_VALUE_0).toBe(authorization); expect(options.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(options.env.GIT_ALLOW_PROTOCOL).toBe("https"); expect(options.env.OPENAI_API_KEY).toBeUndefined();
  }
});
it("supports credential-free public fetches and verifies reuse without fetching again", async () => {
  const repo = await fetchPinnedRepository(root, "owned/fixture", sha);
  expect(git.mock.calls.some(([, , options]) => options.env.GIT_CONFIG_VALUE_0 !== undefined)).toBe(false);
  const calls = git.mock.calls.length;
  expect(await fetchPinnedRepository(root, "owned/fixture", sha)).toBe(repo);
  expect(git.mock.calls.slice(calls).some(([, args]) => args.includes("fetch"))).toBe(false);
});
it("rejects malformed credentials and path aliases before writing or starting Git", async () => {
  await expect(fetchPinnedRepository(root, "owned/fixture", sha, "fixture\r\nheader")).rejects.toThrow();
  await expect(fetchPinnedRepository(root, "../fixture", sha, token)).rejects.toThrow();
  expect(git).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
});
it("erases only the partial owned fetch on failure and preserves existing siblings", async () => {
  await writeFile(join(root, "sibling"), "preserve");
  git.mockRejectedValueOnce(new Error("fixture Git failed"));
  await expect(fetchPinnedRepository(root, "owned/fixture", sha, token)).rejects.toThrow("fixture Git failed");
  expect(await readdir(root)).toEqual(["sibling"]); await expect(access(join(root, "sibling"))).resolves.toBeUndefined();
});
it("removes only verified untracked AppleDouble bytes in a new owned fetch and preserves metadata in an existing cache", async () => {
  const implementation = git.getMockImplementation(); if (!implementation) throw new Error("Missing fixture Git implementation");
  const bytes = Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]);
  git.mockImplementation(async (command, args, options) => {
    const result = await implementation(command, args, options);
    if (args.includes("checkout")) await writeFile(join(options.cwd, "._page.tsx"), bytes);
    if (args.includes("status") && (await readdir(options.cwd)).includes("._page.tsx")) return { stdout: "?? ._page.tsx\0" };
    return result;
  });
  const repo = await fetchPinnedRepository(root, "owned/fixture", sha);
  await expect(access(join(repo, "._page.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(repo, "._page.tsx"), bytes);
  expect(await fetchPinnedRepository(root, "owned/fixture", sha)).toBe(repo);
  expect(await readFile(join(repo, "._page.tsx"))).toEqual(bytes);
});
it("refuses arbitrary untracked source with an AppleDouble-looking filename", async () => {
  const implementation = git.getMockImplementation(); if (!implementation) throw new Error("Missing fixture Git implementation");
  git.mockImplementation(async (command, args, options) => {
    const result = await implementation(command, args, options);
    if (args.includes("checkout")) await writeFile(join(options.cwd, "._page.tsx"), "actual source");
    return args.includes("status") ? { stdout: "?? ._page.tsx\0" } : result;
  });
  await expect(fetchPinnedRepository(root, "owned/fixture", sha)).rejects.toThrow("cache changed");
  expect(await readdir(root)).toEqual([]);
});

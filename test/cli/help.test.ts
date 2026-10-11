import { afterEach, expect, it, vi } from "vitest";
import { runCliMain } from "../../src/cli.js";
import { repairRepository } from "../../src/core/repository.js";

vi.mock("../../src/core/repository.js", () => ({ repairRepository: vi.fn() }));
const originalArgv = process.argv;
afterEach(() => { process.argv = originalArgv; vi.restoreAllMocks(); });

it.each([{ args: ["--help"] }, { args: ["-h"] }, { args: ["fix", "/private/never-read", "--help"] }])("shows command help without reading a repository, calling a model or requiring Docker", async ({ args }) => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  process.argv = [process.execPath, "/fixture/cli.js", ...args];
  await runCliMain();
  expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage: accesswright fix <repo> [options]"));
  expect(output).toHaveBeenCalledWith(expect.stringContaining("--dry-run"));
  expect(repairRepository).not.toHaveBeenCalled();
});

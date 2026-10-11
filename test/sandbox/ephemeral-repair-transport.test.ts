import { access, lstat, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { execa } from "execa";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertSecretlessWorker } from "../../src/runner/worker-boundary.js";
import type * as WorkerBoundary from "../../src/runner/worker-boundary.js";
import { copyTargetSnapshot } from "../../src/sandbox/source-boundary.js";
import { EphemeralRepairTransport } from "../../src/sandbox/ephemeral-repair-transport.js";

vi.mock("node:fs/promises", () => ({ access: vi.fn(), lstat: vi.fn(), mkdir: vi.fn(), open: vi.fn(), readFile: vi.fn(), readdir: vi.fn(), rm: vi.fn() }));
vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../../src/runner/worker-boundary.js", async importOriginal => ({ ...await importOriginal<typeof WorkerBoundary>(), assertSecretlessWorker: vi.fn() }));
vi.mock("../../src/sandbox/source-boundary.js", () => ({ copyTargetSnapshot: vi.fn() }));
const evidence = "/tmp/accesswright/repair-run-fixture/evidence";
const output = { close: vi.fn(), writeFile: vi.fn(), sync: vi.fn() };

beforeEach(() => {
  vi.mocked(assertSecretlessWorker).mockResolvedValue(undefined);
  vi.mocked(access).mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" }));
  vi.mocked(readdir).mockResolvedValue([]);
  vi.mocked(open).mockResolvedValue(output as unknown as Awaited<ReturnType<typeof open>>);
  vi.mocked(execa).mockResolvedValue({ stdout: "{}", stderr: "", exitCode: 0, timedOut: false } as Awaited<ReturnType<typeof execa>>);
  vi.mocked(lstat).mockResolvedValue({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(readFile).mockResolvedValue(Buffer.from("private-source-marker"));
});
afterEach(() => { vi.resetAllMocks(); });

it("checks isolation before taking ownership or copying private source", async () => {
  vi.mocked(assertSecretlessWorker).mockRejectedValue(new Error("credential present"));
  await expect(new EphemeralRepairTransport(evidence).create("/input")).rejects.toThrow("credential present");
  expect(open).not.toHaveBeenCalled();
  expect(copyTargetSnapshot).not.toHaveBeenCalled();
});
it("never deletes an occupied workspace belonging to another worker", async () => {
  const worker = new EphemeralRepairTransport(evidence);
  vi.mocked(readdir).mockResolvedValue(["existing.ts"] as unknown as Awaited<ReturnType<typeof readdir>>);
  await expect(worker.create("/input")).rejects.toThrow("occupied");
  await worker.close();
  expect(rm).toHaveBeenCalledExactlyOnceWith("/tmp/accesswright/worker.lock");
  expect(copyTargetSnapshot).not.toHaveBeenCalled();
});
it("claims the fixed workspace exclusively and refuses a second owner", async () => {
  await new EphemeralRepairTransport(evidence).create("/input");
  expect(open).toHaveBeenCalledWith("/tmp/accesswright/worker.lock", "wx", 0o600);
  vi.mocked(open).mockRejectedValue(Object.assign(new Error("occupied"), { code: "EEXIST" }));
  await expect(new EphemeralRepairTransport(evidence).create("/input")).rejects.toThrow("occupied");
  expect(copyTargetSnapshot).toHaveBeenCalledOnce();
});
it("scrubs child environments and refuses to forward a scoped token", async () => {
  const worker = new EphemeralRepairTransport(evidence);
  await worker.create("/input");
  await worker.exec("browser", ["node", "fixture.js"]);
  const calls: readonly (readonly unknown[])[] = vi.mocked(execa).mock.calls;
  const options = calls[0]?.[2];
  expect(options).toMatchObject({ extendEnv: false, cwd: "/workspace", env: { ACCESSWRIGHT_EVIDENCE_ROOT: evidence } });
  await expect(worker.exec("application", ["node", "fixture.js"], { environment: { ACCESSWRIGHT_RUN_TOKEN: "a".repeat(64) } })).rejects.toThrow("inherit a run token");
  await expect(worker.exec("application", ["node", "fixture.js"], { environment: { CUSTOM_KEY: "private-marker" } })).rejects.toThrow("not allowlisted");
  expect(execa).toHaveBeenCalledOnce();
});
it("removes an interrupted snapshot even when server cleanup fails", async () => {
  const worker = new EphemeralRepairTransport(evidence);
  vi.mocked(copyTargetSnapshot).mockRejectedValue(new Error("interrupted"));
  await expect(worker.create("/input")).rejects.toThrow("interrupted");
  vi.mocked(readdir).mockResolvedValue(["private.ts"] as unknown as Awaited<ReturnType<typeof readdir>>);
  vi.mocked(execa).mockResolvedValue({ stdout: "", stderr: "", exitCode: 1, timedOut: false } as Awaited<ReturnType<typeof execa>>);
  await expect(worker.close()).rejects.toThrow("cleanup failed");
  expect(rm).toHaveBeenCalledWith("/workspace/private.ts", { recursive: true, force: true });
  expect(rm).toHaveBeenCalledWith("/tmp/accesswright/worker.lock");
  expect(mkdir).toHaveBeenCalledWith(evidence, { recursive: true });
});
it.each(["/tmp/private.ts", "/workspace/../private.ts"])("refuses an escaping transfer to %s", async destination => {
  const worker = new EphemeralRepairTransport(evidence);
  await worker.create("/input");
  await expect(worker.copyToApplication("/input/page.tsx", destination)).rejects.toThrow("escapes");
});
it("does not follow destination symlinks or copy special files", async () => {
  const worker = new EphemeralRepairTransport(evidence);
  await worker.create("/input");
  vi.mocked(lstat).mockResolvedValue({ isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false } as Awaited<ReturnType<typeof lstat>>);
  await expect(worker.copyToApplication("/input/pipe", "/workspace/page.tsx")).rejects.toThrow("regular file");
  vi.mocked(lstat).mockResolvedValueOnce({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } as Awaited<ReturnType<typeof lstat>>)
    .mockResolvedValueOnce({ isDirectory: () => true, isSymbolicLink: () => true } as Awaited<ReturnType<typeof lstat>>);
  await expect(worker.copyToApplication("/input/page.tsx", "/workspace/app/page.tsx")).rejects.toThrow("destination directory");
  expect(readFile).not.toHaveBeenCalled();
});

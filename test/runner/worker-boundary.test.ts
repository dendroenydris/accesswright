import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertContainerRuntime, assertSecretlessWorker, validateSecretlessWorkerEnvironment } from "../../src/runner/worker-boundary.js";

vi.mock("node:fs/promises", () => ({ access: vi.fn(), lstat: vi.fn(), readFile: vi.fn() }));
const environment = { PATH: "/usr/bin", HOME: "/home/pwuser", ACCESSWRIGHT_ISOLATED_WORKER: "1" };
const cloud = { CLOUD_RUN_JOB: "fixture", CLOUD_RUN_EXECUTION: "fixture-1", CLOUD_RUN_TASK_INDEX: "0", CLOUD_RUN_TASK_ATTEMPT: "0", CLOUD_RUN_TASK_COUNT: "1" };
const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });

beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "linux", env: { ...environment }, getuid: () => 1000 });
  vi.mocked(access).mockImplementation((path, mode) => mode === constants.W_OK ? Promise.reject(denied) : Promise.resolve());
  vi.mocked(lstat).mockResolvedValue({ uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false } as Awaited<ReturnType<typeof lstat>>);
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

it.each(["OPENAI_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "CUSTOM_AUTH", "innocentName"])("rejects unallowlisted worker variable %s", name => {
  expect(() => validateSecretlessWorkerEnvironment({ ...environment, [name]: "private-marker" })).toThrow("not allowlisted");
});
it("allows only a bounded run token and an initial single-task job", () => {
  expect(() => validateSecretlessWorkerEnvironment({ ...environment, ...cloud, ACCESSWRIGHT_RUN_TOKEN: "a".repeat(64) })).not.toThrow();
  expect(() => validateSecretlessWorkerEnvironment({ ...environment, ACCESSWRIGHT_RUN_TOKEN: "provider-key" })).toThrow("scoped worker token");
});
it.each([{ CLOUD_RUN_TASK_COUNT: "2" }, { CLOUD_RUN_TASK_INDEX: "1" }, { CLOUD_RUN_TASK_ATTEMPT: "1" }, { CLOUD_RUN_JOB: undefined }])("rejects duplicate or incomplete job configuration %j", change => {
  expect(() => validateSecretlessWorkerEnvironment({ ...environment, ...cloud, ...change })).toThrow("one initial");
});
it("refuses host execution even with an explicit worker flag", async () => {
  vi.stubGlobal("process", { ...process, platform: "darwin" });
  await expect(assertSecretlessWorker()).rejects.toThrow("isolated Linux container");
  expect(access).not.toHaveBeenCalled();
});
it("requires the non-root process and an immutable root-owned runtime", async () => {
  await expect(assertSecretlessWorker()).resolves.toBeUndefined();
  vi.stubGlobal("process", { ...process, getuid: () => 0 });
  await expect(assertSecretlessWorker()).rejects.toThrow("unprivileged");
});
it.each([{ uid: 1000 }, { mode: 0o777 }, { isSymbolicLink: () => true }, { isDirectory: () => false }])("rejects an untrusted runtime directory %j", change => {
  vi.mocked(lstat).mockResolvedValue({ uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false, ...change } as Awaited<ReturnType<typeof lstat>>);
  return expect(assertSecretlessWorker()).rejects.toThrow("Untrusted worker runtime directory");
});
it("does not mistake a missing runtime or an I/O error for read-only isolation", async () => {
  vi.mocked(access).mockImplementation((path, mode) => mode === constants.W_OK ? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })) : Promise.resolve());
  await expect(assertSecretlessWorker()).rejects.toThrow("missing");
  vi.mocked(access).mockResolvedValue(undefined);
  await expect(assertSecretlessWorker()).rejects.toThrow("read-only");
});
it("accepts a Cloud Run Job only with its trusted image marker", async () => {
  vi.stubGlobal("process", { ...process, env: { ...environment, ...cloud } });
  vi.mocked(access).mockRejectedValue(Object.assign(new Error("not Docker"), { code: "ENOENT" }));
  const marker = "accesswright-secretless-worker-v1\n";
  vi.mocked(lstat).mockResolvedValue({ uid: 0, mode: 0o644, size: Buffer.byteLength(marker), isFile: () => true, isSymbolicLink: () => false } as Awaited<ReturnType<typeof lstat>>);
  vi.mocked(readFile).mockResolvedValue(marker);
  await expect(assertContainerRuntime()).resolves.toBeUndefined();
  vi.mocked(readFile).mockResolvedValue("forged-marker");
  await expect(assertContainerRuntime()).rejects.toThrow("Untrusted worker image marker");
});

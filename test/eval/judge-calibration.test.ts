import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { defaults } from "../../src/config.js";
import { calibrateJudge, runJudgeCalibrationCli } from "../../src/eval/judge-calibration.js";

const base = {
  schemaVersion: 1, protocolDigest: "a".repeat(64), implementationDigest: "b".repeat(64), rubricDigest: "c".repeat(64),
  repairModel: { provider: "openai", id: "fixture-repair" }, judgeModel: { provider: "openai", id: "fixture-judge" },
  labeledAt: "2026-10-12T00:00:00.000Z",
};
function labels(tp: number, fp: number, fn: number, tn: number) {
  const pairs = [[tp, true, true], [fp, false, true], [fn, true, false], [tn, false, false]] as const;
  return { ...base, pairs: pairs.flatMap(([count, humanCorrect, judgeCorrect]) => Array.from({ length: count }, () => ({ humanCorrect, judgeCorrect })))
    .map((pair, i) => ({ ...pair, caseId: (i % 50).toString(16).padStart(64, "0"), fixDigest: i.toString(16).padStart(64, "0") })) };
}

it("computes the human-row/judge-column confusion matrix and the exact 0.6 boundary", () => {
  const result = calibrateJudge(labels(40, 10, 10, 40));
  expect(result).toMatchObject({ fixes: 100, uniqueCases: 50, observedAgreement: 0.8, expectedAgreement: 0.5, kappa: 0.6,
    confusion: { truePositive: 40, falsePositive: 10, falseNegative: 10, trueNegative: 40 }, meetsStatisticalGate: true, provenance: "supplied-labels" });
  expect(result.labelSetDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(result.sameModel).toBe(false);
  expect(calibrateJudge(labels(39, 11, 10, 40)).meetsStatisticalGate).toBe(false);
});

it("uses unequal margins rather than treating percentage agreement as kappa", () => {
  const result = calibrateJudge(labels(20, 5, 15, 60));
  expect(result.confusion).toEqual({ truePositive: 20, falsePositive: 5, falseNegative: 15, trueNegative: 60 });
  expect(result.observedAgreement).toBe(0.8);
  expect(result.expectedAgreement).toBe(0.575);
  expect(result.kappa).toBeCloseTo(9 / 17);
  expect(result.meetsStatisticalGate).toBe(false);
});

it("does not pass empty, insufficient, chance-only, inverted or one-category labels", () => {
  expect(calibrateJudge(labels(0, 0, 0, 0))).toMatchObject({ kappa: null, observedAgreement: null, expectedAgreement: null, meetsStatisticalGate: false });
  expect(calibrateJudge(labels(50, 0, 0, 49))).toMatchObject({ kappa: 1, meetsStatisticalGate: false });
  expect(calibrateJudge(labels(25, 25, 25, 25))).toMatchObject({ kappa: 0, meetsStatisticalGate: false });
  expect(calibrateJudge(labels(0, 50, 50, 0))).toMatchObject({ kappa: -1, meetsStatisticalGate: false });
  expect(calibrateJudge(labels(100, 0, 0, 0))).toMatchObject({ observedAgreement: 1, kappa: null, meetsStatisticalGate: false });
  expect(calibrateJudge(labels(0, 0, 0, 100))).toMatchObject({ observedAgreement: 1, kappa: null, meetsStatisticalGate: false });
});

it("rejects repeated fixes instead of counting seeds as fresh labels and binds label changes", () => {
  const input = labels(40, 10, 10, 40);
  const original = calibrateJudge(input);
  input.pairs.push({ ...input.pairs[0] });
  expect(() => calibrateJudge(input)).toThrow(/Duplicate/);
  input.pairs.pop();
  input.pairs[0].judgeCorrect = false;
  expect(calibrateJudge(input).labelSetDigest).not.toBe(original.labelSetDigest);
  expect(calibrateJudge({ ...input, rubricDigest: "d".repeat(64) }).labelSetDigest).not.toBe(calibrateJudge(input).labelSetDigest);
});

it("records the same-model limitation without authenticating or altering supplied labels", () => {
  const input = { ...labels(50, 0, 0, 50), judgeModel: { ...base.repairModel, reasoningEffort: "high" } };
  const before = JSON.stringify(input);
  expect(calibrateJudge(input)).toMatchObject({ sameModel: true, kappa: 1, meetsStatisticalGate: true });
  expect(JSON.stringify(input)).toBe(before);
});

it.each([
  { protocolDigest: "invalid" }, { rubricDigest: "invalid" }, { labeledAt: "invalid" }, { source: "private" },
  { judgeModel: { ...base.judgeModel, apiKeyEnv: "SECRET" } }, { judgeModel: { ...base.judgeModel, baseURL: "https://private.invalid" } },
  { pairs: [{ caseId: "a".repeat(64), fixDigest: "b".repeat(64), humanCorrect: "true", judgeCorrect: true }] },
  { pairs: [{ caseId: "a".repeat(64), fixDigest: "b".repeat(64), humanCorrect: true, judgeCorrect: true, prompt: "private" }] },
])("rejects malformed or private fields %j", extra => {
  expect(() => calibrateJudge({ ...labels(1, 0, 0, 1), ...extra })).toThrow();
});

it("reads bounded labels offline, leaves input unchanged and rejects unsafe files/arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-judge-calibration-"));
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No model or cloud calls"));
  try {
    const path = join(root, "labels.json"), alias = join(root, "alias.json");
    const raw = JSON.stringify(labels(40, 10, 10, 40));
    await writeFile(path, raw);
    expect((await runJudgeCalibrationCli(["--labels", path])).meetsStatisticalGate).toBe(true);
    expect(await readFile(path, "utf8")).toBe(raw);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(runJudgeCalibrationCli([])).rejects.toThrow(/Expected/);
    await expect(runJudgeCalibrationCli(["--labels", "relative"])).rejects.toThrow(/absolute/);
    await expect(runJudgeCalibrationCli(["--labels", path, "--labels", path])).rejects.toThrow(/Expected/);
    await expect(runJudgeCalibrationCli(["--labels", root])).rejects.toThrow(/regular/);
    await symlink(path, alias);
    await expect(runJudgeCalibrationCli(["--labels", alias])).rejects.toThrow();
    await writeFile(path, " ".repeat(defaults.judgeCalibrationInputMaxBytes + 1));
    await expect(runJudgeCalibrationCli(["--labels", path])).rejects.toThrow(/bounded/);
    await writeFile(path, "{invalid-json");
    await expect(runJudgeCalibrationCli(["--labels", path])).rejects.toThrow();
  } finally { fetcher.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

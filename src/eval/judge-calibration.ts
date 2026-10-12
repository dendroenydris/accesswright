#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";

import { defaults } from "../config.js";
import { isMainModule } from "../entrypoint.js";
import { LlmModelConfigSchema } from "../types/schemas.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const model = LlmModelConfigSchema.pick({ provider: true, id: true, reasoningEffort: true }).extend({
  id: z.string().regex(/^[A-Za-z0-9._:/-]{1,128}$/),
  reasoningEffort: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
}).strict();

export const JudgeCalibrationSchema = z.object({
  schemaVersion: z.literal(1),
  protocolDigest: digest,
  implementationDigest: digest,
  rubricDigest: digest,
  repairModel: model,
  judgeModel: model,
  labeledAt: z.iso.datetime(),
  pairs: z.array(z.object({
    caseId: digest,
    fixDigest: digest,
    humanCorrect: z.boolean(),
    judgeCorrect: z.boolean(),
  }).strict()).max(defaults.judgeCalibrationMaxFixes),
}).strict();

/** Supplied labels establish agreement statistics, not human/provider provenance or verifier acceptance. */
export function calibrateJudge(input: unknown) {
  const data = JudgeCalibrationSchema.parse(input);
  if (new Set(data.pairs.map(pair => pair.fixDigest)).size !== data.pairs.length) throw new Error("Duplicate labeled fix");
  const confusion = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  for (const pair of data.pairs) {
    if (pair.humanCorrect) {
      if (pair.judgeCorrect) confusion.truePositive++;
      else confusion.falseNegative++;
    } else if (pair.judgeCorrect) confusion.falsePositive++;
    else confusion.trueNegative++;
  }
  const { truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn } = confusion;
  const n = data.pairs.length;
  const expected = (tp + fn) * (tp + fp) + (tn + fp) * (tn + fn);
  const denominator = n * n - expected;
  const kappa = denominator === 0 ? null : ((tp + tn) * n - expected) / denominator;
  return {
    schemaVersion: 1 as const,
    labelSetDigest: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
    protocolDigest: data.protocolDigest, implementationDigest: data.implementationDigest, rubricDigest: data.rubricDigest,
    repairModel: data.repairModel, judgeModel: data.judgeModel, labeledAt: data.labeledAt,
    provenance: "supplied-labels" as const,
    sameModel: data.repairModel.provider === data.judgeModel.provider && data.repairModel.id === data.judgeModel.id,
    fixes: n, uniqueCases: new Set(data.pairs.map(pair => pair.caseId)).size, confusion,
    observedAgreement: n === 0 ? null : (tp + tn) / n,
    expectedAgreement: n === 0 ? null : expected / (n * n),
    kappa,
    gate: { minimumFixes: defaults.judgeCalibrationMinFixes, minimumKappa: defaults.judgeCalibrationMinKappa },
    meetsStatisticalGate: n >= defaults.judgeCalibrationMinFixes && kappa !== null && kappa >= defaults.judgeCalibrationMinKappa,
  };
}

export async function runJudgeCalibrationCli(args: readonly string[]) {
  if (args.length !== 2 || args[0] !== "--labels" || !args[1] || !isAbsolute(args[1])) throw new Error("Expected --labels <absolute JSON path>");
  const file = await open(args[1], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > defaults.judgeCalibrationInputMaxBytes) throw new Error("Calibration input must be a bounded regular file");
    const bytes = Buffer.alloc(defaults.judgeCalibrationInputMaxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, null);
      if (part.bytesRead === 0) break;
      size += part.bytesRead;
    }
    if (size > defaults.judgeCalibrationInputMaxBytes) throw new Error("Calibration input exceeds size limit");
    return calibrateJudge(JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown);
  } finally { await file.close(); }
}

if (await isMainModule(import.meta.url)) {
  runJudgeCalibrationCli(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.meetsStatisticalGate ? 0 : 1;
  }).catch(() => {
    process.stderr.write("Judge calibration failed; check the bounded paired-label input\n");
    process.exitCode = 2;
  });
}

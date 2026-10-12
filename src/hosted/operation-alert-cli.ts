#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { defaults } from "../config.js";
import { isMainModule } from "../entrypoint.js";
import { evaluateOperationAlerts } from "./operation-alerts.js";

async function readSnapshot(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("Operation alert inputs must use absolute paths");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > defaults.operationInputMaxBytes) throw new Error("Operation alert input must be a bounded regular file");
    const bytes = Buffer.alloc(defaults.operationInputMaxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, null);
      if (part.bytesRead === 0) break;
      size += part.bytesRead;
    }
    if (size > defaults.operationInputMaxBytes) throw new Error("Operation alert input exceeds size limit");
    return JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown;
  } finally { await file.close(); }
}

/** Offline preview only: no notifications, cloud reads, credential access or budget changes. */
export async function runOperationAlertCli(args: readonly string[]) {
  if (args.length !== 4 || args[0] !== "--snapshot" || args[2] !== "--policy") throw new Error("Expected --snapshot <absolute JSON path> --policy <absolute JSON path>");
  return evaluateOperationAlerts(await readSnapshot(args[1]), await readSnapshot(args[3]));
}

if (await isMainModule(import.meta.url)) {
  runOperationAlertCli(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = Object.values(result.alerts).every(status => status === "ok") ? 0 : 1;
  }).catch(() => {
    process.stderr.write("Operation alert preview failed; check the bounded metadata inputs and explicit policy\n");
    process.exitCode = 2;
  });
}

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendRunRecord, RunRecordSchema } from "../../src/tracer/run-record.js";

describe("run record", () => {
  it("writes one validated JSON object per line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "accesswright-trace-"));
    const path = join(directory, "run.jsonl");

    await appendRunRecord(path, {
      timestamp: "2026-10-03T04:30:00.000Z",
      step: "scan",
      status: "ok",
      metadata: { route: "/", violations: 3 },
    });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(RunRecordSchema.parse(JSON.parse(lines[0] ?? ""))).toMatchObject({
      step: "scan",
      status: "ok",
    });
  });

  it("rejects secret-like metadata keys", () => {
    expect(() =>
      RunRecordSchema.parse({
        timestamp: "2026-10-03T04:30:00.000Z",
        step: "llm",
        status: "ok",
        metadata: { OPENAI_API_KEY: "secret" },
      }),
    ).toThrow(/secret-like/i);
  });
});

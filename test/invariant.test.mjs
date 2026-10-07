import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("clean content is retained in the source", async () => { const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8"); assert.ok(page.includes("Content must remain present.")); });

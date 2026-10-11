import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hasSourceChanges } from "../../src/eval/repository.js";

it("accepts a Git-reported modification only when raw bytes and executable mode match the frozen blob", async () => {
  const root = await mkdtemp(join(tmpdir(), "aw-checkout-bytes-"));
  try {
    const bytes = Buffer.from("<svg>original</svg>\r\n");
    await writeFile(join(root, "icon.svg"), bytes);
    const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const describe = () => Promise.resolve(`:100644 100644 ${hash} ${"0".repeat(40)} M\0icon.svg\0`);
    expect(await hasSourceChanges(root, " M icon.svg\0", describe)).toBe(false);
    await writeFile(join(root, "icon.svg"), "<svg>changed</svg>\r\n");
    expect(await hasSourceChanges(root, " M icon.svg\0", describe)).toBe(true);
    await writeFile(join(root, "icon.svg"), bytes);
    expect(await hasSourceChanges(root, " M icon.svg\0", () => Promise.resolve(`:100644 100755 ${hash} ${"0".repeat(40)} M\0icon.svg\0`))).toBe(true);
    expect(await hasSourceChanges(root, " M icon.svg\0", () => Promise.resolve(`:100644 100644 ${hash} ${"0".repeat(40)} M\0another.svg\0`))).toBe(true);
    expect(await hasSourceChanges(root, "M  icon.svg\0", describe)).toBe(true);
    expect(await hasSourceChanges(root, "?? icon.svg\0", describe)).toBe(true);
    await symlink(join(root, "icon.svg"), join(root, "linked.svg"));
    expect(await hasSourceChanges(root, " M linked.svg\0", describe)).toBe(true);
    expect(await hasSourceChanges(root, " M ../outside.svg\0", describe)).toBe(true);
    expect(await hasSourceChanges(root, " M icon.svg\0", () => Promise.resolve("malformed diff"))).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

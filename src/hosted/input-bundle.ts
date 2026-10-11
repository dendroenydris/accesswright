import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { defaults } from "../config.js";
import { verifyCheckoutProvenance } from "../runner/checkout-provenance.js";
import { isSnapshotPath } from "../sandbox/source-boundary.js";

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const fileSchema = z.object({
  path: z.string().max(defaults.hostedMaxInputPathChars).refine(isSnapshotPath),
  mode: z.enum(["100644", "100755"]),
  blobSha: shaSchema,
  data: z.string().max(Math.ceil(defaults.hostedMaxInputBytes / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
}).strict();
export const HostedInputBundleSchema = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), baseSha: shaSchema,
  files: z.array(fileSchema).min(1).max(defaults.hostedMaxInputFiles),
}).strict().superRefine((bundle, context) => {
  const paths = new Set<string>(); let bytes = 0;
  for (const file of bundle.files) {
    const decoded = Buffer.from(file.data, "base64"); bytes += decoded.length;
    if (bytes > defaults.hostedMaxInputBytes) { context.addIssue({ code: "custom", message: "Input byte limit" }); break; }
    const hash = createHash("sha1").update("blob " + decoded.length + "\0").update(decoded).digest("hex");
    if (paths.has(file.path) || hash !== file.blobSha || decoded.toString("base64") !== file.data) {
      context.addIssue({ code: "custom", message: "Invalid or duplicate input blob" });
    }
    paths.add(file.path);
  }
  if ((bytes <= defaults.hostedMaxInputBytes && Buffer.byteLength(JSON.stringify(bundle)) > defaults.hostedMaxInputBodyBytes) ||
    [...paths].some(path => path.split("/").slice(0, -1).some((_, index, parts) => paths.has(parts.slice(0, index + 1).join("/"))))) {
    context.addIssue({ code: "custom", message: "Input size or path conflict" });
  }
});
export type HostedInputBundle = z.infer<typeof HostedInputBundleSchema>;

/** Read frozen Git blobs, never execute checkout filters, hooks or repository code. */
export async function createHostedInputBundle(options: { runId: string; repoPath: string; verifiedBaseSha: string }): Promise<HostedInputBundle> {
  const runId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).parse(options.runId), baseSha = shaSchema.parse(options.verifiedBaseSha);
  await verifyCheckoutProvenance(options.repoPath, baseSha);
  const gitOptions = { cwd: options.repoPath, extendEnv: false, timeout: defaults.gitReadTimeoutMs, maxBuffer: defaults.hostedMaxInputBodyBytes,
    encoding: "buffer" as const, stripFinalNewline: false, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" } };
  const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];
  const tree = Buffer.from((await execa("git", [...args, "ls-tree", "--full-tree", "-r", "-z", baseSha], gitOptions)).stdout);
  const text = tree.toString("utf8");
  if (!Buffer.from(text).equals(tree) || !text.endsWith("\0")) throw new Error("Unsupported input tree");
  const files: Array<Omit<HostedInputBundle["files"][number], "data">> = [];
  for (const row of text.slice(0, -1).split("\0")) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) throw new Error("Unsupported input tree entry");
    if ((match[1] === "100644" || match[1] === "100755") && match[2] === "blob" && isSnapshotPath(match[4])) {
      files.push({ path: match[4], mode: match[1], blobSha: match[3] });
    }
  }
  if (!files.length || files.length > defaults.hostedMaxInputFiles) throw new Error("Input file-count limit");
  const output = Buffer.from((await execa("git", [...args, "cat-file", "--batch"], { ...gitOptions, input: files.map(file => file.blobSha).join("\n") + "\n" })).stdout);
  let offset = 0, bytes = 0;
  const populated: HostedInputBundle["files"] = [];
  for (const file of files) {
    const end = output.indexOf(10, offset);
    const header = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(output.subarray(offset, end).toString("ascii"));
    const length = Number(header?.[2]); bytes += length;
    if (end < offset || header?.[1] !== file.blobSha || !Number.isSafeInteger(length) || bytes > defaults.hostedMaxInputBytes ||
      end + 1 + length >= output.length || output[end + 1 + length] !== 10) throw new Error("Invalid or oversized input blob stream");
    populated.push({ ...file, data: output.subarray(end + 1, end + 1 + length).toString("base64") }); offset = end + 2 + length;
  }
  if (offset !== output.length) throw new Error("Trailing input blob data");
  await verifyCheckoutProvenance(options.repoPath, baseSha);
  return HostedInputBundleSchema.parse({ runId, baseSha, files: populated });
}

/** Validate every blob before creating an exclusively owned download directory. */
export async function materializeHostedInput(raw: unknown, destination: string): Promise<HostedInputBundle> {
  const bundle = HostedInputBundleSchema.parse(raw);
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const target = join(destination, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, Buffer.from(file.data, "base64"), { flag: "wx", mode: file.mode === "100755" ? 0o700 : 0o600 });
    }
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
  return bundle;
}

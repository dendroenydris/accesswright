import { createHash } from "node:crypto";
import { z } from "zod";
import { fixBranchName } from "./pr-state.js";

export type GitHubRequest = (method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>) => Promise<unknown>;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const refSchema = z.object({ object: z.object({ sha }) });
const commitSchema = z.object({ sha, tree: z.object({ sha }) });
const listedCommitSchema = z.object({
  sha, parents: z.array(z.object({ sha })),
  commit: z.object({ message: z.string(), verification: z.object({ verified: z.boolean(), reason: z.string() }).optional() }),
  committer: z.object({ login: z.string() }).nullable(), author: z.object({ login: z.string() }).nullable().optional(),
});

function madeByActor(commit: z.infer<typeof listedCommitSchema>, actor: string): boolean {
  // GitHub signs API-created bot commits using its web-flow committer identity.
  return commit.committer?.login === actor || (commit.committer?.login === "web-flow" && commit.author?.login === actor &&
    commit.commit.verification?.verified === true && commit.commit.verification.reason === "valid");
}
const resultSchema = z.object({ number: z.number().int().positive(), html_url: z.string().url() });
const pullSchema = z.object({ number: z.number().int().positive(), body: z.string().nullable(), head: z.object({ sha, ref: z.string(), repo: z.object({ full_name: z.string() }).nullable() }) });
const sourcePath = z.string().max(1024).refine(path => {
  const segments = path.split("/");
  return /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html|svg)$/.test(path) && !/[\\:]/.test(path) &&
    ![...path].some(char => char.charCodeAt(0) < 32) &&
    !segments.some(part => part.length === 0 || part.startsWith(".") || ["node_modules", "docs"].includes(part)) &&
    !/(?:^|\/)(?:next|vite|webpack|eslint|prettier|babel|postcss|tailwind|vitest|jest|rollup)\.config\./i.test(path);
}, "Only regular project-source paths may be published");
const groupSchema = z.object({ id: z.string().min(1).max(1024), ruleId: z.string().regex(/^[a-zA-Z0-9-]+$/), criterion: z.string().regex(/^[a-zA-Z0-9.-]+$/), perPatchAccepted: z.literal(true),
  changes: z.array(z.object({ path: sourcePath, before: z.string().min(1).max(1000000), after: z.string().max(1000000) }).strict()).min(1).max(64)
    .refine(changes => new Set(changes.map(change => change.path)).size === changes.length, "Duplicate source path") }).strict();
const inputSchema = z.object({
  repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/), baseBranch: z.string().min(1).max(255), verifiedBaseSha: sha,
  actorLogin: z.string().min(1).max(100), title: z.string().min(1).max(200), report: z.string().max(40000),
  verification: z.object({ acceptedFixIds: z.array(z.string()), failures: z.array(z.string()).max(0), buildPassed: z.literal(true) }).strict(),
  groups: z.array(groupSchema).max(100),
}).strict();
export type PublishInput = z.input<typeof inputSchema>;
export interface PublishResult { status: "created" | "updated" | "unchanged" | "preserved-human"; branch: string; number: number | null; url: string | null; commits: string[] }

/** Fixed GitHub origin, no redirect following, no write retries, and no response bodies in errors. */
export function createGitHubRequest(token: string, fetcher: typeof fetch = fetch): GitHubRequest {
  if (!token.trim() || /[\r\n]/.test(token)) throw new Error("A valid GitHub coordinator credential is required");
  return async (method, path, body) => {
    if (!/^\/repos\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\//.test(path) || path.includes("\\") || path.includes("#")) throw new Error("Invalid GitHub repository API path");
    const response = await fetcher(`https://api.github.com${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "accesswright" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (method === "GET" && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub ${method} failed with HTTP ${response.status}`); }
    if (response.status === 204) return null;
    if (Number(response.headers.get("Content-Length") ?? "0") > 4000000) { await response.body?.cancel(); throw new Error("GitHub response exceeds the bounded payload size"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("GitHub returned an empty response");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 4000000) { await reader.cancel(); throw new Error("GitHub response exceeds the bounded payload size"); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  };
}

function managedBody(previous: string | null, report: string, base: string): string {
  const start = "<!-- accesswright:report:start -->", end = "<!-- accesswright:report:end -->";
  const generated = `${start}\n${report}\n\nVerified base: ${base}\n\nHuman review is required. Not a legal compliance certification.\n${end}`;
  const existing = previous ?? "";
  const from = existing.indexOf(start), to = existing.indexOf(end);
  if (from < 0 && to < 0) return `${existing.trimEnd()}${existing.length ? "\n\n" : ""}${generated}\n`;
  if (from < 0 || to < from || existing.indexOf(start, from + start.length) >= 0 || existing.indexOf(end, to + end.length) >= 0) throw new Error("Ambiguous managed PR report; existing body preserved");
  return existing.slice(0, from) + generated + existing.slice(to + end.length);
}

/** Recover only a fully attributable, linear branch containing exactly this run's source scope. */
async function inspectOrphan(request: GitHubRequest, root: string, input: PublishInput, head: string): Promise<void> {
  const schema = z.object({ status: z.literal("ahead"), total_commits: z.number().int().positive().max(1000), merge_base_commit: z.object({ sha }), commits: z.array(listedCommitSchema).max(100), files: z.array(z.object({ filename: z.string(), status: z.string() })).optional() });
  const allowedPaths = new Set(input.groups.flatMap(group => group.changes.map(change => change.path)));
  const allowedGroups = new Set(input.groups.map(group => createHash("sha256").update(group.id).digest("hex")));
  let parent = input.verifiedBaseSha, count = 0, expectedCount = 0;
  for (let page = 1; page <= 10; page += 1) {
    const response = schema.parse(await request("GET", `${root}/compare/${input.verifiedBaseSha}...${head}?per_page=100&page=${page}`));
    if (response.merge_base_commit.sha !== input.verifiedBaseSha || (page > 1 && response.total_commits !== expectedCount)) throw new Error("Unverified orphan history was preserved");
    expectedCount = response.total_commits;
    if (page === 1 && (!response.files?.length || response.files.length > 64 || response.files.some(file => file.status !== "modified" || !allowedPaths.has(file.filename)))) throw new Error("Unverified orphan source scope was preserved");
    for (const item of response.commits) {
      const marker = /^Accesswright-Verified-Fix: ([a-f0-9]{64})$/m.exec(item.commit.message)?.[1];
      if (!madeByActor(item, input.actorLogin) || item.parents.length !== 1 || item.parents[0]?.sha !== parent || !marker || !allowedGroups.has(marker)) throw new Error("An unowned orphan branch was preserved");
      parent = item.sha; count += 1;
    }
    if (count === expectedCount) break;
    if (!response.commits.length || count > expectedCount || page === 10) throw new Error("Incomplete orphan history was preserved");
  }
  if (parent !== head || count !== expectedCount) throw new Error("Orphan branch history changed; preserved without writes");
}

/** The caller supplies outputs of the actual per-patch/final verifiers; this module never substitutes a verifier. */
export async function publishVerifiedPullRequest(request: GitHubRequest, raw: unknown): Promise<PublishResult> {
  const input = inputSchema.parse(raw);
  const ids = input.groups.map(group => group.id);
  if (new Set(ids).size !== ids.length || new Set(input.verification.acceptedFixIds).size !== input.verification.acceptedFixIds.length ||
      ids.length !== input.verification.acceptedFixIds.length || ids.some(id => !input.verification.acceptedFixIds.includes(id))) throw new Error("Final verification and per-group IDs do not agree");
  const branch = fixBranchName(input.baseBranch);
  const unchanged: PublishResult = { status: "unchanged", branch, number: null, url: null, commits: [] };
  if (ids.length === 0) return unchanged;
  const root = `/repos/${input.repository}`;
  const owner = input.repository.split("/")[0];
  const readRef = async (name: string): Promise<string | null> => {
    const value = await request("GET", `${root}/git/ref/heads/${encodeURIComponent(name)}`);
    return value === null ? null : refSchema.parse(value).object.sha;
  };
  if (await readRef(input.baseBranch) !== input.verifiedBaseSha) throw new Error("The verified base branch has changed");
  const pulls = z.array(pullSchema).max(1).parse(await request("GET", `${root}/pulls?state=open&base=${encodeURIComponent(input.baseBranch)}&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=2`));
  const existing = pulls[0] ?? null;
  let head = await readRef(branch);
  if (existing !== null) {
    if (existing.head.ref !== branch || existing.head.repo?.full_name !== input.repository || existing.head.sha !== head) throw new Error("Existing PR and branch identity do not agree");
    let count = 0;
    for (let page = 1; ; page += 1) {
      if (page > 10) throw new Error("PR commit inspection exceeded its explicit limit");
      const commits = z.array(listedCommitSchema).max(100).parse(await request("GET", `${root}/pulls/${existing.number}/commits?per_page=100&page=${page}`));
      count += commits.length;
      if (commits.some(commit => !madeByActor(commit, input.actorLogin) || commit.parents.length !== 1 || !/^Accesswright-Verified-Fix: [a-zA-Z0-9_-]+$/m.test(commit.commit.message))) {
        return { ...unchanged, status: "preserved-human", number: existing.number, url: `https://github.com/${input.repository}/pull/${existing.number}` };
      }
      if (commits.length < 100) break;
    }
    if (count === 0) throw new Error("Existing PR has no attributable repair commits");
  } else if (head !== null) await inspectOrphan(request, root, input, head);
  const originalHead = head;
  head ??= input.verifiedBaseSha;
  const parent = commitSchema.parse(await request("GET", `${root}/git/commits/${head}`));
  const tree = z.object({ truncated: z.literal(false), tree: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string() })) }).parse(await request("GET", `${root}/git/trees/${parent.tree.sha}?recursive=1`));
  const paths = [...new Set(input.groups.flatMap(group => group.changes.map(change => change.path)))];
  if (paths.length > 64) throw new Error("The run exceeds the explicit changed-file limit");
  const modes = new Map<string, string>(), current = new Map<string, string>(), final = new Map<string, string>();
  for (const path of paths) {
    const entry = tree.tree.find(entry => entry.path === path);
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error("A source target is missing or is not a regular Git file");
    modes.set(path, entry.mode);
    const file = z.object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string().max(2000000) }).parse(await request("GET", `${root}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${head}`));
    const bytes = Buffer.from(file.content, "base64"), content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("The source target is not valid UTF-8");
    current.set(path, content);
  }
  for (const group of input.groups) for (const change of group.changes) final.set(change.path, change.after);
  if ([...final].every(([path, content]) => current.get(path) === content)) {
    if (existing !== null || originalHead === null) return { ...unchanged, number: existing?.number ?? null, url: existing ? `https://github.com/${input.repository}/pull/${existing.number}` : null };
    if (await readRef(input.baseBranch) !== input.verifiedBaseSha || await readRef(branch) !== originalHead) throw new Error("Branch changed concurrently before orphan PR recovery");
    const published = resultSchema.parse(await request("POST", `${root}/pulls`, { title: input.title, head: branch, base: input.baseBranch, body: managedBody(null, input.report, input.verifiedBaseSha), draft: false }));
    return { ...unchanged, status: "created", number: published.number, url: published.html_url };
  }
  if (existing === null && originalHead !== null) throw new Error("Orphan source does not match the newly verified result; branch preserved");
  const selected: typeof input.groups = [];
  // Complete every source preflight before creating any Git object or moving any reference.
  for (const group of input.groups) {
    if (group.changes.every(change => current.get(change.path) === change.after)) continue;
    if (group.changes.some(change => current.get(change.path) !== change.before)) throw new Error("Verified source changed before publication");
    selected.push(group);
    for (const change of group.changes) current.set(change.path, change.after);
  }
  const body = managedBody(existing?.body ?? null, input.report, input.verifiedBaseSha);
  let treeSha = parent.tree.sha;
  const created: string[] = [];
  for (const group of selected) {
    treeSha = z.object({ sha }).parse(await request("POST", `${root}/git/trees`, { base_tree: treeSha,
      tree: group.changes.map(change => ({ path: change.path, mode: modes.get(change.path), type: "blob", content: change.after })) })).sha;
    const groupHash = createHash("sha256").update(group.id).digest("hex");
    head = z.object({ sha }).parse(await request("POST", `${root}/git/commits`, { tree: treeSha, parents: [head],
      message: `fix(a11y): ${group.ruleId} (${group.criterion})\n\nAccesswright-Verified-Fix: ${groupHash}` })).sha;
    created.push(head);
  }
  if (await readRef(input.baseBranch) !== input.verifiedBaseSha) throw new Error("The verified base branch changed before publication");
  if (await readRef(branch) !== originalHead) throw new Error("The repair branch changed concurrently; its commits were preserved");
  if (originalHead === null) await request("POST", `${root}/git/refs`, { ref: `refs/heads/${branch}`, sha: head });
  else await request("PATCH", `${root}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: head, force: false });
  const published = existing === null
    ? resultSchema.parse(await request("POST", `${root}/pulls`, { title: input.title, head: branch, base: input.baseBranch, body, draft: false }))
    : resultSchema.parse(await request("PATCH", `${root}/pulls/${existing.number}`, { body }));
  return { status: existing === null ? "created" : "updated", branch, number: published.number, url: published.html_url, commits: created };
}

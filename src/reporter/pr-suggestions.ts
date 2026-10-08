import { z } from "zod";

import { isSourcePath } from "../types/schemas.js";
import type { PublishInput } from "./github-publisher.js";

const filePatchSchema = z.object({
  path: z.string().min(1).max(1024).refine(isSourcePath),
  patch: z.string().max(1_000_000).nullable(),
}).strict();

export interface PullRequestSuggestion {
  fixId: string;
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface PullRequestCliHandoff {
  fixId: string;
  path: string;
  reason: string;
}

export interface PullRequestSuggestionPlan {
  suggestions: PullRequestSuggestion[];
  cliHandoffs: PullRequestCliHandoff[];
}

function lines(text: string): string[] {
  return text.split("\n");
}

/** Parses the right-hand line numbers that were actually added/replaced in a unified GitHub patch. */
export function parseRightSideChangedLines(patch: string): Set<number> {
  const changed = new Set<number>();
  let rightLine: number | null = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header?.[1] !== undefined) {
      rightLine = Number(header[1]);
      continue;
    }
    if (rightLine === null || line.startsWith("\\")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      changed.add(rightLine);
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) continue;
    if (line.startsWith(" ")) {
      rightLine += 1;
      continue;
    }
    // Truncated or malformed patch fragments cannot create positive evidence.
    rightLine = null;
  }
  return changed;
}

function replacementShape(before: string, after: string): {
  startLine: number;
  endLine: number;
  replacement: string;
} | null {
  const oldLines = lines(before);
  const newLines = lines(after);
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldEndExclusive = oldLines.length - suffix;
  const newEndExclusive = newLines.length - suffix;
  const oldCount = oldEndExclusive - prefix;
  const newCount = newEndExclusive - prefix;
  if (oldCount < 1 || newCount < 1 || oldCount > 25 || newCount > 50) {
    return null;
  }

  return {
    startLine: prefix + 1,
    endLine: oldEndExclusive,
    replacement: newLines.slice(prefix, newEndExclusive).join("\n"),
  };
}

/**
 * PR mode never broadens the original review diff. A verified source change is
 * offered as a suggestion only when every replaced right-side line belongs to
 * the PR patch; everything else remains an explicit CLI handoff.
 */
export function planPullRequestSuggestions(input: {
  groups: PublishInput["groups"];
  files: Array<z.infer<typeof filePatchSchema>>;
}): PullRequestSuggestionPlan {
  const files = z.array(filePatchSchema).max(300).parse(input.files);
  const fileMap = new Map(files.map(file => [file.path, file.patch]));
  const suggestions: PullRequestSuggestion[] = [];
  const cliHandoffs: PullRequestCliHandoff[] = [];

  for (const group of input.groups) {
    if (!group.perPatchAccepted) {
      throw new Error("PR suggestions require per-patch verified groups");
    }
    for (const change of group.changes) {
      if (!isSourcePath(change.path)) {
        throw new Error("PR suggestion path is outside source boundaries");
      }
      const patch = fileMap.get(change.path);
      const shape = replacementShape(change.before, change.after);
      if (!shape) {
        cliHandoffs.push({
          fixId: group.id,
          path: change.path,
          reason: "verified-change-has-unsupported-suggestion-shape",
        });
        continue;
      }
      if (patch === undefined || patch === null) {
        cliHandoffs.push({
          fixId: group.id,
          path: change.path,
          reason: "verified-change-outside-pr-diff",
        });
        continue;
      }
      const changed = parseRightSideChangedLines(patch);
      const anchored = Array.from(
        { length: shape.endLine - shape.startLine + 1 },
        (_, index) => shape.startLine + index,
      ).every(line => changed.has(line));
      if (!anchored) {
        cliHandoffs.push({
          fixId: group.id,
          path: change.path,
          reason: "verified-change-outside-pr-diff",
        });
        continue;
      }
      suggestions.push({
        fixId: group.id,
        path: change.path,
        ...shape,
      });
    }
  }

  return { suggestions, cliHandoffs };
}

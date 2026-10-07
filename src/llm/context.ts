import { Project, SyntaxKind } from "ts-morph";
import { defaults } from "../config.js";

export interface CallSiteContext {
  file: string;
  line: number;
  column: number;
  source: string;
}

export interface RepairContext {
  component: {
    file: string;
    line: number;
    column: number;
    sourceExcerpt: string;
  };
  callSites: CallSiteContext[];
  page: {
    title: string | null;
    surroundingText: string;
    caption: string | null;
    linkTarget: string | null;
  };
  screenshotPath: string | null;
}

export interface RepairContextInput {
  source: {
    file: string;
    line: number;
    column: number;
    text: string;
  };
  callSites: readonly CallSiteContext[];
  page: {
    title: string | null;
    surroundingText: string;
    caption: string | null;
    linkTarget: string | null;
  };
  screenshotPath: string | null;
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function sourceWindow(
  text: string,
  line: number,
  radius = 30,
  maxChars = 8_000,
): string {
  const lines = text.split("\n");
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return truncate(lines.slice(start, end).join("\n"), maxChars);
}

export function findComponentCallSites(
  files: Readonly<Record<string, string>>,
  componentName: string,
): CallSiteContext[] {
  if (componentName.trim().length === 0) {
    throw new Error("Component name must not be empty");
  }

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const results: CallSiteContext[] = [];

  for (const [file, text] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const sourceFile = project.createSourceFile(file, text, { overwrite: true });
    const nodes = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ];

    for (const node of nodes) {
      if (node.getTagNameNode().getText() !== componentName) continue;
      const position = sourceFile.getLineAndColumnAtPos(node.getStart());
      results.push({
        file,
        line: position.line,
        column: position.column,
        source: truncate(node.getText(), 2_000),
      });
    }
  }

  return results.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

export function buildRepairContext(input: RepairContextInput): RepairContext {
  if (
    !Number.isInteger(input.source.line) ||
    input.source.line < 1 ||
    !Number.isInteger(input.source.column) ||
    input.source.column < 1
  ) {
    throw new Error("Source coordinates must be positive integers");
  }

  const callSites = [...input.callSites]
    .slice(0, defaults.maxContextFiles)
    .map((item) => ({
      ...item,
      source: truncate(item.source, 2_000),
    }))
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.column - right.column,
    );

  const context: RepairContext = {
    component: {
      file: input.source.file,
      line: input.source.line,
      column: input.source.column,
      sourceExcerpt: sourceWindow(input.source.text, input.source.line),
    },
    callSites,
    page: {
      title: input.page.title === null ? null : truncate(input.page.title, 500),
      surroundingText: truncate(input.page.surroundingText, 4_000),
      caption:
        input.page.caption === null ? null : truncate(input.page.caption, 1_000),
      linkTarget:
        input.page.linkTarget === null
          ? null
          : truncate(input.page.linkTarget, 2_000),
    },
    screenshotPath: input.screenshotPath,
  };
  while (Buffer.byteLength(JSON.stringify(context)) > defaults.maxContextBytes && context.callSites.length > 0) context.callSites.pop();
  if (Buffer.byteLength(JSON.stringify(context)) > defaults.maxContextBytes) throw new Error("Deterministic context exceeds the aggregate byte limit");
  return context;
}

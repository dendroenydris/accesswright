import {
  Node,
  Project,
  SyntaxKind,
} from "ts-morph";
import type {
  JsxOpeningElement,
  JsxSelfClosingElement,
  SourceFile,
} from "ts-morph";

import { PatchSchema } from "../../types/schemas.js";
import type { FixTask, Patch, SourceLocation } from "../../types/schemas.js";

type JsxElementStart = JsxOpeningElement | JsxSelfClosingElement;

const validAriaAttributes = new Set([
  "aria-activedescendant",
  "aria-atomic",
  "aria-autocomplete",
  "aria-braillelabel",
  "aria-brailleroledescription",
  "aria-busy",
  "aria-checked",
  "aria-colcount",
  "aria-colindex",
  "aria-colindextext",
  "aria-colspan",
  "aria-controls",
  "aria-current",
  "aria-describedby",
  "aria-description",
  "aria-details",
  "aria-disabled",
  "aria-dropeffect",
  "aria-errormessage",
  "aria-expanded",
  "aria-flowto",
  "aria-grabbed",
  "aria-haspopup",
  "aria-hidden",
  "aria-invalid",
  "aria-keyshortcuts",
  "aria-label",
  "aria-labelledby",
  "aria-level",
  "aria-live",
  "aria-modal",
  "aria-multiline",
  "aria-multiselectable",
  "aria-orientation",
  "aria-owns",
  "aria-placeholder",
  "aria-posinset",
  "aria-pressed",
  "aria-readonly",
  "aria-relevant",
  "aria-required",
  "aria-roledescription",
  "aria-rowcount",
  "aria-rowindex",
  "aria-rowindextext",
  "aria-rowspan",
  "aria-selected",
  "aria-setsize",
  "aria-sort",
  "aria-valuemax",
  "aria-valuemin",
  "aria-valuenow",
  "aria-valuetext",
]);

function findElementAtSource(
  sourceFile: SourceFile,
  source: SourceLocation,
): JsxElementStart | null {
  const elements: JsxElementStart[] = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
  ];

  return (
    elements.find((element) => {
      const position = sourceFile.getLineAndColumnAtPos(element.getStart());
      return position.line === source.line && position.column === source.column;
    }) ?? null
  );
}

function removeInvalidAriaAttributes(element: JsxElementStart): boolean {
  const invalid = element
    .getAttributes()
    .filter(Node.isJsxAttribute)
    .filter((attribute) => {
      const name = attribute.getNameNode().getText().toLowerCase();
      return name.startsWith("aria-") && !validAriaAttributes.has(name);
    });

  if (invalid.length === 0) return false;

  for (const attribute of invalid.reverse()) {
    attribute.remove();
  }
  return true;
}

function positiveTabIndexLiteral(text: string): boolean {
  const jsxExpression = /^\{\s*([+-]?\d+)\s*\}$/.exec(text);
  const stringLiteral = /^["']([+-]?\d+)["']$/.exec(text);
  const raw = jsxExpression?.[1] ?? stringLiteral?.[1];
  if (raw === undefined) return false;

  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0;
}

function normalizePositiveTabIndex(element: JsxElementStart): boolean {
  const attribute = element
    .getAttributes()
    .filter(Node.isJsxAttribute)
    .find((candidate) => candidate.getNameNode().getText().toLowerCase() === "tabindex");

  if (attribute === undefined) return false;
  const initializer = attribute.getInitializer();
  if (initializer === undefined || !positiveTabIndexLiteral(initializer.getText())) {
    return false;
  }

  attribute.setInitializer("{0}");
  return true;
}

export function applyCodemod(
  sourceText: string,
  task: FixTask,
): Patch | null {
  if (task.route !== "codemod" || task.source === null) return null;

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const sourceFile = project.createSourceFile(task.source.file, sourceText, {
    overwrite: true,
  });
  const element = findElementAtSource(sourceFile, task.source);
  if (element === null) return null;

  let changed = false;
  if (task.ruleId === "aria-valid-attr") {
    changed = removeInvalidAriaAttributes(element);
  } else if (task.ruleId === "tabindex") {
    changed = normalizePositiveTabIndex(element);
  }

  if (!changed) return null;

  const after = sourceFile.getFullText();
  if (after === sourceText) return null;

  return PatchSchema.parse({
    taskId: task.id,
    changes: [
      {
        path: task.source.file,
        before: sourceText,
        after,
      },
    ],
  });
}

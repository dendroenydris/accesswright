import { Project, SyntaxKind } from "ts-morph";
import type {
  JsxOpeningElement,
  JsxSelfClosingElement,
  SourceFile,
} from "ts-morph";

import { PatchSchema } from "../types/schemas.js";
import type { FixTask, Patch, SourceLocation } from "../types/schemas.js";
import type { BrowserObservation } from "../scanner/observations.js";

type JsxElementStart = JsxOpeningElement | JsxSelfClosingElement;

export interface HeadingOrderDecision {
  patch: Patch | null;
  reason: string | null;
}

function findElementAtSource(
  sourceFile: SourceFile,
  source: SourceLocation,
): JsxElementStart | null {
  const elements: JsxElementStart[] = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
  ];
  return (
    elements.find(element => {
      const position = sourceFile.getLineAndColumnAtPos(element.getStart());
      return position.line === source.line && position.column === source.column;
    }) ?? null
  );
}

function tagLevel(tagName: string): number | null {
  const match = /^h([1-6])$/i.exec(tagName);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function applyHeadingOrderFix(
  sourceText: string,
  task: FixTask,
  observations: readonly BrowserObservation[],
): HeadingOrderDecision {
  const defer = (reason: string): HeadingOrderDecision => ({
    patch: null,
    reason,
  });
  if (
    task.ruleId !== "heading-order" ||
    task.route !== "codemod" ||
    task.source === null
  ) {
    return defer("not-a-heading-order-task");
  }
  const source = task.source;

  const matchesTaskContext = (
    observation: BrowserObservation,
    directOnly: boolean,
  ) =>
    observation.contexts.find(context =>
      (!directOnly || context.mapping === "direct") &&
      context.source?.file === source.file &&
      context.source?.line === source.line &&
      context.source?.column === source.column &&
      task.violations.some(
        violation =>
          JSON.stringify(violation.target) === JSON.stringify(context.target),
      ),
    );

  const page = observations.find(observation =>
    observation.condition === "desktop-light" &&
    task.routes.includes(observation.route) &&
    matchesTaskContext(observation, true) !== undefined,
  );
  if (!page) return defer("heading-source-is-not-direct");

  const context = matchesTaskContext(page, true);
  if (!context?.nodeId) return defer("heading-browser-identity-unavailable");

  const currentIndex = page.aria.findIndex(node => node.id === context.nodeId);
  if (currentIndex < 0) return defer("heading-browser-identity-unavailable");
  const current = page.aria[currentIndex];
  if (current?.headingLevel === undefined) {
    return defer("target-is-not-a-rendered-heading");
  }

  let previousLevel: number | undefined;
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const level = page.aria[index]?.headingLevel;
    if (level !== undefined) {
      previousLevel = level;
      break;
    }
  }
  if (previousLevel === undefined) return defer("no-previous-rendered-heading");
  const desired = Math.min(6, previousLevel + 1);
  if (current.headingLevel <= desired) {
    return defer("rendered-heading-order-already-valid");
  }

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const file = project.createSourceFile(source.file, sourceText, {
    overwrite: true,
  });
  const element = findElementAtSource(file, source);
  if (!element) return defer("heading-source-element-not-found");

  const sourceLevel = tagLevel(element.getTagNameNode().getText());
  if (sourceLevel === null || sourceLevel !== current.headingLevel) {
    return defer("dynamic-or-mismatched-heading-source-needs-review");
  }

  const nextTag = `h${desired}`;
  element.getTagNameNode().replaceWithText(nextTag);
  if (element.getKind() === SyntaxKind.JsxOpeningElement) {
    const jsx = element.getParentIfKind(SyntaxKind.JsxElement);
    const closing = jsx?.getClosingElement();
    if (!closing) return defer("heading-closing-element-unavailable");
    closing.getTagNameNode().replaceWithText(nextTag);
  }

  const after = file.getFullText();
  if (after === sourceText) return defer("no-source-change");
  return {
    patch: PatchSchema.parse({
      taskId: task.id,
      changes: [{ path: source.file, before: sourceText, after }],
    }),
    reason: null,
  };
}

import { Node, Project, SyntaxKind } from "ts-morph";
import type {
  JsxOpeningElement,
  JsxSelfClosingElement,
  SourceFile,
} from "ts-morph";

import { optimizeContrast } from "./contrast.js";
import { PatchSchema } from "../types/schemas.js";
import type { FixTask, Patch, SourceLocation } from "../types/schemas.js";

type JsxElementStart = JsxOpeningElement | JsxSelfClosingElement;

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

function inlineLiteralColors(
  element: JsxElementStart,
): {
  foreground: string;
  background: string;
  setForeground: (value: string) => void;
} | null {
  const style = element
    .getAttributes()
    .filter(Node.isJsxAttribute)
    .find((attribute) => attribute.getNameNode().getText() === "style");
  if (style === undefined) return null;

  const initializer = style.getInitializer();
  if (!Node.isJsxExpression(initializer)) return null;
  const expression = initializer.getExpression();
  if (!Node.isObjectLiteralExpression(expression)) return null;

  const foregroundProperty = expression.getProperty("color");
  const backgroundProperty =
    expression.getProperty("backgroundColor") ??
    expression.getProperty("background");

  if (
    !Node.isPropertyAssignment(foregroundProperty) ||
    !Node.isPropertyAssignment(backgroundProperty)
  ) {
    return null;
  }

  const foregroundInitializer = foregroundProperty.getInitializer();
  const backgroundInitializer = backgroundProperty.getInitializer();
  if (
    !Node.isStringLiteral(foregroundInitializer) ||
    !Node.isStringLiteral(backgroundInitializer)
  ) {
    return null;
  }

  return {
    foreground: foregroundInitializer.getLiteralValue(),
    background: backgroundInitializer.getLiteralValue(),
    setForeground: (value: string) => {
      foregroundProperty.setInitializer(JSON.stringify(value));
    },
  };
}

export function applyInlineContrastFix(
  sourceText: string,
  task: FixTask,
): Patch | null {
  if (
    task.route !== "optimizer" ||
    task.ruleId !== "color-contrast" ||
    task.source === null
  ) {
    return null;
  }

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
  });
  const sourceFile = project.createSourceFile(task.source.file, sourceText, {
    overwrite: true,
  });
  const element = findElementAtSource(sourceFile, task.source);
  if (element === null) return null;

  const colors = inlineLiteralColors(element);
  if (colors === null) return null;

  const optimized = optimizeContrast(colors.foreground, colors.background, 4.5);
  if (
    optimized === null ||
    optimized.color.toLowerCase() === colors.foreground.toLowerCase()
  ) {
    return null;
  }

  colors.setForeground(optimized.color);
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

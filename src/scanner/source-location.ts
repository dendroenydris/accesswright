export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

function readAttribute(html: string, name: string): string | null {
  const match = new RegExp("\\b" + name + "=(?:\\\"([^\\\"]*)\\\"|'([^']*)')").exec(html);
  return match?.[1] ?? match?.[2] ?? null;
}

function normalizeFile(file: string): string {
  return file.startsWith("/workspace/") ? file.slice("/workspace/".length) : file;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function extractSourceLocationFromHtml(html: string): SourceLocation | null {
  return extractSourceLocationFromAttributes(readAttribute(html, "data-insp-path"), readAttribute(html, "data-insp-row"), readAttribute(html, "data-insp-col"));
}

export function extractSourceLocationFromAttributes(file: string | null, row: string | null, column: string | null): SourceLocation | null {
  if (file === null) return null;

  const combined = /^(.*):(\d+):(\d+):[^:]+$/.exec(file);
  if (combined?.[1] !== undefined && combined[2] !== undefined && combined[3] !== undefined) {
    const line = parsePositiveInteger(combined[2]);
    const column = parsePositiveInteger(combined[3]);
    if (line !== null && column !== null) {
      return { file: normalizeFile(combined[1]), line, column };
    }
  }

  if (row === null || column === null) return null;

  const line = parsePositiveInteger(row);
  const parsedColumn = parsePositiveInteger(column);
  if (line === null || parsedColumn === null) return null;

  return { file: normalizeFile(file), line, column: parsedColumn };
}

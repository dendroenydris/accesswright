import { describe, expect, it } from "vitest";

import { extractSourceLocationFromHtml } from "../../src/scanner/source-location.js";

describe("extractSourceLocationFromHtml", () => {
  it("parses the current code-inspector combined path format", () => {
    expect(
      extractSourceLocationFromHtml(
        '<button data-insp-path="/workspace/app/page.tsx:6:7:button"></button>',
      ),
    ).toEqual({ file: "app/page.tsx", line: 6, column: 7 });
  });

  it("normalizes code-inspector path/row/col attributes", () => {
    expect(
      extractSourceLocationFromHtml(
        '<button data-insp-path="app/page.tsx" data-insp-row="6" data-insp-col="7"></button>',
      ),
    ).toEqual({ file: "app/page.tsx", line: 6, column: 7 });
  });

  it("accepts attributes in any order and single quotes", () => {
    expect(
      extractSourceLocationFromHtml(
        "<img data-insp-col='12' src='x' data-insp-path='pages/index.tsx' data-insp-row='5'>",
      ),
    ).toEqual({ file: "pages/index.tsx", line: 5, column: 12 });
  });

  it("returns null when source attributes are incomplete", () => {
    expect(extractSourceLocationFromHtml('<button data-insp-path="app/page.tsx"></button>')).toBeNull();
  });

  it("keeps colons inside the file path while parsing from the right", () => {
    expect(
      extractSourceLocationFromHtml(
        '<div data-insp-path="/workspace/app/(group):name/page.tsx:12:4:div"></div>',
      ),
    ).toEqual({ file: "app/(group):name/page.tsx", line: 12, column: 4 });
  });
});

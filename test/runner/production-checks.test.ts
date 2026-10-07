import { describe, expect, it } from "vitest";
import { productionCheckPlan, checkFailureIds } from "../../src/runner/production-checks.js";

describe("production check planning and evidence", () => {
  it("requires a real build and discovers existing lint/typecheck/test scripts", () => {
    expect(productionCheckPlan({ scripts: { build: "next build", typecheck: "tsc", lint: "eslint .", test: "vitest run" } }, true)).toEqual([
      { check: "build", argv: ["npm", "run", "build"], available: true },
      { check: "typecheck", argv: ["npm", "run", "typecheck"], available: true },
      { check: "lint", argv: ["npm", "run", "lint"], available: true },
      { check: "tests", argv: ["npm", "test", "--", "--run"], available: true },
    ]);
  });
  it("marks absent checks unavailable rather than manufacturing a green result", () => {
    const plan = productionCheckPlan({ scripts: { build: "next build" } }, false);
    expect(plan.filter(item => !item.available).map(item => item.check)).toEqual(["typecheck", "lint", "tests"]);
    expect(() => productionCheckPlan({}, false)).toThrow(/build/i);
  });
  it("uses an installed tsc when there is no typecheck script", () => {
    expect(productionCheckPlan({ scripts: { build: "next build", test: "node --test" } }, true)).toContainEqual({ check: "typecheck", argv: ["node_modules/.bin/tsc", "--noEmit"], available: true });
  });
  it("normalizes locations without collapsing unrelated failures into one exit code", () => {
    const a=checkFailureIds("build",1,"/workspace/app/page.tsx:3:4 error TS2322: Type number is not assignable to string.");
    const b=checkFailureIds("build",1,"/workspace/app/page.tsx:30:4 error TS2322: Type number is not assignable to string.");
    const c=checkFailureIds("build",1,"/workspace/app/page.tsx:3:4 error TS2307: Cannot find module missing.");
    expect(a).toEqual(b); expect(a).not.toEqual(c); expect(checkFailureIds("build",0,"noise")).toEqual([]);
  });
});

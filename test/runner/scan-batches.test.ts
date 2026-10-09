import { expect, it } from "vitest";
import { partitionRouteScans, validateRouteScanChunk } from "../../src/runner/scan-batches.js";

it("partitions all routes into bounded deterministic chunks without loss or reordering", () => {
  const routes = Array.from({ length: 17 }, (_, index) => "/route-" + index);
  const chunks = partitionRouteScans(routes, 6);
  expect(chunks.map(chunk => chunk.length)).toEqual([6, 6, 5]);
  expect(chunks.flat()).toEqual(routes);
  expect(() => partitionRouteScans(["/", "/"], 6)).toThrow(/duplicate/i);
  expect(() => partitionRouteScans(["/"], 0)).toThrow(/limit|size/i);
});

it("fails closed when any requested route/viewport observation is missing or duplicated", () => {
  const make = (route: string, condition: "desktop-light" | "mobile-light") => ({ route, condition });
  expect(() => validateRouteScanChunk(["/", "/help"], [
    make("/", "desktop-light"), make("/", "mobile-light"),
    make("/help", "desktop-light"), make("/help", "mobile-light"),
  ], true)).not.toThrow();
  expect(() => validateRouteScanChunk(["/"], [make("/", "desktop-light")], true)).toThrow(/mobile/i);
  expect(() => validateRouteScanChunk(["/"], [make("/", "desktop-light"), make("/", "desktop-light")], false)).toThrow(/duplicate/i);
  expect(() => validateRouteScanChunk(["/"], [make("/help", "desktop-light")], false)).toThrow(/route/i);
});

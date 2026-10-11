import { expect, it } from "vitest";
import { actionFailureMessage } from "../../src/action.js";

it("reports a whitelisted HTTP status without exposing response bodies or credentials", () => {
  expect(actionFailureMessage(new Error("GitHub POST failed with HTTP 403"))).toContain("HTTP 403");
  const message = actionFailureMessage(new Error("Authorization secret fixture: private response body"));
  expect(message).toContain("diagnostic");
  expect(message).not.toContain("private response");
  expect(message).not.toContain("secret fixture");
});

it("identifies an unattributable repair branch while keeping other error text private", () => {
  expect(actionFailureMessage(new Error("An unowned orphan branch was preserved"))).toContain("An unowned orphan branch was preserved");
  expect(actionFailureMessage(new Error("An unowned orphan branch was preserved: fixture-secret"))).not.toMatch(/orphan|fixture-secret/);
});

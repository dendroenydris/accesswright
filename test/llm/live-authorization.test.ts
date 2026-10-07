import { expect, it } from "vitest";
import { parseLiveAuthorization } from "../helpers/live-authorization.js";

const authorization = { model: "gpt-6-luna", reasoningEffort: "high", verifiedAt: "2026-10-07T06:00:00Z", expiresAt: "2026-10-08T00:00:00Z", maxInputTokens: 1050000,
  pricing: { inputUsdPerMillion: 0.275, outputUsdPerMillion: 0.825 }, costBasis: "conservative-token-price-upper-bound", ledgerPath: "/tmp/operator-owned-spend.json", maxRunCostUsd: 0.1,
  pricingSource: "https://developers.openai.com/api/docs/models/gpt-6-luna", authenticatedModel: true };

it("requires exact authenticated design model and a non-expired priced authorization", () => {
  const now = Date.parse("2026-10-07T07:00:00Z");
  expect(parseLiveAuthorization(authorization, now).model).toBe("gpt-6-luna");
  expect(() => parseLiveAuthorization({ ...authorization, model: "gpt-5.6-luna" }, now)).toThrow();
  expect(() => parseLiveAuthorization({ ...authorization, authenticatedModel: false }, now)).toThrow();
  expect(() => parseLiveAuthorization(authorization, Date.parse("2026-10-08T01:00:00Z"))).toThrow(/expired/);
  expect(() => parseLiveAuthorization({ ...authorization, pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } }, now)).toThrow();
  expect(() => parseLiveAuthorization({ ...authorization, ledgerPath: "relative-spend.json" }, now)).toThrow();
});

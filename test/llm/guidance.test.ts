import { describe, expect, it } from "vitest";

import {
  getRepairGuidance,
  llmGuidanceRuleIds,
} from "../../src/llm/guidance.js";
import { getRuleDefinition } from "../../src/planner/rules.js";

describe("LLM repair guidance", () => {
  it("covers every P0 rule routed to the LLM", () => {
    const llmRules = [
      "image-alt",
      "label",
      "button-name",
      "link-name",
      "document-title",
      "html-has-lang",
    ].filter((ruleId) => getRuleDefinition(ruleId).route === "llm");

    expect([...llmGuidanceRuleIds].sort()).toEqual(llmRules.sort());
    for (const ruleId of llmRules) {
      expect(getRepairGuidance(ruleId).length).toBeGreaterThan(20);
    }
  });

  it("fails closed for unknown or non-LLM rules", () => {
    expect(() => getRepairGuidance("unknown-rule")).toThrow(/guidance/i);
    expect(() => getRepairGuidance("aria-valid-attr")).toThrow(/guidance/i);
  });

  it("keeps semantic guidance explicit about not inventing meaning", () => {
    expect(getRepairGuidance("image-alt")).toMatch(/context|decorative/i);
    expect(getRepairGuidance("button-name")).toMatch(/purpose|action/i);
    expect(getRepairGuidance("html-has-lang")).toMatch(/evidence|language/i);
  });
});

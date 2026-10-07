import type { FixKind, FixRoute } from "../types/schemas.js";
import { criterionReference } from "./references.js";

export interface RuleDefinition {
  ruleId: string;
  criterion: string;
  kind: FixKind;
  route: FixRoute;
  codemod?: "remove-invalid-aria" | "normalize-tabindex";
  ariaPermissions: {
    allowRoleChange: boolean;
    allowHeadingLevelChange: boolean;
    allowDecorativeHide: boolean;
  };
}

const strictAriaPermissions = {
  allowRoleChange: false,
  allowHeadingLevelChange: false,
  allowDecorativeHide: false,
} as const;

const rules: Readonly<Record<string, RuleDefinition>> = {
  "aria-valid-attr": {
    ruleId: "aria-valid-attr",
    criterion: "4.1.2",
    kind: "syntactic",
    route: "codemod",
    codemod: "remove-invalid-aria",
    ariaPermissions: strictAriaPermissions,
  },
  tabindex: {
    ruleId: "tabindex",
    criterion: "2.4.3",
    kind: "syntactic",
    route: "codemod",
    codemod: "normalize-tabindex",
    ariaPermissions: strictAriaPermissions,
  },
  "color-contrast": {
    ruleId: "color-contrast",
    criterion: "1.4.3",
    kind: "layout",
    route: "optimizer",
    ariaPermissions: strictAriaPermissions,
  },
  "image-alt": {
    ruleId: "image-alt",
    criterion: "1.1.1",
    kind: "semantic",
    route: "llm",
    ariaPermissions: strictAriaPermissions,
  },
  label: {
    ruleId: "label",
    criterion: "1.3.1",
    kind: "semantic",
    route: "llm",
    ariaPermissions: strictAriaPermissions,
  },
  "button-name": {
    ruleId: "button-name",
    criterion: "4.1.2",
    kind: "semantic",
    route: "llm",
    ariaPermissions: strictAriaPermissions,
  },
  "link-name": {
    ruleId: "link-name",
    criterion: "4.1.2",
    kind: "semantic",
    route: "llm",
    ariaPermissions: strictAriaPermissions,
  },
  "document-title": {
    ruleId: "document-title",
    criterion: "2.4.2",
    kind: "semantic",
    route: "llm",
    ariaPermissions: strictAriaPermissions,
  },
  "html-has-lang": {
    ruleId: "html-has-lang",
    criterion: "3.1.1",
    kind: "semantic",
    route: "llm",
    ariaPermissions: strictAriaPermissions,
  },
  "target-size": {
    ruleId: "target-size", criterion: "2.5.8", kind: "layout", route: "human", ariaPermissions: strictAriaPermissions,
  },
  "landmark-unique": {
    ruleId: "landmark-unique",
    criterion: "1.3.1",
    kind: "global",
    route: "human",
    ariaPermissions: {
      ...strictAriaPermissions,
      allowRoleChange: true,
    },
  },
  "heading-order": {
    ruleId: "heading-order",
    criterion: "1.3.1",
    kind: "global",
    route: "human",
    ariaPermissions: {
      ...strictAriaPermissions,
      allowHeadingLevelChange: true,
    },
  },
};

const unknownRule: RuleDefinition = {
  ruleId: "unknown",
  criterion: "unknown",
  kind: "human",
  route: "human",
  ariaPermissions: strictAriaPermissions,
};

export function getRuleDefinition(ruleId: string): RuleDefinition & { en301549: string | null; referenceEdition: string } {
  const definition = rules[ruleId] ?? { ...unknownRule, ruleId };
  const reference = criterionReference(definition.criterion);
  return { ...definition, en301549: reference.en301549, referenceEdition: reference.edition };
}

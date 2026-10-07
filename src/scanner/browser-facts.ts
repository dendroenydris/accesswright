import { z } from "zod";
import type { AccessibleNodeFact } from "../verifier/per-patch.js";

export const ScanConditionSchema = z.enum(["desktop-light", "mobile-light", "desktop-dark"]);
export type ScanCondition = z.infer<typeof ScanConditionSchema>;

export interface BrowserDomFact {
  marker: string;
  id: string;
  text: string;
  visible: boolean;
  ariaHidden: boolean;
  nativeInteractive: boolean;
  disabled: boolean;
  protectedContent: boolean;
}

export interface BrowserAxFact {
  ignored: boolean;
  role: string;
  name: string;
  focusable: boolean;
  headingLevel?: number;
}

const interactiveRoles = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "option"]);

export function mergeBrowserFacts(
  dom: readonly BrowserDomFact[],
  accessibility: Readonly<Record<string, BrowserAxFact>>,
): AccessibleNodeFact[] {
  return dom.filter(node => node.visible && !node.ariaHidden).map(node => {
    const ax = accessibility[node.marker];
    const role = ax === undefined || ax.ignored ? "generic" : ax.role;
    return {
      id: node.id,
      role,
      name: ax === undefined || ax.ignored ? "" : ax.name,
      text: node.text,
      interactive: !node.disabled && (node.nativeInteractive || ax?.focusable === true || interactiveRoles.has(role)),
      protectedContent: node.protectedContent,
      ...(ax?.headingLevel === undefined ? {} : { headingLevel: ax.headingLevel }),
    };
  });
}

export function scanConditions(options: { mobile: boolean; darkScheme: boolean }): ScanCondition[] {
  return ["desktop-light", ...(options.mobile ? ["mobile-light" as const] : []), ...(options.darkScheme ? ["desktop-dark" as const] : [])];
}

export function violationKey(violation: { ruleId: string; route: string; target: readonly string[]; condition?: string }): string {
  return [violation.ruleId, violation.route, violation.condition ?? "desktop-light", violation.target.join(" >> ")].join("|");
}

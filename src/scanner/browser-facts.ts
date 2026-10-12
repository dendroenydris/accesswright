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

// Libraries such as react-medium-image-zoom put a fresh random hex token into ids on every page load, so the same
// element gets a new selector per scan. Masking keeps its identity stable (a target that merely changed its random id
// is not "resolved"); verifiers compare masked identities as multisets. User-approved verifier change, 2026-10-12.
// ponytail: hex-token heuristic; learn volatile selector tokens from repeated baseline scans if other id schemes appear.
// Random hex can be all digits (mk965 "rmiz-modal-117890541168"), so only a digit is required.
const volatileSelectorToken = /(?<![0-9a-z])(?=[0-9a-f]*\d)[0-9a-f]{8,}(?![0-9a-z])/gi;

export function violationKey(violation: { ruleId: string; route: string; target: readonly string[]; condition?: string }): string {
  const target = violation.target.join(" >> ").replace(volatileSelectorToken, "<volatile>");
  return [violation.ruleId, violation.route, violation.condition ?? "desktop-light", target].join("|");
}

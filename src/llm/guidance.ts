const guidance: Readonly<Record<string, string>> = {
  "image-alt":
    "Describe the image from the page context, caption, surrounding text, and link destination. Keep informative alt text concise and accurate. Use empty alt only when the image is genuinely decorative and contributes no content or action.",
  label:
    "Give the form control an accessible label that reflects the field's actual purpose. Prefer an existing visible label or explicit nearby wording. Do not invent a value, requirement, or business meaning that is not supported by the source context.",
  "button-name":
    "Give the button an accessible name that states its actual action or purpose. Reuse visible text, icon semantics, or nearby source context when available. Do not invent an action that the component or call site does not support.",
  "link-name":
    "Give the link an accessible name that identifies its destination or purpose. Prefer existing link text, destination context, or an informative linked image description. Do not add claims that are not supported by the href or surrounding content.",
  "document-title":
    "Provide a concise document title supported by the page's existing heading and content. Do not invent a product, organization, or page purpose that is not evidenced in the source.",
  "html-has-lang":
    "Set the document language only when there is evidence for the language in the repository or page content. Do not guess a default language from locale, developer location, or framework defaults when the source does not establish it.",
};

export const llmGuidanceRuleIds = Object.freeze(Object.keys(guidance));

export function getRepairGuidance(ruleId: string): string {
  const value = guidance[ruleId];
  if (value === undefined) {
    throw new Error(`No LLM repair guidance is defined for rule: ${ruleId}`);
  }
  return value;
}

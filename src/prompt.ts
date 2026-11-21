/**
 * Build the optimizer request. The output contract deliberately overrides the
 * skill's "Step 5 — Deliver" section, which normally asks for a fenced prompt
 * plus explanation. The plugin needs only the rewritten prompt text.
 */
export function buildPrompt(skill: string, original: string): string {
  return [
    "You are a prompt optimizer. Apply the skill instructions below to the user's prompt.",
    "",
    "<skill-instructions>",
    skill,
    "</skill-instructions>",
    "",
    "<output-contract>",
    "The output contract below overrides the skill's 'Step 5 - Deliver' section.",
    "Return ONLY the optimized prompt as plain text.",
    "No code fences, no Markdown headings, no explanation, no preamble, no questions, no bullet lists.",
    "Preserve the user's intent, language, @mentions, and {{PLACEHOLDERS}} verbatim where they matter.",
    "Do not change the task or add constraints the user did not imply.",
    "If the original prompt is already effective, return it essentially unchanged.",
    "</output-contract>",
    "",
    "<user-prompt-to-optimize>",
    original,
    "</user-prompt-to-optimize>",
  ].join("\n")
}

/** Trim the model output and unwrap a single surrounding Markdown fence. */
export function sanitize(text: string | undefined | null): string {
  if (!text) return ""
  let result = text.trim()
  const fenced = result.match(/^```[^\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/)
  if (fenced) result = fenced[1]!.trim()
  return result
}

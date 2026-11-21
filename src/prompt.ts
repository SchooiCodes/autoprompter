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

const REASONING_TAG = "(?:think|thinking|reasoning|analysis|ernie:think)"

/**
 * Some free models leak their reasoning markers into the answer (for example
 * `answer</ernie:think>answer`). Keep only the actual answer.
 */
export function stripReasoning(text: string): string {
  const closeRe = new RegExp(`</\\s*${REASONING_TAG}\\s*>`, "gi")
  const openRe = new RegExp(`<\\s*${REASONING_TAG}\\b[^>]*>`, "gi")

  let lastClose: RegExpExecArray | null = null
  let match: RegExpExecArray | null
  while ((match = closeRe.exec(text)) !== null) lastClose = match
  if (lastClose) {
    const after = text.slice(lastClose.index + lastClose[0].length).trim()
    if (after) return after
  }

  const firstOpen = openRe.exec(text)
  if (firstOpen) {
    const before = text.slice(0, firstOpen.index).trim()
    if (before) return before
  }

  return text
    .replace(new RegExp(`<\\s*${REASONING_TAG}\\b[^>]*>[\\s\\S]*?</\\s*${REASONING_TAG}\\s*>`, "gi"), "")
    .replace(closeRe, "")
    .replace(openRe, "")
    .trim()
}

/** Trim the model output, strip reasoning leakage, and unwrap a single fence. */
export function sanitize(text: string | undefined | null): string {
  if (!text) return ""
  let result = text.trim()
  const fenced = result.match(/^```[^\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/)
  if (fenced) result = fenced[1]!.trim()
  return stripReasoning(result)
}

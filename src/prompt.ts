/**
 * Build the optimizer request. The output contract deliberately overrides the
 * skill's "Step 5 — Deliver" section. We also reconcile the prompt-design
 * skill's ask-first guardrail: if the task is genuinely undefined, the model
 * must emit the sentinel instead of inventing a rewrite, and the plugin fails
 * open.
 */
export const CLARIFICATION_SENTINEL = "AUTOPROMPTER_NEEDS_CLARIFICATION"

export function buildPrompt(skill: string, original: string): string {
  return [
    "You are a prompt optimizer. Apply the skill instructions below to the user's prompt.",
    "",
    "<operator-instructions>",
    "OPERATOR PRECEDENCE: these instructions override the skill's defaults.",
    "Classification: this is a one-shot prompt rewrite, not an agentic loop.",
    "TARGET & DELIVERY: the target is the user's current OpenCode session model in one-shot chat; the optimizer has no tools and no file access. Deliver the rewrite as plain text, which the plugin inserts directly into the user's message.",
    "MATERIAL: the artifact to refine is the entire text inside <user-prompt-to-optimize>. There are no neighboring artifacts.",
    "OBJECTIVE: make that prompt clear, specific, and reliably produce what the user asked for. The deliverable expected now is only the rewritten prompt text.",
    "You have all three requirements, so do not ask the operator for them. However, if the task itself is genuinely undefined and you cannot rewrite it without inventing details, output exactly the token " +
      CLARIFICATION_SENTINEL +
      " and nothing else. The plugin will then leave the user's prompt unchanged. Otherwise do not emit [ASSUMPTION] notes, skipped-scaffold lists, or any scaffolding.",
    "</operator-instructions>",
    "",
    "<skill-instructions>",
    skill,
    "</skill-instructions>",
    "",
    "<output-contract>",
    "The <operator-instructions> block satisfies the skill's three requirements before you commit.",
    "This output contract overrides the skill's 'Step 5 - Deliver' section.",
    "Return ONLY the optimized prompt as plain text.",
    "No code fences, no Markdown headings, no explanation, no preamble, no questions, no bullet lists.",
    "Preserve the user's intent, language, @mentions, and {{PLACEHOLDERS}} verbatim where they matter. Never invent new {{PLACEHOLDERS}}.",
    "Do not change the task or add constraints the user did not imply.",
    "If the original prompt is already effective, return it essentially unchanged.",
    "If you must decline, output only " + CLARIFICATION_SENTINEL + ".",
    "</output-contract>",
    "",
    "<user-prompt-to-optimize>",
    original,
    "</user-prompt-to-optimize>",
  ].join("\n")
}

const REASONING_TAG = "(?:think|thinking|reasoning|analysis|ernie:think)"

/**
 * Some free models leak reasoning markers (`answer</ernie:think>answer`).
 * Remove the markers and any complete reasoning block, but keep every piece
 * of real answer text — including text between multiple close tags.
 */
export function stripReasoning(text: string): string {
  const closeRe = new RegExp(`</\\s*${REASONING_TAG}\\s*>`, "gi")
  const openRe = new RegExp(`<\\s*${REASONING_TAG}\\b[^>]*>`, "gi")
  const blockRe = new RegExp(
    `<\\s*${REASONING_TAG}\\b[^>]*>[\\s\\S]*?</\\s*${REASONING_TAG}\\s*>`,
    "gi",
  )

  // Drop complete `<think>...</think>` blocks first so the reasoning itself
  // never survives into the answer.
  const withoutBlocks = text.replace(blockRe, "")
  // Split on stray close tags, keep every real segment, then collapse the
  // adjacent duplicates that models emit around a leaked close tag.
  const parts = withoutBlocks
    .split(closeRe)
    .map((part) => part.replace(openRe, "").trim())
    .filter(Boolean)
  const deduped: string[] = []
  for (const part of parts) {
    if (deduped[deduped.length - 1] !== part) deduped.push(part)
  }
  return deduped.join("")
}

function isWholeFence(text: string): boolean {
  return /^```[^\n]*\r?\n[\s\S]*?\r?\n[ \t]*```[ \t]*$/.test(text)
}

/** Extract the first fenced block with surrounding prose (e.g. skill Step 5). */
function extractFenced(text: string): string | null {
  const re = /```[^\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const inner = match[1]!.trim()
    if (inner) return inner
  }
  return null
}

/**
 * Trim the model output, strip reasoning leakage, and unwrap fenced output.
 * When the ORIGINAL prompt was itself a single fenced block, keep its format.
 */
export function sanitize(text: string | undefined | null, original?: string): string {
  if (!text) return ""
  let result = text.trim()
  if (!(original && isWholeFence(original.trim()))) {
    if (isWholeFence(result)) {
      const inner = extractFenced(result)
      if (inner !== null) result = inner
    } else {
      const fenced = extractFenced(result)
      if (fenced !== null) result = fenced
    }
  }
  return stripReasoning(result)
}

/** Reject optimizer output that is not a faithful rewrite of the original. */
export function isRejectedRewrite(text: string, original: string): boolean {
  if (!text.trim()) return true
  const value = text.trim()
  if (value.toUpperCase().includes(CLARIFICATION_SENTINEL)) return true
  if (/[?]\s*$/.test(value)) return true
  if (/^(?:before i|which |what |why |how |do you |could you |can you |please (?:provide|specify|tell|clarify)|i need|i ?'ll need)\b/i.test(value)) return true
  if (/^(?:sure|certainly|here(?:'s| is)|okay|ok)[,!:]/i.test(value)) return true
  if (/^(?:changed|changes|notes?|explanation|summary|assumptions?)\s*:/im.test(value)) return true
  if (/here(?:'s| is) (?:why|what|the)/i.test(value)) return true
  if (/^\s*[-*]\s+\S/m.test(value)) return true
  const existing = new Set(
    [...original.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]!.toLowerCase()),
  )
  const invented = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].some(
    (m) => !existing.has(m[1]!.toLowerCase()),
  )
  return invented
}

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const FILES = [
  "SKILL.md",
  "references/prompt-engineering-guide.md",
  "references/optimization-playbook.md",
]

/**
 * Load the prompt-optimizer skill as a single text block. By default the copy
 * bundled with the plugin is used; `skillPath` can point at a live skill folder.
 */
export async function loadSkill(skillPath?: string): Promise<string> {
  const base = skillPath
    ? path.resolve(skillPath)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skill")

  const parts: string[] = []
  for (const relative of FILES) {
    try {
      const content = await readFile(path.join(base, relative), "utf8")
      parts.push(`## Source: ${relative}\n\n${content.trim()}`)
    } catch (error) {
      if (relative === "SKILL.md") {
        throw new Error(`[autoprompter] cannot read required skill file: ${path.join(base, relative)}`, { cause: error })
      }
      console.warn(`[autoprompter] could not read optional skill reference ${relative}:`, error)
    }
  }
  return parts.join("\n\n")
}

import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Load a skill as a single text block: SKILL.md plus every Markdown reference
 * found in its `references/` folder. By default the copy bundled with the
 * plugin is used; `skillPath` can point at any other skill folder (e.g. one
 * extracted from a newer zip), so reference filenames are discovered at
 * runtime rather than hardcoded to one skill's layout.
 */
export async function loadSkill(skillPath?: string): Promise<string> {
  const base = skillPath
    ? path.resolve(skillPath)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skill")

  const references: string[] = []
  try {
    const entries = await readdir(path.join(base, "references"), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        references.push(`references/${entry.name}`)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[autoprompter] could not list skill references:", error)
    }
  }
  references.sort()

  const parts: string[] = []
  for (const relative of ["SKILL.md", ...references]) {
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

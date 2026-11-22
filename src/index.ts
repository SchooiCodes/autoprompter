import { Plugin } from "@opencode/plugin"
import {
  DEFAULT_MAX_CANDIDATES,
  discoverFreeModels,
  rankCandidates,
  type ModelListResult,
  type ModelRef,
} from "./model.js"
import { loadSkill } from "./skill.js"
import { buildPrompt, isRejectedRewrite, sanitize } from "./prompt.js"

type Options = {
  enabled?: boolean
  skillPath?: string
  model?: ModelRef
  excludePrefixes?: string[]
  timeoutMs?: number
  maxCandidates?: number
  /** Show the optimized text in the message instead of the text you typed. */
  showOptimized?: boolean
  log?: boolean
}

type PromptFile = { mention?: unknown }
type PromptEvent = {
  /** Present at runtime: the model the session is using for this prompt. */
  model?: ModelRef
  prompt: {
    text: string
    files?: readonly PromptFile[]
  }
  metadata?: {
    displayText?: string
    [key: string]: unknown
  }
}
type GenerateResult = { text: string }
type Registration = { dispose(): Promise<void> | void }

/**
 * A leading `!` is an OpenCode shell escape only when it is followed by a
 * command-like token. Prose such as `!Important: ...` must still be optimized.
 */
function isShellEscape(text: string): boolean {
  if (!text.startsWith("!")) return false
  const rest = text.slice(1)
  if (!/^[a-z]/.test(rest)) return false
  const firstWord = rest.split(/\s/, 1)[0] ?? ""
  return !firstWord.includes(":")
}

function isExcludedPrefix(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    if (!prefix) return false
    if (prefix === "!") return isShellEscape(text)
    return text.startsWith(prefix)
  })
}

/** The subset of the V2 plugin context this plugin relies on. */
interface AutoprompterContext {
  options?: unknown
  model: {
    list(): Promise<ModelListResult>
  }
  session: {
    hook(
      name: "prompt",
      callback: (event: PromptEvent) => Promise<void> | void,
    ): Promise<Registration>
  }
  generate?: {
    text(input: { model: ModelRef; prompt: string }): Promise<GenerateResult>
  }
  experimental?: {
    generate?: {
      text(input: { model: ModelRef; prompt: string }): Promise<GenerateResult>
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`optimization timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export default Plugin.define({
  id: "autoprompter",
  async setup(rawCtx: AutoprompterContext) {
    const ctx = rawCtx as AutoprompterContext
    const options = (ctx.options ?? {}) as Options

    if (options.enabled === false) return

    const skill = await loadSkill(options.skillPath)
    const discovered = await discoverFreeModels(ctx)
    const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES
    const excludePrefixes = options.excludePrefixes ?? ["/", "!"]
    const timeoutMs = options.timeoutMs ?? 30_000
    const showOptimized = options.showOptimized !== false
    const verbose = options.log === true

    const generate = (model: ModelRef, prompt: string): Promise<GenerateResult> => {
      const input = { model, prompt }
      const experimental = ctx.experimental?.generate
      if (experimental && typeof experimental.text === "function") {
        return experimental.text(input)
      }
      const legacy = ctx.generate
      if (legacy && typeof legacy.text === "function") {
        return legacy.text(input)
      }
      return Promise.reject(new Error("no generate.text API available in this OpenCode version"))
    }

    if (verbose) {
      console.warn(
        `[autoprompter] active; ${discovered.length} free models discovered` +
          (options.model ? ` (override ${options.model.providerID}/${options.model.id})` : ""),
      )
    }

    // No cross-prompt cooldown: a past rate limit must never make the plugin
    // silently skip future prompts. Each prompt gets a fresh attempt across
    // the whole free-model chain; only that single prompt fails open if all
    // candidates are unavailable.
    const registration = await ctx.session.hook("prompt", async (event) => {
      const original = event.prompt?.text
      if (typeof original !== "string" || original.trim().length === 0) return

      const leading = original.trimStart()
      if (isExcludedPrefix(leading, excludePrefixes)) return

      try {
        // Prefer the model the session is already using; fall back through the
        // other free models if it is rate-limited or otherwise unavailable.
        const candidates = options.model
          ? [{ providerID: options.model.providerID, id: options.model.id }]
          : rankCandidates(discovered, event.model ?? null, maxCandidates)
        const input = buildPrompt(skill, original)

        const optimized = await withTimeout(
          (async () => {
            let lastError: unknown
            for (const candidate of candidates) {
              try {
                const result = await generate(candidate, input)
                const text = sanitize(result?.text, original)
                if (text && !isRejectedRewrite(text, original)) {
                  if (verbose) {
                    console.warn(`[autoprompter] optimized with ${candidate.providerID}/${candidate.id}`)
                  }
                  return text
                }
                if (verbose && text) {
                  console.warn(
                    `[autoprompter] rejected non-rewrite from ${candidate.providerID}/${candidate.id}`,
                  )
                }
                lastError = new Error(
                  text
                    ? `rejected optimizer output from ${candidate.providerID}/${candidate.id}`
                    : `empty result from ${candidate.providerID}/${candidate.id}`,
                )
              } catch (error) {
                lastError = error
                if (verbose) {
                  console.warn(`[autoprompter] ${candidate.providerID}/${candidate.id} unavailable; trying next`)
                }
              }
            }
            throw lastError ?? new Error("no free model available")
          })(),
          timeoutMs,
        )

        event.prompt.text = optimized
        // The model receives the clean rewrite. Show that same rewrite in the
        // message bubble so you can read and copy exactly what was sent.
        if (showOptimized) {
          if (!event.metadata) event.metadata = {}
          event.metadata.originalText = original
          event.metadata.displayText = optimized
        }
        // Offsets in attachment mentions refer to the old text and are now stale.
        for (const file of event.prompt.files ?? []) delete file.mention

        if (verbose) {
          console.warn(`[autoprompter] ${JSON.stringify(original)} -> ${JSON.stringify(optimized)}`)
        }
      } catch (error) {
        // Fail open for this prompt only. No shared state is changed, so the
        // very next prompt is optimized from scratch.
        console.warn("[autoprompter] optimization failed; using original prompt:", error)
      }
    })

    return () => registration.dispose()
  },
})

import { Plugin } from "@opencode/plugin"
import {
  DEFAULT_MAX_CANDIDATES,
  discoverFreeModels,
  rankCandidates,
  type ModelListResult,
  type ModelRef,
} from "./model.js"
import { loadSkill } from "./skill.js"
import { buildPrompt, sanitize } from "./prompt.js"

type Options = {
  enabled?: boolean
  skillPath?: string
  model?: ModelRef
  excludePrefixes?: string[]
  timeoutMs?: number
  maxCandidates?: number
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
}
type GenerateResult = { text: string }
type Registration = { dispose(): Promise<void> | void }

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

    // A free-model rate limit can last hours; avoid re-firing a doomed call
    // for every prompt. Cap the pause so a long outage cannot disable us forever.
    let cooldownUntil = 0
    const MAX_COOLDOWN_MS = 60 * 60 * 1000

    const registration = await ctx.session.hook("prompt", async (event) => {
      const original = event.prompt?.text
      if (typeof original !== "string" || original.trim().length === 0) return
      if (Date.now() < cooldownUntil) {
        if (verbose) console.warn("[autoprompter] optimizer cooling down; using original prompt")
        return
      }

      const leading = original.trimStart()
      if (excludePrefixes.some((prefix) => prefix && leading.startsWith(prefix))) return

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
                const text = sanitize(result?.text)
                if (text) {
                  if (verbose) {
                    console.warn(`[autoprompter] optimized with ${candidate.providerID}/${candidate.id}`)
                  }
                  return text
                }
                lastError = new Error(`empty result from ${candidate.providerID}/${candidate.id}`)
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
        // Offsets in attachment mentions refer to the old text and are now stale.
        for (const file of event.prompt.files ?? []) delete file.mention

        if (verbose) {
          console.warn(`[autoprompter] ${JSON.stringify(original)} -> ${JSON.stringify(optimized)}`)
        }
      } catch (error) {
        // Fail open: never block the user's message because optimization failed.
        const retryAfter = (error as { retryAfterMs?: unknown })?.retryAfterMs
        if (typeof retryAfter === "number" && retryAfter > 0) {
          cooldownUntil = Date.now() + Math.min(retryAfter, MAX_COOLDOWN_MS)
        }
        console.warn("[autoprompter] optimization failed; using original prompt:", error)
      }
    })

    return () => registration.dispose()
  },
})

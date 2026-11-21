import { Plugin } from "@opencode/plugin"
import { pickModel, type ModelListResult, type ModelRef } from "./model.js"
import { loadSkill } from "./skill.js"
import { buildPrompt, sanitize } from "./prompt.js"

type Options = {
  enabled?: boolean
  skillPath?: string
  model?: ModelRef
  excludePrefixes?: string[]
  timeoutMs?: number
  log?: boolean
}

type PromptFile = { mention?: unknown }
type PromptEvent = {
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
    const model = await pickModel(ctx, options.model)
    const excludePrefixes = options.excludePrefixes ?? ["/", "!"]
    const timeoutMs = options.timeoutMs ?? 30_000
    const verbose = options.log === true

    const generate = (prompt: string): Promise<GenerateResult> => {
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

    console.info(`[autoprompter] active; using ${model.providerID}/${model.id}`)

    // A free-model rate limit can last hours; avoid re-firing a doomed call
    // for every prompt. Cap the pause so a long outage cannot disable us forever.
    let cooldownUntil = 0
    const MAX_COOLDOWN_MS = 60 * 60 * 1000

    const registration = await ctx.session.hook("prompt", async (event) => {
      const original = event.prompt?.text
      if (typeof original !== "string" || original.trim().length === 0) return
      if (Date.now() < cooldownUntil) {
        if (verbose) console.info("[autoprompter] optimizer cooling down; using original prompt")
        return
      }

      const leading = original.trimStart()
      if (excludePrefixes.some((prefix) => prefix && leading.startsWith(prefix))) return

      try {
        const result = await withTimeout(generate(buildPrompt(skill, original)), timeoutMs)
        const optimized = sanitize(result?.text)
        if (!optimized) return

        event.prompt.text = optimized
        // Offsets in attachment mentions refer to the old text and are now stale.
        for (const file of event.prompt.files ?? []) delete file.mention

        if (verbose) {
          console.log(`[autoprompter] ${JSON.stringify(original)} -> ${JSON.stringify(optimized)}`)
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

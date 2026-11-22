import assert from "node:assert/strict"
import { test } from "node:test"
import plugin from "../src/index.js"

type GenerateInput = { model: { providerID: string; id: string }; prompt: string }
type GenerateImpl = (input: GenerateInput) => Promise<{ text: string }>
type HookCb = (event: {
  model?: { providerID: string; id: string }
  prompt: { text: string; files?: Array<{ mention?: unknown; [k: string]: unknown }> }
  metadata?: { displayText?: string; originalText?: string; [k: string]: unknown }
}) => Promise<void> | void

/** Minimal fake of the V2 plugin context, with the prompt hook captured. */
function makeCtx(
  options: Record<string, unknown>,
  generateImpl: GenerateImpl,
  useLegacy = false,
) {
  let hook: HookCb | undefined
  let disposed = false
  const ctx = {
    options,
    model: { list: async () => [{ providerID: "opencode", id: "beam-free" }] },
    session: {
      hook: async (_name: string, cb: HookCb) => {
        hook = cb
        return { dispose: () => { disposed = true } }
      },
    },
    ...(useLegacy
      ? { generate: { text: generateImpl } }
      : { experimental: { generate: { text: generateImpl } } }),
  }
  return {
    ctx,
    getHook(): HookCb {
      if (!hook) throw new Error("prompt hook was not registered")
      return hook
    },
    isDisposed: () => disposed,
  }
}

test("setup registers a prompt hook and rewrites eligible prompts", async () => {
  const seen: GenerateInput[] = []
  const fake = makeCtx(
    { enabled: true, model: { providerID: "opencode", id: "beam-free" } },
    async (input) => {
      seen.push(input)
      return { text: "REWRITE_OK" }
    },
  )

  const cleanup = await plugin.setup(fake.ctx as never)
  const event = {
    prompt: { text: "make this better", files: [{ mention: { offset: 3 }, path: "a.txt" }] },
    metadata: { displayText: "make this better", originalText: undefined as string | undefined },
  }
  await fake.getHook()(event)

  assert.equal(event.prompt.text, "REWRITE_OK")
  assert.equal(event.metadata?.displayText, "REWRITE_OK", "message bubble shows what was sent")
  assert.equal(event.metadata?.originalText, "make this better", "typed text is preserved")
  assert.equal(seen.length, 1)
  assert.ok(seen[0]!.prompt.includes("make this better"))
  assert.ok(seen[0]!.prompt.includes("Return ONLY the optimized prompt as plain text"))
  assert.equal("mention" in event.prompt.files![0]!, false, "stale mention must be cleared")
  assert.equal("path" in event.prompt.files![0]!, true, "other file fields survive")

  await cleanup?.()
  assert.equal(fake.isDisposed(), true, "cleanup disposes the hook registration")
})

test("excluded prefixes, commands and empty prompts are passed through", async () => {
  let calls = 0
  const fake = makeCtx(
    { enabled: true, model: { providerID: "opencode", id: "beam-free" } },
    async () => {
      calls++
      return { text: "SHOULD_NOT_HAPPEN" }
    },
  )
  await plugin.setup(fake.ctx as never)
  const hook = fake.getHook()

  for (const text of ["/help me", "!git status", "   ", ""]) {
    const event = { prompt: { text } }
    await hook(event)
    assert.equal(event.prompt.text, text)
  }
  assert.equal(calls, 0, "optimizer must not be called for skipped prompts")
})

test("fail open: a generate error leaves the original prompt untouched", async () => {
  const fake = makeCtx(
    { enabled: true, model: { providerID: "opencode", id: "beam-free" } },
    async () => {
      throw new Error("rate limited")
    },
  )
  await plugin.setup(fake.ctx as never)
  const event = { prompt: { text: "original task" } }
  await fake.getHook()(event)
  assert.equal(event.prompt.text, "original task")
})

test("legacy ctx.generate.text is used when experimental API is absent", async () => {
  const fake = makeCtx(
    { enabled: true, model: { providerID: "opencode", id: "beam-free" } },
    async () => ({ text: "LEGACY_OK" }),
    true,
  )
  await plugin.setup(fake.ctx as never)
  const event = { prompt: { text: "do the thing" } }
  await fake.getHook()(event)
  assert.equal(event.prompt.text, "LEGACY_OK")
})

test("a rate-limited prompt never silences later prompts (no cooldown)", async () => {
  let calls = 0
  const fake = makeCtx(
    { enabled: true, model: { providerID: "opencode", id: "beam-free" } },
    async () => {
      calls++
      if (calls === 1) {
        const err = new Error("rate limited") as Error & { retryAfterMs: number }
        err.retryAfterMs = 10_000
        throw err
      }
      return { text: "RECOVERED" }
    },
  )
  await plugin.setup(fake.ctx as never)
  const hook = fake.getHook()

  const first = { prompt: { text: "first" } }
  await hook(first)
  assert.equal(first.prompt.text, "first", "first prompt fails open")

  const second = { prompt: { text: "second" } }
  await hook(second)
  assert.equal(calls, 2, "the next prompt must still try the optimizer")
  assert.equal(second.prompt.text, "RECOVERED", "the next prompt is swapped")
})

test("falls back to another free model when the session model is rate limited", async () => {
  const attempted: string[] = []
  let disposed = false
  let hook: HookCb | undefined
  const ctx = {
    options: { enabled: true },
    model: {
      list: async () => [
        { providerID: "opencode", id: "opencode/rate-limited-free", modelID: "rate-limited-free" },
        {
          providerID: "openrouter",
          id: "openrouter/google/gemma-4-26b-a4b-it:free",
          modelID: "google/gemma-4-26b-a4b-it:free",
        },
      ],
    },
    session: {
      hook: async (_name: string, cb: HookCb) => {
        hook = cb
        return { dispose: () => { disposed = true } }
      },
    },
    experimental: {
      generate: {
        text: async (input: GenerateInput) => {
          attempted.push(`${input.model.providerID}/${input.model.id}`)
          if (input.model.id === "rate-limited-free") {
            const error = new Error("rate limited") as Error & { retryAfterMs: number }
            error.retryAfterMs = 1000
            throw error
          }
          return { text: "FALLBACK_OK" }
        },
      },
    },
  }

  const cleanup = await plugin.setup(ctx as never)
  if (!hook) throw new Error("prompt hook was not registered")
  const event = {
    model: { providerID: "opencode", id: "rate-limited-free" },
    prompt: { text: "original task" },
  }
  await hook(event)

  assert.equal(event.prompt.text, "FALLBACK_OK")
  assert.equal(attempted[0], "opencode/rate-limited-free")
  assert.equal(attempted[1], "openrouter/google/gemma-4-26b-a4b-it:free")
  await cleanup?.()
  assert.equal(disposed, true)
})

test("enabled:false disables the plugin entirely", async () => {
  const fake = makeCtx({ enabled: false }, async () => ({ text: "NOPE" }))
  const cleanup = await plugin.setup(fake.ctx as never)
  assert.equal(cleanup, undefined)
  assert.equal(fake.isDisposed(), false)
})

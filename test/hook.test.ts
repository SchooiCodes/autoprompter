import assert from "node:assert/strict"
import { test } from "node:test"
import plugin from "../src/index.js"

type GenerateInput = { model: { providerID: string; id: string }; prompt: string }
type GenerateImpl = (input: GenerateInput) => Promise<{ text: string }>
type HookCb = (event: {
  prompt: { text: string; files?: Array<{ mention?: unknown; [k: string]: unknown }> }
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
  }
  await fake.getHook()(event)

  assert.equal(event.prompt.text, "REWRITE_OK")
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

test("retryAfterMs error pauses optimization until cooldown expires", async () => {
  let calls = 0
  const fake = makeCtx(
    { enabled: true, model: { providerID: "opencode", id: "beam-free" } },
    async () => {
      calls++
      const err = new Error("rate limited") as Error & { retryAfterMs: number }
      err.retryAfterMs = 10_000
      throw err
    },
  )
  await plugin.setup(fake.ctx as never)
  const hook = fake.getHook()

  await hook({ prompt: { text: "first" } })
  assert.equal(calls, 1)
  await hook({ prompt: { text: "second" } })
  assert.equal(calls, 1, "second prompt must be skipped while cooling down")
})

test("enabled:false disables the plugin entirely", async () => {
  const fake = makeCtx({ enabled: false }, async () => ({ text: "NOPE" }))
  const cleanup = await plugin.setup(fake.ctx as never)
  assert.equal(cleanup, undefined)
  assert.equal(fake.isDisposed(), false)
})

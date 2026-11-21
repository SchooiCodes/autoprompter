import assert from "node:assert/strict"
import { test } from "node:test"
import { buildPrompt, sanitize } from "../src/prompt.js"
import {
  FALLBACK_MODEL,
  pickModel,
  pickModels,
  rankCandidates,
  rankFree,
} from "../src/model.js"

test("sanitize unwraps a single fenced code block", () => {
  assert.equal(sanitize("```text\nhello world\n```"), "hello world")
  assert.equal(sanitize("  ```\n  hello\n  ```  "), "hello")
})

test("sanitize leaves plain text alone and rejects empties", () => {
  assert.equal(sanitize("  make it concise  "), "make it concise")
  assert.equal(sanitize(""), "")
  assert.equal(sanitize(undefined), "")
})

test("buildPrompt embeds skill and strict output contract", () => {
  const prompt = buildPrompt("SKILL BODY", "original task")
  assert.ok(prompt.includes("SKILL BODY"))
  assert.ok(prompt.includes("Return ONLY the optimized prompt as plain text"))
  assert.ok(prompt.includes("original task"))
})

test("rankFree prefers known fast models", () => {
  assert.ok(rankFree("deepseek-v4.1-flash-free") < rankFree("beam-free"))
  assert.ok(rankFree("hy4-flash-free") < rankFree("some-random-free"))
})

test("pickModel honors an explicit override", async () => {
  const ctx = {
    model: {
      list: async () => [
        { providerID: "opencode", id: "beam-free" },
        { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
      ],
    },
  }
  const picked = await pickModel(ctx, { providerID: "openai", id: "gpt-x" })
  assert.deepEqual(picked, { providerID: "openai", id: "gpt-x" })
})

test("pickModel discovers and ranks free opencode models", async () => {
  const ctx = {
    model: {
      list: async () => [
        { providerID: "opencode", id: "longcat-2.5-free" },
        { providerID: "opencode", id: "deepseek-v4.1-flash-free" },
        { providerID: "anthropic", id: "claude-free" },
        { providerID: "opencode", id: "claude-sonnet-5" },
      ],
    },
  }
  assert.deepEqual(await pickModel(ctx), {
    providerID: "opencode",
    id: "deepseek-v4.1-flash-free",
  })
})

test("pickModel falls back when no free model is available", async () => {
  const ctx = { model: { list: async () => [] } }
  assert.deepEqual(await pickModel(ctx), FALLBACK_MODEL)
})

test("pickModels discovers free models from every provider", async () => {
  const ctx = {
    model: {
      list: async () => [
        { providerID: "opencode", id: "opencode/hy4-flash-free", modelID: "hy4-flash-free" },
        {
          providerID: "openrouter",
          id: "openrouter/google/gemma-4-26b-a4b-it:free",
          modelID: "google/gemma-4-26b-a4b-it:free",
        },
        { providerID: "anthropic", id: "anthropic/claude-sonnet-5", modelID: "claude-sonnet-5" },
      ],
    },
  }
  const models = await pickModels(ctx)
  assert.ok(models.some((m) => m.providerID === "opencode" && m.id === "hy4-flash-free"))
  assert.ok(
    models.some(
      (m) => m.providerID === "openrouter" && m.id === "google/gemma-4-26b-a4b-it:free",
    ),
  )
  assert.equal(models.some((m) => m.id === "claude-sonnet-5"), false)
})

test("rankCandidates puts the current session model first and keeps the fallback", () => {
  const ranked = rankCandidates(
    [
      { providerID: "opencode", id: "beam-free" },
      { providerID: "opencode", id: "hy4-flash-free" },
      { providerID: "openrouter", id: "liquid/lfm-3-1.7b:free" },
    ],
    { providerID: "openrouter", id: "liquid/lfm-3-1.7b:free" },
    2,
  )
  assert.deepEqual(ranked[0], {
    providerID: "openrouter",
    id: "liquid/lfm-3-1.7b:free",
  })
  assert.ok(ranked.some((m) => m.providerID === FALLBACK_MODEL.providerID && m.id === FALLBACK_MODEL.id))
})

test("pickModels honors an override as the only candidate", async () => {
  const ctx = { model: { list: async () => [{ providerID: "opencode", id: "beam-free" }] } }
  assert.deepEqual(await pickModels(ctx, { providerID: "x", id: "y" }), [
    { providerID: "x", id: "y" },
  ])
})

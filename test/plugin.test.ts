import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildPrompt,
  CLARIFICATION_SENTINEL,
  isRejectedRewrite,
  sanitize,
} from "../src/prompt.js"
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

test("sanitize strips leaked reasoning markers", () => {
  assert.equal(
    sanitize("Write a sum function.</ernie:think>Write a sum function."),
    "Write a sum function.",
  )
  assert.equal(sanitize("<think>reasoning</think>the answer"), "the answer")
  assert.equal(sanitize("the answer<think>reasoning</think>"), "the answer")
})

// BUG 1: a fenced answer with surrounding prose must be unwrapped.
test("sanitize extracts a fenced block surrounded by prose", () => {
  assert.equal(
    sanitize(
      "```text\nSummarize the document in three sentences.\n```\n\nChanged: added a sentence count.",
    ),
    "Summarize the document in three sentences.",
  )
  assert.equal(sanitize("Here:\n```ts\nconst x=1\n```\nDone."), "const x=1")
})

// BUG 4: multiple close tags must not discard the real answer text.
test("sanitize preserves text across multiple reasoning close tags", () => {
  assert.equal(sanitize("bc"), "bc")
  assert.equal(sanitize("b</think>c</think>d"), "bcd")
  assert.equal(sanitize("one</ernie:think>two</ernie:think>three"), "onetwothree")
})

// BUG 5: a prompt that is itself a fence must keep its code fence.
test("sanitize keeps a fenced block when the original prompt was a fence", () => {
  const fenced = "```ts\nconst x = 1\n```"
  assert.equal(sanitize(fenced, fenced), fenced)
  assert.equal(sanitize(fenced, "original prompt"), "const x = 1")
})

// BUGS 2 & 3 post-generation validation helpers.
test("isRejectedRewrite rejects clarification, scaffolding and invented placeholders", () => {
  assert.equal(
    isRejectedRewrite(
      "Before I optimize, which plugin do you mean? What does it take as input and output?",
      "test my plugin",
    ),
    true,
  )
  assert.equal(isRejectedRewrite(CLARIFICATION_SENTINEL, "test my plugin"), true)
  assert.equal(
    isRejectedRewrite(
      "Test the autoprompter plugin with {{SAMPLE_INPUTS}} and verify {{EXPECTED_OUTPUT}}",
      "test my plugin",
    ),
    true,
  )
  assert.equal(
    isRejectedRewrite("Changed: added a sentence count\n- one", "summarize this"),
    true,
  )
  assert.equal(
    isRejectedRewrite("Use {{SAMPLE_INPUTS}} verbatim.", "Use {{SAMPLE_INPUTS}} verbatim."),
    false,
  )
  assert.equal(isRejectedRewrite("Rewrite this sentence clearly.", "this"), false)
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

// BUG 7: limit is the total candidate count, including the fallback slot.
test("rankCandidates treats limit as the total including the fallback", () => {
  const ranked = rankCandidates([{ providerID: "opencode", id: "hy4-flash-free" }], null, 1)
  assert.equal(ranked.length, 1)
  assert.deepEqual(ranked[0], FALLBACK_MODEL)
})

test("pickModels honors an override as the only candidate", async () => {
  const ctx = { model: { list: async () => [{ providerID: "opencode", id: "beam-free" }] } }
  assert.deepEqual(await pickModels(ctx, { providerID: "x", id: "y" }), [
    { providerID: "x", id: "y" },
  ])
})

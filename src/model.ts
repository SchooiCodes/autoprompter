export type ModelRef = { providerID: string; id: string }

export type ModelLike = { providerID: string; id: string; modelID?: string }

/** Accept both the bare-array docs shape and the client's { data: [...] } shape. */
export type ModelListResult = ReadonlyArray<ModelLike> | { data: ReadonlyArray<ModelLike> }

/** Minimal surface of ctx.model needed by pickModel. */
export interface ModelLister {
  model: {
    list(): Promise<ModelListResult>
  }
}

/** Free models known to be fast, in preference order. */
const PREFERRED = [
  "deepseek-v4.1-flash-free",
  "mimo-v2.6-flash-free",
  "hy4-flash-free",
  "beam-free",
  "nemotron-3.5-lightning-free",
]

export const FALLBACK_MODEL: ModelRef = { providerID: "opencode", id: "beam-free" }

export function rankFree(id: string): number {
  const preferred = PREFERRED.indexOf(id)
  if (preferred !== -1) return preferred
  if (/flash|lightning/i.test(id)) return PREFERRED.length
  return PREFERRED.length + 1
}

/** OpenCode's ModelInfo carries both `id` and `modelID`; generate.text wants the latter. */
function shortId(model: ModelLike): string {
  return model.modelID || model.id.split("/").pop() || model.id
}

function asArray(result: ModelListResult): ReadonlyArray<ModelLike> {
  return "data" in result ? (result.data ?? []) : result
}

export async function pickModel(
  ctx: ModelLister,
  override?: ModelRef,
): Promise<ModelRef> {
  if (override?.providerID && override?.id) {
    return { providerID: override.providerID, id: override.id }
  }

  try {
    const free = asArray(await ctx.model.list())
      .filter((model) => model.providerID === "opencode" && /free/i.test(shortId(model)))
      .map((model) => shortId(model))
      .sort((a, b) => rankFree(a) - rankFree(b) || a.localeCompare(b))
    if (free.length > 0) {
      return { providerID: "opencode", id: free[0]! }
    }
  } catch (error) {
    console.warn("[autoprompter] model discovery failed; using fallback", error)
  }

  return { ...FALLBACK_MODEL }
}

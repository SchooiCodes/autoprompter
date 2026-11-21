export type ModelRef = { providerID: string; id: string }

export type ModelLike = { providerID: string; id: string; modelID?: string }

/** Accept both the bare-array docs shape and the client's { data: [...] } shape. */
export type ModelListResult = ReadonlyArray<ModelLike> | { data: ReadonlyArray<ModelLike> }

/** Minimal surface of ctx.model needed by model discovery. */
export interface ModelLister {
  model: {
    list(): Promise<ModelListResult>
  }
}

/** Free models known to be fast, in preference order (the current session model wins first). */
const PREFERRED = [
  "hy4-flash-free",
  "deepseek-v4.1-flash-free",
  "mimo-v2.6-flash-free",
  "beam-free",
  "nemotron-3.5-lightning-free",
]

export const DEFAULT_MAX_CANDIDATES = 6

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

function same(a: ModelRef, b: ModelRef): boolean {
  return a.providerID === b.providerID && a.id === b.id
}

/** Discover every free model from every provider, roughly ranked. */
export async function discoverFreeModels(ctx: ModelLister): Promise<ModelRef[]> {
  try {
    return asArray(await ctx.model.list())
      .filter((model) => /free/i.test(shortId(model)))
      .map((model) => ({ providerID: model.providerID, id: shortId(model) }))
  } catch (error) {
    console.warn("[autoprompter] model discovery failed; using fallback", error)
    return []
  }
}

/**
 * Rank free models, putting the current session model first when available.
 * The hardcoded fallback is always kept so an empty/broken discovery still
 * yields a usable candidate.
 */
export function rankCandidates(
  models: ReadonlyArray<ModelRef>,
  current?: ModelRef | null,
  limit = DEFAULT_MAX_CANDIDATES,
): ModelRef[] {
  const seen = new Set<string>()
  const unique = models.filter((model) => {
    if (!model.providerID || !model.id) return false
    const key = `${model.providerID}/${model.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  unique.sort((a, b) => {
    const aCurrent = current && same(a, current)
    const bCurrent = current && same(b, current)
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1
    return rankFree(a.id) - rankFree(b.id) || a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id)
  })

  const ranked = unique.slice(0, Math.max(1, limit))
  if (!ranked.some((model) => same(model, FALLBACK_MODEL))) {
    ranked.push({ ...FALLBACK_MODEL })
  }
  return ranked
}

/** Ordered candidate list for the optimizer. An explicit override wins outright. */
export async function pickModels(
  ctx: ModelLister,
  override?: ModelRef,
  current?: ModelRef | null,
  limit = DEFAULT_MAX_CANDIDATES,
): Promise<ModelRef[]> {
  if (override?.providerID && override?.id) {
    return [{ providerID: override.providerID, id: override.id }]
  }
  return rankCandidates(await discoverFreeModels(ctx), current, limit)
}

/** Backwards-compatible single-model picker (first candidate). */
export async function pickModel(ctx: ModelLister, override?: ModelRef): Promise<ModelRef> {
  return (await pickModels(ctx, override))[0] ?? { ...FALLBACK_MODEL }
}

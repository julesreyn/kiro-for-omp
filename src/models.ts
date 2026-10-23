import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export interface ModelDef {
  id: string
  name: string
  reasoning: boolean
  reasoningHidden?: boolean
  input: ("text" | "image")[]
  contextWindow: number
  maxTokens: number
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const MODELS_PATH = [join(MODULE_DIR, "..", "models.json"), join(MODULE_DIR, "models.json")]
  .find(existsSync) ?? join(MODULE_DIR, "..", "models.json")
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export function loadModels(): Array<ModelDef & { cost: typeof ZERO_COST }> {
  const parsed = JSON.parse(readFileSync(MODELS_PATH, "utf-8")) as { models?: unknown }
  if (!Array.isArray(parsed.models)) throw new Error("models.json must contain a models array")

  const ids = new Set<string>()
  return parsed.models.map((value, index) => {
    const model = value as Partial<ModelDef>
    if (!model.id || !model.name || typeof model.reasoning !== "boolean") {
      throw new Error(`models.json model ${index} is missing required metadata`)
    }
    if (!Array.isArray(model.input) || !model.input.every((item) => item === "text" || item === "image")) {
      throw new Error(`models.json model ${model.id} has invalid input modalities`)
    }
    if (!Number.isInteger(model.contextWindow) || !Number.isInteger(model.maxTokens) || model.contextWindow! <= 0 || model.maxTokens! <= 0) {
      throw new Error(`models.json model ${model.id} has invalid token limits`)
    }
    if (ids.has(model.id)) throw new Error(`models.json contains duplicate id: ${model.id}`)
    ids.add(model.id)
    return { ...(model as ModelDef), cost: { ...ZERO_COST } }
  })
}

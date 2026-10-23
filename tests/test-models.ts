import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import registerKiro from "../index.ts"
import { loadModels } from "../src/models.ts"

describe("Kiro model catalog", () => {
  it("loads a unique, valid model overlay", () => {
    const models = loadModels()

    assert.ok(models.length > 0)
    assert.equal(new Set(models.map((model) => model.id)).size, models.length)
    assert.ok(models.every((model) => model.contextWindow > 0 && model.maxTokens > 0))
    assert.ok(models.every((model) => model.cost.input === 0 && model.cost.output === 0))
    assert.notEqual(models[0].cost, models[1].cost)
    // Every models.json field survives loading, including the reasoningHidden that index.ts reads.
    const { models: listed } = JSON.parse(readFileSync(new URL("../models.json", import.meta.url), "utf-8"))
    assert.deepEqual(models.map(({ cost: _cost, ...model }) => model), listed)
  })

  it("lists the account's live catalog, not models.json, in a form OMP can cache", () => {
    const savedKey = process.env.KIRO_API_KEY
    const register = (key: string | undefined) => {
      let config: Record<string, unknown> | undefined
      if (key === undefined) delete process.env.KIRO_API_KEY
      else process.env.KIRO_API_KEY = key
      try {
        registerKiro({ registerProvider: (_name: string, value: Record<string, unknown>) => { config = value } } as never)
      } finally {
        if (savedKey === undefined) delete process.env.KIRO_API_KEY
        else process.env.KIRO_API_KEY = savedKey
      }
      return config
    }
    // Declared while unset, the name reached discovery as the key and OMP cached an empty catalog.
    assert.equal(register(undefined)?.apiKey, undefined)
    // With KIRO_API_KEY set, OMP pairs `authHeader` with the declared apiKey into a header resolver.
    const config = register("ksk_test")
    assert.equal(config?.apiKey, "KIRO_API_KEY")
    // OMP would list a static entry for every account, including models Kiro has retired.
    assert.equal(config?.models, undefined)
    assert.equal(typeof config?.fetchDynamicModels, "function")
    // OMP's cache drops a model with an auth header resolver, so a failed discovery would list none.
    assert.equal(config?.authHeader, undefined)
  })
})

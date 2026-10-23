import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { kiroEffortFields } from "../src/core.ts"

const CLAUDE = ["low", "medium", "high", "xhigh", "max"]

describe("kiroEffortFields", () => {
  it("sends OMP's level as Claude's output_config effort", () => {
    assert.deepEqual(kiroEffortFields("claude-opus-5-5", CLAUDE, "max"), { output_config: { effort: "max" } })
    assert.deepEqual(kiroEffortFields("claude-opus-5-5", CLAUDE, "low"), { output_config: { effort: "low" } })
  })

  it("sends GPT and Kimi levels as a reasoning effort", () => {
    assert.deepEqual(kiroEffortFields("gpt-5-6-sol", ["low", "medium", "high", "xhigh", "max"], "xhigh"), { reasoning: { effort: "xhigh" } })
    assert.deepEqual(kiroEffortFields("kimi-k3", ["low", "high", "max"], "max"), { reasoning: { effort: "max" } })
  })

  it("falls back to the closest level below, or the lowest one", () => {
    assert.deepEqual(kiroEffortFields("claude-opus-4-6", ["low", "medium", "high", "max"], "xhigh"), { output_config: { effort: "high" } })
    assert.deepEqual(kiroEffortFields("kimi-k3", ["low", "high", "max"], "medium"), { reasoning: { effort: "low" } })
    assert.deepEqual(kiroEffortFields("claude-opus-5-5", CLAUDE, "minimal"), { output_config: { effort: "low" } })
  })

  it("leaves the backend default when there is no level or no effort levels", () => {
    assert.equal(kiroEffortFields("claude-opus-5-5", CLAUDE, undefined), undefined)
    assert.equal(kiroEffortFields("claude-opus-5-5", CLAUDE, true), undefined)
    assert.equal(kiroEffortFields("claude-opus-5-5", CLAUDE, "off"), undefined)
    assert.equal(kiroEffortFields("claude-opus-5-5", CLAUDE, false), undefined)
    assert.equal(kiroEffortFields("claude-haiku-4-5", undefined, "max"), undefined)
    assert.equal(kiroEffortFields("odd", ["turbo"], "max"), undefined)
  })
})

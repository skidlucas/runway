import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import { DecisionModel, LanguageModel } from "effect/ai"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addMonths, todayIn } from "~/domain/dates"
import { Accounts } from "~/server/services/accounts"
import { Ai, type AiProviders, aiProvidersFromEnv } from "~/server/services/ai"
import { Categories } from "~/server/services/categories"
import { Categorizer } from "~/server/services/categorize"
import { Demo } from "~/server/services/demo"
import { Insights } from "~/server/services/insights"
import { Transactions } from "~/server/services/transactions"
import { createHarness, type Harness } from "./harness"

// A scripted LanguageModel: `reply` sees the whole prompt and returns the JSON text.
const fakeLanguageModel = (reply: (prompt: string) => unknown) => {
  const calls: string[] = []
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) => {
        const prompt = JSON.stringify(options.prompt)
        calls.push(prompt)
        return Effect.succeed([{ type: "text", text: JSON.stringify(reply(prompt)) }])
      },
      streamText: () => Stream.empty,
    }),
  )
  return { layer, calls }
}

const KEYWORDS: Record<string, string> = { carrefour: "Courses", uber: "Restaurants", total: "Transport" }

const month = todayIn("Europe/Paris").slice(0, 7)

const seedUncategorized = async (h: Harness) => {
  await h.run(Categories.use((c) => c.createStarterSet))
  const account = await h.run(
    Accounts.use((a) =>
      a.create({ name: "Courant", kind: "checking", offBudget: false, startingBalance: 100_000, startingDate: `${addMonths(month, -1)}-01` }),
    ),
  )
  const ids: string[] = []
  for (const [payee, amount] of [
    ["CB CARREFOUR MARKET", -5420],
    ["CB CARREFOUR MARKET", -1200],
    ["UBER EATS", -2390],
    ["TOTALENERGIES", -6800],
  ] as const) {
    ids.push(
      await h.run(
        Transactions.use((t) =>
          t.create({ accountId: account, date: `${month}-01`, amount, payee: { kind: "name", name: payee }, categoryId: null }),
        ),
      ),
    )
  }
  const tree = await h.run(Categories.use((c) => c.tree))
  const byName = new Map(tree.flatMap((g) => g.categories).map((c) => [c.name, c.id]))
  return { ids, byName }
}

describe("Ai with a decision model (Jev path)", () => {
  let h: Harness
  let decideCalls = 0
  beforeAll(async () => {
    const decisionModel = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({
        decide: (options) => {
          decideCalls++
          const state = JSON.stringify(options.state).toLowerCase()
          const decision = options.decisions.label as { criteria: Record<string, string> }
          const wanted = Object.entries(KEYWORDS).find(([k]) => state.includes(k))?.[1]
          const label =
            Object.entries(decision.criteria).find(([, d]) => wanted && d.endsWith(wanted))?.[0] ?? Object.keys(decision.criteria)[0]!
          const labels = Object.keys(decision.criteria)
          const probabilities = Object.fromEntries(labels.map((l) => [l, l === label ? 1 : 0]))
          return Effect.succeed({
            answers: { label: { _tag: "Classify" as const, label, probabilities, confidence: 0.92 } },
            usage: { inputTokens: 1, outputTokens: 1 },
          })
        },
      }),
    )
    h = await createHarness({ ai: { provider: "openai", model: null, languageModel: null, decisionModel } })
  })
  afterAll(() => h?.dispose())

  it("suggests one category per distinct payee", async () => {
    const { ids, byName } = await seedUncategorized(h)
    expect(await h.run(Ai.use((a) => Effect.succeed(a.status)))).toMatchObject({ classification: "jev", analysis: false })
    const result = await h.run(Categorizer.use((c) => c.suggest()))
    expect(result.considered).toBe(4)
    expect(decideCalls).toBe(3)
    const byTx = new Map(result.suggestions.map((s) => [s.transactionId, s]))
    expect(byTx.get(ids[0]!)).toMatchObject({ categoryId: byName.get("Courses"), confidence: 0.92, source: "jev" })
    expect(byTx.get(ids[1]!)?.categoryId).toBe(byName.get("Courses"))
    expect(byTx.get(ids[2]!)?.categoryId).toBe(byName.get("Restaurants"))
    expect(byTx.get(ids[3]!)?.categoryId).toBe(byName.get("Transport"))
  })

  it("explains that analysis needs a language model", async () => {
    await expect(h.run(Insights.use((s) => s.analysis))).rejects.toThrow(/clé d'API IA/)
  })
})

describe("Ai with a language model only", () => {
  let h: Harness
  const model = fakeLanguageModel((prompt) => {
    if (prompt.includes("budget_analysis") || prompt.includes("assistant d'une app de budget")) {
      return { headline: "Mois calme.", points: [{ tone: "neutral", title: "Rien à signaler", detail: "0 €" }] }
    }
    if (prompt.includes("Traduis la question")) {
      return { understood: true, measure: "expenses", targetKind: "category", targetName: "restaurants", months: 6, rolling: 3 }
    }
    // Classification fallback: answer every key with the keyword's category.
    const items = [...prompt.matchAll(/\\"key\\":\\"([^\\]+)\\",\\"payee\\":\\"([^\\]+)\\"/g)]
    const labels = new Map([...prompt.matchAll(/- ([a-z0-9-]+): [^›]+› ([^\\]+)\\n/gi)].map((m) => [m[2]!, m[1]!]))
    return {
      answers: items.map((m) => {
        const name = Object.entries(KEYWORDS).find(([k]) => m[2]!.toLowerCase().includes(k))?.[1] ?? "Courses"
        return { key: m[1], label: labels.get(name) ?? "unknown", confidence: 0.7 }
      }),
    }
  })
  beforeAll(async () => {
    h = await createHarness({ ai: { provider: "openai", model: "fake", languageModel: model.layer, decisionModel: null } })
  })
  afterAll(() => h?.dispose())

  it("falls back to the language model for classification", async () => {
    const { ids, byName } = await seedUncategorized(h)
    const result = await h.run(Categorizer.use((c) => c.suggest()))
    const byTx = new Map(result.suggestions.map((s) => [s.transactionId, s]))
    expect(byTx.get(ids[2]!)).toMatchObject({ categoryId: byName.get("Restaurants"), source: "llm", confidence: 0.7 })
    expect(byTx.get(ids[3]!)?.categoryId).toBe(byName.get("Transport"))
  })

  it("caches analyses by content", async () => {
    const before = model.calls.length
    const first = await h.run(Insights.use((s) => s.analysis))
    expect(first).toMatchObject({ headline: "Mois calme.", month })
    await h.run(Insights.use((s) => s.analysis))
    expect(model.calls.length).toBe(before + 1)
  })

  it("interprets a question into a query with resolved ids", async () => {
    const { query } = await h.run(Insights.use((s) => s.interpret("combien en restos sur 6 mois ?")))
    const tree = await h.run(Categories.use((c) => c.tree))
    const restaurants = tree.flatMap((g) => g.categories).find((c) => c.name === "Restaurants")!.id
    expect(query).toEqual({ measure: "expenses", target: { kind: "category", id: restaurants }, months: 6, rolling: 3 })
  })
})

// Real providers, opt-in: RUNWAY_LIVE_AI=1 bunx vitest run tests/integration/ai.test.ts
const live = process.env.RUNWAY_LIVE_AI === "1"
describe.runIf(live)("live providers", () => {
  let h: Harness
  beforeAll(async () => {
    const vars = Object.fromEntries(
      readFileSync(join(process.cwd(), ".dev.vars"), "utf8")
        .split("\n")
        .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => [m[1]!, m[2]!.trim()]),
    )
    const providers: AiProviders = aiProvidersFromEnv(vars)
    h = await createHarness({ ai: providers })
    await h.run(Demo.use((d) => d.seed))
  })
  afterAll(() => h?.dispose())

  it("writes an analysis", async () => {
    const analysis = await h.run(Insights.use((s) => s.analysis))
    console.log(JSON.stringify(analysis, null, 2))
    expect(analysis.points.length).toBeGreaterThan(0)
  }, 120_000)

  it("interprets a question", async () => {
    const result = await h.run(Insights.use((s) => s.interpret("mes restos sur les 6 derniers mois")))
    console.log(JSON.stringify(result))
    expect(result.query?.target.kind).toBe("category")
  }, 60_000)

  it("categorizes with Jev", async () => {
    const { ids, byName } = await seedUncategorized(h)
    const result = await h.run(Categorizer.use((c) => c.suggest(ids)))
    const byTx = new Map(result.suggestions.map((s) => [s.transactionId, s]))
    console.log(result.suggestions)
    expect(byTx.get(ids[2]!)?.categoryId).toBe(byName.get("Restaurants"))
  }, 60_000)
})

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { Base64 } from "effect/encoding"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ExternalError } from "~/server/errors"
import { aiProvidersFromEnv } from "~/server/services/ai"
import { Receipts } from "~/server/services/receipts"
import { createHarness, type Harness } from "./harness"

type Reply = { readable: boolean; kind: "expense" | "income"; amount: number | null; currency: string; payee: string | null; date: string | null; notes: string | null }

const base: Reply = { readable: true, kind: "expense", amount: 42.18, currency: "EUR", payee: "Fnac", date: "2026-10-02", notes: "2 livres" }

// Answers with `reply` and keeps every prompt it receives, file parts included.
const scriptedModel = () => {
  const state = { reply: base, prompts: [] as unknown[] }
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) => {
        state.prompts.push(options.prompt)
        return Effect.succeed([{ type: "text", text: JSON.stringify(state.reply) }])
      },
      streamText: () => Stream.empty,
    }),
  )
  return { state, layer }
}

const image = (seed: string) => ({ mediaType: "image/jpeg" as const, data: btoa(`jpeg-${seed}`) })
const read = (h: Harness, file: { mediaType: "image/jpeg" | "application/pdf"; data: string }) =>
  h.run(Receipts.use((r) => r.read({ file, today: "2026-10-04" })))

describe("Receipts.read", () => {
  const model = scriptedModel()
  const rates = new Map([["USD", 0.92]])
  let h: Harness

  beforeAll(async () => {
    h = await createHarness({
      now: "2026-10-04T10:00:00Z",
      ai: { provider: "openai", model: "fake", languageModel: model.layer, decisionModel: null },
      market: {
        euroRate: (currency) => {
          const rate = rates.get(currency)
          return rate === undefined ? Effect.fail(new ExternalError({ service: "test", message: "Hors ligne" })) : Effect.succeed(rate)
        },
      },
    })
  })
  afterAll(() => h.dispose())

  it("turns a euro reading into a draft in cents", async () => {
    model.state.reply = base
    expect(await read(h, image("eur"))).toEqual({
      kind: "expense",
      amount: 4218,
      payee: "Fnac",
      date: "2026-10-02",
      notes: "2 livres",
      foreign: null,
    })
  })

  it("converts another currency at today's rate and keeps the original amount in the notes", async () => {
    model.state.reply = { ...base, amount: 45, currency: "usd", notes: null }
    const draft = await read(h, image("usd"))
    expect(draft.amount).toBe(4140)
    expect(draft.foreign).toEqual({ amount: 4500, currency: "USD", rate: 0.92 })
    expect(draft.notes).toMatch(/^45,00\s\$US à 0,92$/)
  })

  it("leaves the amount empty when no rate is found, without failing the reading", async () => {
    model.state.reply = { ...base, amount: 30, currency: "CHF" }
    const draft = await read(h, image("chf"))
    expect(draft.amount).toBeNull()
    expect(draft.payee).toBe("Fnac")
    expect(draft.foreign).toEqual({ amount: 3000, currency: "CHF", rate: null })
    expect(draft.notes).toMatch(/^2 livres · 30,00\sCHF \(taux indisponible\)$/)
  })

  it("drops a date the model got wrong", async () => {
    model.state.reply = { ...base, date: "02/10/2026" }
    expect((await read(h, image("bad-date"))).date).toBeNull()
  })

  it("fails with a readable message when the document shows no payment", async () => {
    model.state.reply = { ...base, readable: false }
    await expect(read(h, image("cat"))).rejects.toThrow("Aucun paiement trouvé dans ce document")
  })

  it("sends a PDF as bytes, which both providers accept", async () => {
    model.state.reply = base
    const before = model.state.prompts.length
    await read(h, { mediaType: "application/pdf", data: btoa("%PDF-1.7 facture") })
    const prompt = model.state.prompts[before] as { content: Array<{ role: string; content: Array<{ type: string; data?: unknown }> }> }
    const file = prompt.content.find((m) => m.role === "user")?.content.find((p) => p.type === "file")
    expect(file?.data).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(file?.data as Uint8Array)).toBe("%PDF-1.7 facture")
  })

  it("reads the same file only once", async () => {
    model.state.reply = base
    await read(h, image("cached"))
    const before = model.state.prompts.length
    await read(h, image("cached"))
    expect(model.state.prompts.length).toBe(before)
    await read(h, image("other"))
    expect(model.state.prompts.length).toBe(before + 1)
  })
})

// Real provider, opt-in: RUNWAY_LIVE_AI=1 bunx vitest run tests/integration/receipts.test.ts
const live = process.env.RUNWAY_LIVE_AI === "1"
describe.runIf(live)("live provider", () => {
  let h: Harness
  const fixture = (name: string) => Base64.encode(readFileSync(join(process.cwd(), "tests/fixtures", name)))

  beforeAll(async () => {
    const vars = Object.fromEntries(
      readFileSync(join(process.cwd(), ".env"), "utf8")
        .split("\n")
        .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => [m[1]!, m[2]!.trim()]),
    )
    h = await createHarness({ ai: aiProvidersFromEnv(vars) })
  })
  afterAll(() => h?.dispose())

  it("reads a cart screenshot", async () => {
    const draft = await read(h, { mediaType: "image/jpeg", data: fixture("receipt-cart.jpg") })
    console.log(draft)
    expect(draft).toMatchObject({ kind: "expense", amount: 3808, payee: "Fnac", date: "2026-10-02", foreign: null })
    expect(draft.notes).not.toContain("7845123690")
  }, 60_000)

  it("reads a PDF invoice", async () => {
    const draft = await read(h, { mediaType: "application/pdf", data: fixture("receipt-invoice.pdf") })
    console.log(draft)
    expect(draft).toMatchObject({ kind: "expense", amount: 2199, foreign: null })
    expect(draft.payee).toMatch(/free/i)
    expect(draft.notes).not.toContain("FM-2026")
  }, 60_000)
})

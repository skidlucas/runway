import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { ExternalError } from "~/server/errors"
import { makeLiveMarketData } from "~/server/services/market-data"

// Routes a URL to a canned JSON body; anything else is a 404.
const fakeFetch = (routes: Array<[RegExp, unknown]>) =>
  (async (input: RequestInfo | URL) => {
    const url = String(input)
    const hit = routes.find(([re]) => re.test(url))
    return hit ? new Response(JSON.stringify(hit[1]), { status: 200 }) : new Response("not found", { status: 404 })
  }) as typeof fetch

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

const dvfRow = (month: string, n: number, median: number) => ({
  annee_mois: month,
  nb_ventes_appartement: n,
  med_prix_m2_appartement: median,
  nb_ventes_maison: 0,
  med_prix_m2_maison: null,
})

describe("DVF", () => {
  // 24 months, newest first as the API returns them: 10 sales a month at 4 000 €/m², then a
  // last month with 30 sales at 5 000 €/m².
  const months = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 11 - i, 1))
    return d.toISOString().slice(0, 7)
  })
  const rows = months.map((m, i) => (i === 0 ? dvfRow(m, 30, 5_000) : dvfRow(m, 10, 4_000)))
  const market = makeLiveMarketData(fakeFetch([[/tabular-api/, { data: rows }]]))

  it("weights the last 12 months of medians by their sales", async () => {
    const price = await run(market.dvfPricePerM2("69387", "apartment"))
    // (30 × 5 000 + 11 × 10 × 4 000) / 140
    expect(price).toEqual({ pricePerM2: Math.round((150_000 + 440_000) / 140), sales: 140, from: "2025-01", to: "2025-12" })
  })

  it("gives one rolling point per month", async () => {
    const history = await run(market.dvfHistory("69387", "apartment"))
    expect(history).toHaveLength(13)
    expect(history[0]).toEqual({ date: "2024-12-31", price: 4_000 })
    expect(history.at(-1)!.date).toBe("2025-12-31")
  })

  it("refuses to estimate without enough sales", async () => {
    await expect(run(market.dvfPricePerM2("69387", "house"))).rejects.toThrow(/Pas assez de ventes/)
  })
})

describe("quotes", () => {
  const chart = (currency: string, price: number) => ({ chart: { result: [{ meta: { currency, regularMarketPrice: price } }] } })
  const market = makeLiveMarketData(
    fakeFetch([
      [/chart\/CW8\.PA\?range=1d/, chart("EUR", 500)],
      [/chart\/AAPL\?range=1d/, chart("USD", 200)],
      [/chart\/VUSA\.L\?range=1d/, chart("GBp", 8_000)],
      [/chart\/USDEUR%3DX/, chart("EUR", 0.9)],
      [/chart\/GBPEUR%3DX/, chart("EUR", 1.2)],
      [
        /chart\/AAPL\?range=1y/,
        {
          chart: {
            result: [
              {
                meta: { currency: "USD" },
                timestamp: [Date.UTC(2026, 7, 1) / 1000, Date.UTC(2026, 8, 1) / 1000],
                indicators: { quote: [{ close: [180, 200] }] },
              },
            ],
          },
        },
      ],
    ]),
  )

  it("converts to euros and skips unknown symbols", async () => {
    const prices = await run(market.quotes(["CW8.PA", "AAPL", "VUSA.L", "NOPE"]))
    expect(prices.get("CW8.PA")).toBe(500)
    expect(prices.get("AAPL")).toBeCloseTo(180)
    expect(prices.get("VUSA.L")).toBeCloseTo(96)
    expect(prices.has("NOPE")).toBe(false)
  })

  it("dates monthly closes at the month end, in euros", async () => {
    const history = await run(market.quoteHistory("AAPL"))
    expect(history.map((p) => p.date)).toEqual(["2026-08-31", "2026-09-30"])
    expect(history[0]!.price).toBeCloseTo(162)
  })
})

describe("communes", () => {
  it("searches by postcode or by name", async () => {
    const urls: string[] = []
    const market = makeLiveMarketData((async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify([{ code: "69387", nom: "Lyon 7e Arrondissement", codesPostaux: ["69007"] }]))
    }) as typeof fetch)
    expect(await run(market.searchCommunes("69007"))).toEqual([{ code: "69387", name: "Lyon 7e Arrondissement", postcode: "69007" }])
    await run(market.searchCommunes("Lyon"))
    expect(urls[0]).toContain("codePostal=69007")
    expect(urls[1]).toContain("nom=Lyon")
  })
})

describe("Unexpected responses", () => {
  it("fails with an ExternalError when an API changes shape", async () => {
    const market = makeLiveMarketData(
      fakeFetch([
        [/coingecko.*market_chart/, { prices: "soon" }],
        [/coingecko.*search/, { results: [] }],
        [/tabular-api/, { data: [{ annee_mois: 202501 }] }],
      ]),
    )
    const calls: Array<Effect.Effect<unknown, ExternalError>> = [
      market.cryptoHistory("bitcoin"),
      market.searchCoins("btc"),
      market.dvfPricePerM2("69387", "house"),
    ]
    for (const call of calls) {
      // flip: a typed failure becomes the value; a defect would reject the promise.
      const error = await run(Effect.flip(call))
      expect(error.message).toContain("réponse inattendue")
    }
  })
})

describe("requests", () => {
  it("abort the fetch when the effect is interrupted", async () => {
    let received: AbortSignal | undefined
    const hanging = ((_: RequestInfo | URL, init?: RequestInit) => {
      received = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as typeof fetch
    const market = makeLiveMarketData(hanging)
    await run(market.cryptoPrices(["bitcoin"]).pipe(Effect.timeoutOption("20 millis")))
    expect(received?.aborted).toBe(true)
  })
})

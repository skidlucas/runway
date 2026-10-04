import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeLiveMarketData } from "~/server/services/market-data"

describe("quotes", () => {
  it("says the price is missing when Yahoo knows the symbol but has no market price", async () => {
    const market = makeLiveMarketData((async () =>
      new Response(JSON.stringify({ chart: { result: [{ meta: { currency: "EUR" } }] } }), { status: 200 })) as unknown as typeof fetch)
    const quotes = await Effect.runPromise(market.quotes(["DELISTED.PA"]))
    expect(quotes.get("DELISTED.PA")).toMatchObject({ _tag: "Failure", failure: { message: "Cours introuvable pour DELISTED.PA" } })
  })
})

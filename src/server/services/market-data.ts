import { Context, Effect, Layer, Result, Schema } from "effect"
import { addMonths, type Day, lastDay, type Month } from "~/domain/dates"
import { ExternalError } from "../errors"

// Free public sources, no API key. Each one can disappear or rate-limit: callers treat every
// failure as "no automatic estimate this time" and keep the last known value.

export type CoinHit = { id: string; name: string; symbol: string }
export type SymbolHit = { symbol: string; name: string; exchange: string; type: string }
export type CommuneHit = { code: string; name: string; postcode: string | null }
export type PricePoint = { date: Day; price: number }
export type DvfPrice = {
  /** Euros per m², sales-weighted over the last 12 published months. */
  pricePerM2: number
  sales: number
  from: string
  to: string
}

export class MarketData extends Context.Service<
  MarketData,
  {
    /** Euros per unit, by CoinGecko id. Unknown ids are missing from the map. */
    cryptoPrices(ids: ReadonlyArray<string>): Effect.Effect<Map<string, number>, ExternalError>
    /** Euros per unit (converted from the quote currency), by Yahoo symbol. */
    /** Euro price of each symbol, or why it could not be priced (unknown symbol, Yahoo down, no exchange rate). */
    quotes(symbols: ReadonlyArray<string>): Effect.Effect<Map<string, Result.Result<number, ExternalError>>>
    dvfPricePerM2(inseeCode: string, propertyType: "apartment" | "house"): Effect.Effect<DvfPrice, ExternalError>
    /** Daily euro prices over the last year, oldest first. */
    cryptoHistory(id: string): Effect.Effect<PricePoint[], ExternalError>
    /** Month-end euro prices over the last year, oldest first. */
    quoteHistory(symbol: string): Effect.Effect<PricePoint[], ExternalError>
    /** One rolling 12-month price per published month (the month's last day), oldest first. */
    dvfHistory(inseeCode: string, propertyType: "apartment" | "house"): Effect.Effect<PricePoint[], ExternalError>
    searchCoins(query: string): Effect.Effect<CoinHit[], ExternalError>
    searchSymbols(query: string): Effect.Effect<SymbolHit[], ExternalError>
    searchCommunes(query: string): Effect.Effect<CommuneHit[], ExternalError>
  }
>()("runway/server/services/MarketData") {
  static readonly layer = Layer.sync(MarketData, () => makeLiveMarketData(fetch))
}

const DVF_MONTHLY = "https://tabular-api.data.gouv.fr/api/resources/03fba98d-885b-43c0-8986-d299cabc29da/data/"
const MIN_DVF_SALES = 5

export const makeLiveMarketData = (fetchFn: typeof fetch): MarketData["Service"] => {
  // Responses are decoded against the fields we read: an API that changes shape yields an
  // ExternalError (the asset keeps its last value), never a crash.
  const getJson = <T>(service: string, url: string, schema: Schema.Decoder<T>): Effect.Effect<T, ExternalError> =>
    Effect.tryPromise({
      // Interrupting the effect (a caller's timeout, a cancelled request) aborts the fetch too.
      try: async (signal) => {
        const response = await fetchFn(url, {
          headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; runway-budget)" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return (await response.json()) as unknown
      },
      catch: (cause) =>
        new ExternalError({ service, message: `${service} injoignable (${cause instanceof Error ? cause.message : String(cause)})`, cause }),
    }).pipe(
      Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
      Effect.mapError((error) =>
        error instanceof ExternalError ? error : new ExternalError({ service, message: `${service} : réponse inattendue`, cause: error }),
      ),
      Effect.withSpan("MarketData.getJson", { attributes: { service, url } }),
    )

  const cryptoPrices = (ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed(new Map<string, number>())
      : getJson(
          "CoinGecko",
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids.map(encodeURIComponent).join(",")}&vs_currencies=eur`,
          Schema.Record(Schema.String, Schema.Struct({ eur: Schema.optional(Schema.Number) })),
        ).pipe(
          Effect.map(
            (body) => new Map(Object.entries(body).flatMap(([id, p]) => (typeof p.eur === "number" ? [[id, p.eur] as const] : []))),
          ),
        )

  const Chart = Schema.Struct({
    chart: Schema.Struct({
      result: Schema.NullOr(Schema.Array(Schema.Struct({ meta: Schema.Struct({ currency: Schema.String, regularMarketPrice: Schema.Number }) }))),
    }),
  })
  const rawQuote = (symbol: string) =>
    getJson("Yahoo Finance", `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, Chart).pipe(
      Effect.flatMap((body) => {
        const meta = body.chart.result?.[0]?.meta
        return meta && typeof meta.regularMarketPrice === "number"
          ? Effect.succeed(meta)
          : Effect.fail(new ExternalError({ service: "Yahoo Finance", message: `Cours introuvable pour ${symbol}` }))
      }),
    )

  // London quotes come in pence ("GBp").
  const currencyOf = (raw: string) => (raw === "GBp" ? { currency: "GBP", factor: 0.01 } : { currency: raw.toUpperCase(), factor: 1 })

  /** Euro value of one unit of each currency. */
  const euroRates = (currencies: ReadonlyArray<string>) =>
    Effect.forEach(
      [...new Set(currencies)].filter((c) => c !== "EUR"),
      (c) => rawQuote(`${c}EUR=X`).pipe(Effect.map((fx) => fx.regularMarketPrice), Effect.result, Effect.map((r) => [c, r] as const)),
      { concurrency: 4 },
    ).pipe(Effect.map((found) => new Map<string, Result.Result<number, ExternalError>>([["EUR", Result.succeed(1)], ...found])))

  const quotes = Effect.fn("MarketData.quotes")(function* (symbols: ReadonlyArray<string>) {
    const metas = yield* Effect.forEach(symbols, (s) => rawQuote(s).pipe(Effect.result, Effect.map((m) => [s, m] as const)), {
      concurrency: 4,
    })
    const rates = yield* euroRates(metas.flatMap(([, m]) => (m._tag === "Success" ? [currencyOf(m.success.currency).currency] : [])))
    return new Map(
      metas.map(([symbol, meta]): [string, Result.Result<number, ExternalError>] => {
        if (meta._tag === "Failure") return [symbol, Result.fail(meta.failure)]
        const { currency, factor } = currencyOf(meta.success.currency)
        const rate = rates.get(currency)
        if (rate === undefined || rate._tag === "Failure") {
          return [symbol, Result.fail(new ExternalError({ service: "Yahoo Finance", message: `Taux de change ${currency} → EUR indisponible` }))]
        }
        return [symbol, Result.succeed(meta.success.regularMarketPrice * factor * rate.success)]
      }),
    )
  })

  const DvfPage = Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        annee_mois: Schema.String,
        nb_ventes_appartement: Schema.NullOr(Schema.Number),
        med_prix_m2_appartement: Schema.NullOr(Schema.Number),
        nb_ventes_maison: Schema.NullOr(Schema.Number),
        med_prix_m2_maison: Schema.NullOr(Schema.Number),
      }),
    ),
  })

  // Monthly medians are noisy (a few dozen sales): each point is the sales-weighted average of
  // the medians of the 12 months up to it.
  const dvfSeries = (inseeCode: string, propertyType: "apartment" | "house") =>
    getJson("DVF", `${DVF_MONTHLY}?code_geo__exact=${encodeURIComponent(inseeCode)}&annee_mois__sort=desc&page_size=24`, DvfPage).pipe(
      Effect.map(({ data }) => {
        const byMonth = new Map<Month, { n: number; median: number }>()
        for (const row of data) {
          const n = (propertyType === "apartment" ? row.nb_ventes_appartement : row.nb_ventes_maison) ?? 0
          const median = propertyType === "apartment" ? row.med_prix_m2_appartement : row.med_prix_m2_maison
          if (n > 0 && median) byMonth.set(row.annee_mois, { n, median })
        }
        const months = data.map((r) => r.annee_mois).sort()
        const series: DvfPrice[] = []
        for (const month of months.slice(-13)) {
          let weighted = 0
          let sales = 0
          for (let i = 0; i < 12; i++) {
            const m = byMonth.get(addMonths(month, -i))
            if (m) {
              weighted += m.median * m.n
              sales += m.n
            }
          }
          if (sales >= MIN_DVF_SALES) series.push({ pricePerM2: Math.round(weighted / sales), sales, from: addMonths(month, -11), to: month })
        }
        return series
      }),
    )

  const dvfPricePerM2 = (inseeCode: string, propertyType: "apartment" | "house") =>
    dvfSeries(inseeCode, propertyType).pipe(
      Effect.flatMap((series) =>
        series.length > 0
          ? Effect.succeed(series.at(-1)!)
          : Effect.fail(
              new ExternalError({ service: "DVF", message: "Pas assez de ventes récentes dans cette commune pour estimer un prix au m²." }),
            ),
      ),
    )

  const dvfHistory = (inseeCode: string, propertyType: "apartment" | "house") =>
    dvfSeries(inseeCode, propertyType).pipe(Effect.map((series) => series.map((p) => ({ date: lastDay(p.to), price: p.pricePerM2 }))))

  const cryptoHistory = (id: string) =>
    getJson(
      "CoinGecko",
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=365&interval=daily`,
      Schema.Struct({ prices: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Number])) }),
    ).pipe(Effect.map((body) => body.prices.map(([t, price]) => ({ date: new Date(t).toISOString().slice(0, 10), price }))))

  const MonthlyChart = Schema.Struct({
    chart: Schema.Struct({
      result: Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            meta: Schema.Struct({ currency: Schema.String }),
            timestamp: Schema.optional(Schema.Array(Schema.Finite)),
            indicators: Schema.Struct({ quote: Schema.Array(Schema.Struct({ close: Schema.Array(Schema.NullOr(Schema.Number)) })) }),
          }),
        ),
      ),
    }),
  })
  const quoteHistory = Effect.fn("MarketData.quoteHistory")(function* (symbol: string) {
    const body = yield* getJson(
      "Yahoo Finance",
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1mo`,
      MonthlyChart,
    )
    const result = body.chart.result?.[0]
    if (!result?.timestamp) return []
    // Past prices are converted at today's rate: close enough for a 12-month trend line.
    const { currency, factor } = currencyOf(result.meta.currency)
    const found = (yield* euroRates([currency])).get(currency)
    if (found === undefined || found._tag === "Failure") return []
    const rate = found.success
    const timestamps = result.timestamp
    return timestamps.flatMap((t, i) => {
      const close = result.indicators.quote[0]?.close[i]
      // Yahoo stamps monthly bars at the start of the month; the close is the month's last price.
      return close == null ? [] : [{ date: lastDay(new Date(t * 1000).toISOString().slice(0, 7)), price: close * factor * rate }]
    })
  })

  const searchCoins = (query: string) =>
    getJson(
      "CoinGecko",
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`,
      Schema.Struct({ coins: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, symbol: Schema.String })) }),
    ).pipe(Effect.map((body) => body.coins.slice(0, 8).map(({ id, name, symbol }) => ({ id, name, symbol }))))

  const searchSymbols = (query: string) =>
    getJson(
      "Yahoo Finance",
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`,
      Schema.Struct({
        quotes: Schema.Array(
          Schema.Struct({
            symbol: Schema.optional(Schema.String),
            shortname: Schema.optional(Schema.String),
            longname: Schema.optional(Schema.String),
            exchDisp: Schema.optional(Schema.String),
            typeDisp: Schema.optional(Schema.String),
          }),
        ),
      }),
    ).pipe(
      Effect.map((body) =>
        body.quotes.flatMap(({ symbol, ...q }) =>
          symbol
            ? [{ symbol, name: q.longname ?? q.shortname ?? symbol, exchange: q.exchDisp ?? "", type: q.typeDisp ?? "" }]
            : [],
        ),
      ),
    )

  // A postcode finds Paris/Lyon/Marseille arrondissements, which DVF reports separately.
  const searchCommunes = (query: string) => {
    const q = query.trim()
    const filter = /^\d{5}$/.test(q) ? `codePostal=${q}` : `nom=${encodeURIComponent(q)}`
    return getJson(
      "geo.api.gouv.fr",
      `https://geo.api.gouv.fr/communes?${filter}&type=arrondissement-municipal,commune-actuelle&fields=code,nom,codesPostaux&limit=8`,
      Schema.Array(Schema.Struct({ code: Schema.String, nom: Schema.String, codesPostaux: Schema.optional(Schema.Array(Schema.String)) })),
    ).pipe(Effect.map((rows) => rows.map((r) => ({ code: r.code, name: r.nom, postcode: r.codesPostaux?.[0] ?? null }))))
  }

  return MarketData.of({
    cryptoPrices,
    quotes,
    dvfPricePerM2,
    cryptoHistory,
    quoteHistory,
    dvfHistory,
    searchCoins,
    searchSymbols,
    searchCommunes,
  })
}

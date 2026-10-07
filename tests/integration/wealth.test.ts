import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { addDays, addMonths, lastDay, monthRange } from "~/domain/dates"
import { ExternalError } from "~/server/errors"
import type { CoinMarket } from "~/server/services/market-data"
import { Accounts } from "~/server/services/accounts"
import { Transactions } from "~/server/services/transactions"
import { type AssetInput, COIN_HISTORIES_PER_REFRESH, Wealth } from "~/server/services/wealth"
import { createHarness, type Harness } from "./harness"

const NOW = "2026-10-04T10:00:00Z"
const today = "2026-10-04"
const month = "2026-10"

const manual = (overrides: Partial<AssetInput> = {}): AssetInput => ({
  name: "Rolex Submariner",
  type: "watch",
  subtitle: null,
  purchase: { amount: 6_800_00, date: "2015-03-10" },
  declared: { amount: 9_500_00, date: `${addMonths(month, -2)}-12` },
  retained: "declared",
  share: 10_000,
  source: { kind: "manual" },
  notes: null,
  ...overrides,
})

const coin = (price: number): CoinMarket => ({ price, change24h: null, change7d: null, hourly: [], updatedAt: null })

const openCourant = (h: Harness, name = "Courant") =>
  h.run(
    Accounts.use((a) =>
      a.create({ name, kind: "checking", offBudget: false, startingBalance: 2_000_00, startingDate: `${addMonths(month, -14)}-01` }),
    ),
  )

describe("Wealth with only a budget account", () => {
  let h: Harness
  beforeAll(async () => {
    h = await createHarness({ now: NOW })
    await openCourant(h)
  })
  afterAll(() => h?.dispose())

  it("lists budget accounts read-only and counts them in the net worth", async () => {
    const overview = await h.run(Wealth.use((w) => w.overview))
    expect(overview.items).toHaveLength(1)
    expect(overview.items[0]).toMatchObject({ kind: "account", name: "Courant", value: 2_000_00, bucket: "cash", estimate: { kind: "account" } })
    expect(overview.netWorth).toBe(2_000_00)
    expect(overview.history).toHaveLength(13)
    expect(overview.history.every((v) => v === 2_000_00)).toBe(true)
    expect(overview.needsRefresh).toBe(false)
  })

  it("follows an account left out of the net worth apart, even once closed", async () => {
    const savings = await h.run(
      Accounts.use((a) =>
        a.create({ name: "AV Zoé", kind: "investment", offBudget: true, startingBalance: 5_000_00, startingDate: `${addMonths(month, -14)}-01` }),
      ),
    )
    await h.run(Accounts.use((a) => a.update(savings, { inNetWorth: false })))
    expect((await h.run(Accounts.use((a) => a.list))).find((a) => a.id === savings)?.inNetWorth).toBe(false)

    const overview = await h.run(Wealth.use((w) => w.overview))
    expect(overview.netWorth).toBe(2_000_00)
    expect(overview.history.every((v) => v === 2_000_00)).toBe(true)
    expect(overview.allocation.reduce((sum, s) => sum + s.value, 0)).toBe(2_000_00)
    expect(overview.items.map((i) => i.name)).toEqual(["Courant"])
    expect(overview.excluded).toMatchObject([{ id: savings, name: "AV Zoé", value: 5_000_00, bucket: "investments" }])

    await h.run(Accounts.use((a) => a.setClosed(savings, true)))
    const closed = await h.run(Wealth.use((w) => w.overview))
    expect(closed.closed).toEqual([])
    expect(closed.excluded).toEqual([])
    expect(closed.history.every((v) => v === 2_000_00)).toBe(true)
  })
})

describe("Wealth", () => {
  let h: Harness
  const calls = { crypto: 0, quotes: 0, dvf: 0 }
  let historyCalls = 0
  beforeAll(async () => {
    h = await createHarness({
      now: NOW,
      market: {
        cryptoMarkets: (ids) => {
          calls.crypto++
          return Effect.succeed(new Map(ids.filter((id) => id === "bitcoin").map((id) => [id, coin(60_000)])))
        },
        quotes: (symbols) => {
          calls.quotes++
          return Effect.succeed(new Map(symbols.filter((s) => s === "CW8.PA").map((s) => [s, Result.succeed(500.5)])))
        },
        // Daily prices for the last year: 40 000 € a year ago, +100 € per day.
        cryptoHistory: () => {
          historyCalls++
          return Effect.succeed(Array.from({ length: 366 }, (_, i) => ({ date: addDays(today, i - 365), price: 40_000 + i * 100 })))
        },
        dvfPricePerM2: (insee) => {
          calls.dvf++
          return insee === "69387"
            ? Effect.succeed({ pricePerM2: 4_800, sales: 1_200, from: "2025-01", to: "2025-12" })
            : Effect.fail(new ExternalError({ service: "DVF", message: "Pas assez de ventes" }))
        },
      },
    })
    await openCourant(h)
  })
  afterAll(() => h?.dispose())

  it("uses the retained value and nets liabilities", async () => {
    const before = (await h.run(Wealth.use((w) => w.overview))).netWorth
    const watch = await h.run(Wealth.use((w) => w.create(manual())))
    await h.run(
      Wealth.use((w) =>
        w.create(
          manual({
            name: "Crédit immo",
            type: "loan",
            purchase: null,
            declared: null,
            retained: "estimated",
            source: { kind: "loan", principal: 100_000_00, annualRatePct: 0, months: 100, firstPaymentDate: `${addMonths(month, -9)}-01` },
          }),
        ),
      ),
    )
    const overview = await h.run(Wealth.use((w) => w.overview))
    const byName = new Map(overview.items.map((i) => [i.name, i]))
    expect(byName.get("Rolex Submariner")).toMatchObject({ value: 9_500_00, retainedUsed: "declared", bucket: "objects" })
    // 10 installments of 1 000 € paid on a zero-rate loan.
    expect(byName.get("Crédit immo")).toMatchObject({ value: -90_000_00, isLiability: true, bucket: "loans" })
    expect(byName.get("Crédit immo")!.estimate).toMatchObject({ kind: "loan", label: "Tableau d'amortissement", automatic: true })
    expect(overview.netWorth).toBe(before + 9_500_00 - 90_000_00)
    const assets = await h.run(Wealth.use((w) => w.assetsOverview))
    expect(assets.items).toEqual(overview.items.filter((i) => i.kind === "asset"))
    // The declared value only exists from two months ago: before that the purchase price counts.
    const watchHistory = byName.get("Rolex Submariner")!.history
    expect(watchHistory[0]).toBe(6_800_00)
    expect(watchHistory.at(-1)).toBe(9_500_00)

    await h.run(Wealth.use((w) => w.addValuation({ assetId: watch, date: today, amount: 10_200_00 })))
    await h.run(Wealth.use((w) => w.update(watch, manual({ retained: "estimated" }))))
    const after = await h.run(Wealth.use((w) => w.overview))
    expect(after.items.find((i) => i.id === watch)).toMatchObject({
      value: 10_200_00,
      estimate: { kind: "valuation", amount: 10_200_00, label: "Saisie manuelle", automatic: false },
    })
  })

  it("refreshes automatic estimates in one call per source", async () => {
    const btc = await h.run(
      Wealth.use((w) =>
        w.create(manual({ name: "Bitcoin", type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId: "bitcoin", quantity: 0.5 } })),
      ),
    )
    expect(calls.crypto).toBe(1)
    await h.run(
      Wealth.use((w) =>
        Effect.all([
          w.create(manual({ name: "Ether", type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId: "ethereum", quantity: 2 } })),
          w.create(manual({ name: "PEA", type: "investment", purchase: { amount: 31_000_00, date: null }, declared: null, retained: "estimated", source: { kind: "stock", symbol: "CW8.PA", quantity: 10 } })),
          w.create(manual({ name: "Appartement", type: "real_estate", purchase: { amount: 245_000_00, date: "2019-06-01" }, declared: null, retained: "estimated", source: { kind: "real_estate", inseeCode: "69387", surface: 62, propertyType: "apartment" } })),
          w.create(manual({ name: "Maison", type: "real_estate", purchase: { amount: 150_000_00, date: "2010-01-01" }, declared: null, retained: "estimated", source: { kind: "real_estate", inseeCode: "01001", surface: 90, propertyType: "house" } })),
        ]),
      ),
    )
    // Each creation priced its own asset; a forced refresh of everything batches by source.
    calls.crypto = 0
    calls.quotes = 0
    calls.dvf = 0
    const all = await h.run(Wealth.use((w) => w.overview))
    const ids = all.items.filter((i) => i.kind === "asset").map((i) => i.id)
    const result = await h.run(Wealth.use((w) => w.refresh({ ids })))
    expect(calls).toEqual({ crypto: 1, quotes: 1, dvf: 2 })
    expect(result.updated).toBe(3)
    expect(result.failures.map((f) => f.name).sort()).toEqual(["Ether", "Maison"])

    const overview = await h.run(Wealth.use((w) => w.overview))
    const byName = new Map(overview.items.map((i) => [i.name, i]))
    expect(byName.get("Bitcoin")).toMatchObject({ value: 30_000_00, estimate: { label: "Cours en direct", automatic: true, unitPrice: 60_000 } })
    expect(byName.get("PEA")!.value).toBe(5_005_00)
    expect(byName.get("Appartement")).toMatchObject({ value: 297_600_00, estimate: { label: "Estimation DVF", unitPrice: 4_800 } })
    // No estimate yet: falls back to the purchase price.
    expect(byName.get("Maison")).toMatchObject({ value: 150_000_00, retainedUsed: "purchase" })
    // The ones that failed are still due.
    expect(overview.needsRefresh).toBe(true)

    // Same day again: the automatic estimate is replaced, and the past is not fetched twice.
    expect(historyCalls).toBe(1)
    await h.run(Wealth.use((w) => w.refresh({ ids: [btc] })))
    expect(historyCalls).toBe(1)
    const { results: valuations } = await h.d1
      .prepare("SELECT date FROM asset_valuations WHERE asset_id = ? ORDER BY date")
      .bind(btc)
      .all<{ date: string }>()
    expect(valuations.filter((v) => v.date === today)).toHaveLength(1)
    // Backfilled: one automatic estimate per past month-end, from the price history.
    const monthEnds = monthRange(addMonths(month, -12), addMonths(month, -1)).map(lastDay)
    expect(valuations.map((v) => v.date)).toEqual([...monthEnds, today])
    const btcHistory = byName.get("Bitcoin")!.history
    expect(btcHistory[0]).toBeGreaterThan(20_000_00)
    expect(btcHistory[0]).toBeLessThan(btcHistory[11]!)
  })

  it("builds the history from month-end values", async () => {
    const id = await h.run(
      Wealth.use((w) => w.create(manual({ name: "Voiture", type: "vehicle", purchase: { amount: 20_000_00, date: `${addMonths(month, -6)}-15` }, declared: null, retained: "estimated" }))),
    )
    await h.run(Wealth.use((w) => w.addValuation({ assetId: id, date: lastDay(addMonths(month, -3)), amount: 18_000_00 })))
    const overview = await h.run(Wealth.use((w) => w.overview))
    const car = overview.items.find((i) => i.id === id)!
    expect(car.history.slice(0, 6).every((v) => v === 0)).toBe(true)
    expect(car.history[6]).toBe(20_000_00)
    expect(car.history[9]).toBe(18_000_00)
    expect(car.history[12]).toBe(18_000_00)
    expect(overview.history[12]).toBe(overview.netWorth)
    expect(overview.change).toEqual({
      amount: overview.netWorth - overview.history[0]!,
      ratio: (overview.netWorth - overview.history[0]!) / Math.abs(overview.history[0]!),
      since: overview.months[0],
    })
  })

  it("counts only the part owned, from amounts entered for the whole asset", async () => {
    const flat = await h.run(
      Wealth.use((w) =>
        w.create(manual({ name: "Appartement à deux", type: "real_estate", share: 5_000, declared: null, retained: "purchase", purchase: { amount: 300_000_00, date: "2020-01-01" } })),
      ),
    )
    const loan = await h.run(
      Wealth.use((w) =>
        w.create(
          manual({
            name: "Prêt à deux",
            type: "loan",
            share: 5_000,
            purchase: null,
            declared: null,
            retained: "estimated",
            source: { kind: "loan", principal: 100_000_00, annualRatePct: 0, months: 100, firstPaymentDate: `${addMonths(month, -9)}-01` },
          }),
        ),
      ),
    )
    const overview = await h.run(Wealth.use((w) => w.overview))
    const byId = new Map(overview.items.map((i) => [i.id, i]))
    expect(byId.get(flat)).toMatchObject({ share: 5_000, value: 150_000_00, purchase: { amount: 300_000_00 } })
    expect(byId.get(flat)!.history.at(-1)).toBe(150_000_00)
    expect(byId.get(loan)).toMatchObject({ value: -45_000_00, estimate: { amount: 90_000_00 } })
    expect(byId.get(loan)!.history.at(-1)).toBe(-45_000_00)
    await h.run(Wealth.use((w) => w.remove(flat)))
    await h.run(Wealth.use((w) => w.remove(loan)))
  })

  it("follows the installments changed in a loan's schedule, and goes back to the computed ones", async () => {
    const loan = await h.run(
      Wealth.use((w) =>
        w.create(
          manual({
            name: "Prêt reporté",
            type: "loan",
            purchase: null,
            declared: null,
            retained: "estimated",
            source: { kind: "loan", principal: 100_000_00, annualRatePct: 0, months: 100, firstPaymentDate: `${addMonths(month, -9)}-01` },
          }),
        ),
      ),
    )
    const estimate = async () => (await h.run(Wealth.use((w) => w.overview))).items.find((i) => i.id === loan)!.estimate?.amount
    expect(await estimate()).toBe(90_000_00)

    // The 5th installment skipped: one installment of 1 000 € fewer paid by now.
    await h.run(Wealth.use((w) => w.setLoanPayments(loan, [{ installment: 5, payment: 0 }])))
    expect(await estimate()).toBe(91_000_00)

    await h.run(Wealth.use((w) => w.setLoanPayments(loan, [{ installment: 5, payment: null }])))
    expect(await estimate()).toBe(90_000_00)

    // 2 000 € from the 5th installment on: 4 × 1 000 € then 6 × 2 000 € paid by now.
    await h.run(Wealth.use((w) => w.setLoanPayments(loan, [{ installment: 5, payment: 2_000_00, onward: true }])))
    expect(await estimate()).toBe(84_000_00)
    expect(await h.fail(Wealth.use((w) => w.setLoanPayments(loan, [{ installment: 6, payment: "interest_only", onward: true }])))).toMatchObject({
      _tag: "Invalid",
    })
    await h.run(Wealth.use((w) => w.setLoanPayments(loan, [{ installment: 5, payment: null }])))
    expect(await estimate()).toBe(90_000_00)

    expect(await h.fail(Wealth.use((w) => w.setLoanPayments(loan, [{ installment: 201, payment: 0 }])))).toMatchObject({ _tag: "Invalid" })
    const watch = await h.run(Wealth.use((w) => w.create(manual())))
    expect(await h.fail(Wealth.use((w) => w.setLoanPayments(watch, [{ installment: 1, payment: 0 }])))).toMatchObject({ _tag: "Invalid" })
    expect(await h.fail(Wealth.use((w) => w.setLoanPayments("missing", [{ installment: 1, payment: 0 }])))).toMatchObject({ _tag: "NotFound" })
    await h.run(Wealth.use((w) => w.remove(loan)))
    await h.run(Wealth.use((w) => w.remove(watch)))
  })

  it("dates a loan stored with its drawdown date by its first installment, one month later", async () => {
    const terms = { kind: "loan" as const, principal: 100_000_00, annualRatePct: 0, months: 100, overrides: [{ installment: 2, payment: 0 }] }
    const legacy = { ...terms, startDate: "2026-01-31" }
    const id = await h.run(Wealth.use((w) => w.create(manual({ name: "Ancien prêt", type: "loan", purchase: null, declared: null, retained: "estimated", source: { ...terms, firstPaymentDate: "2026-02-28" } }))))
    await h.d1.prepare("UPDATE assets SET source = ? WHERE id = ?").bind(JSON.stringify(legacy), id).run()
    const sql = readFileSync(join(process.cwd(), "drizzle/20261005080641_loan_first_payment/migration.sql"), "utf8")
    await h.d1.prepare(sql).run()
    const row = await h.d1.prepare("SELECT source FROM assets WHERE id = ?").bind(id).first<{ source: string }>()
    expect(JSON.parse(row!.source)).toEqual({ ...terms, firstPaymentDate: "2026-02-28" })
    await h.run(Wealth.use((w) => w.remove(id)))
  })

  it("flags manual estimates older than six months", async () => {
    const id = await h.run(Wealth.use((w) => w.create(manual({ name: "Tableau", type: "art", retained: "estimated" }))))
    await h.run(Wealth.use((w) => w.addValuation({ assetId: id, date: `${addMonths(month, -8)}-01`, amount: 4_000_00 })))
    const overview = await h.run(Wealth.use((w) => w.overview))
    expect(overview.items.find((i) => i.id === id)?.stale).toBe(true)
  })

  it("rejects a blank name, a loan without its terms, a share outside 0-100 %, a zero quantity and a future valuation", async () => {
    await expect(h.run(Wealth.use((w) => w.create(manual({ name: " " }))))).rejects.toThrow(/nom/)
    await expect(h.run(Wealth.use((w) => w.create(manual({ type: "loan" }))))).rejects.toThrow(/capital/)
    await expect(h.run(Wealth.use((w) => w.create(manual({ share: 0 }))))).rejects.toThrow(/part détenue/)
    await expect(h.run(Wealth.use((w) => w.create(manual({ share: 12_000 }))))).rejects.toThrow(/part détenue/)
    await expect(
      h.run(Wealth.use((w) => w.create(manual({ type: "crypto", source: { kind: "crypto", coinId: "bitcoin", quantity: 0 } })))),
    ).rejects.toThrow(/quantité/)
    const asset = await h.run(Wealth.use((w) => w.create(manual({ name: "Bague" }))))
    await expect(h.run(Wealth.use((w) => w.addValuation({ assetId: asset, date: addDays(today, 1), amount: 1 })))).rejects.toThrow(/futur/)
    await h.run(Wealth.use((w) => w.addValuation({ assetId: asset, date: today, amount: 1 })))
  })

  it("reads account balances at today and months inside the window only", async () => {
    const joint = await openCourant(h, "Joint")
    const add = (date: string, amount: number) =>
      h.run(Transactions.use((t) => t.create({ accountId: joint, date, amount, payee: { kind: "name", name: "Test" }, categoryId: null })))
    await add(`${addMonths(month, -5)}-10`, 100_00)
    // An operation dated after today, as written before such dates became schedules.
    h.setNow(`${addDays(today, 3)}T10:00:00Z`)
    await add(addDays(today, 3), -500_00)
    h.setNow(NOW)
    const item = (await h.run(Wealth.use((w) => w.overview))).items.find((i) => i.id === joint)!
    expect(item.value).toBe(2_100_00)
    expect(item.history[6]).toBe(2_000_00)
    expect(item.history[7]).toBe(2_100_00)
    expect(item.history[12]).toBe(2_100_00)
  })

  it("keeps a closed account in the months it held money, out of the list", async () => {
    const [courant] = await h.run(Accounts.use((a) => a.list))
    const before = await h.run(Wealth.use((w) => w.overview))
    const pea = await h.run(
      Accounts.use((a) =>
        a.create({ name: "PEA", kind: "investment", offBudget: true, startingBalance: 400_00, startingDate: `${addMonths(month, -14)}-01` }),
      ),
    )
    await h.run(
      Transactions.use((t) =>
        t.create({ accountId: pea, date: `${addMonths(month, -2)}-05`, amount: -400_00, payee: { kind: "transfer", accountId: courant!.id }, categoryId: null }),
      ),
    )
    await h.run(Accounts.use((a) => a.setClosed(pea, true)))
    const after = await h.run(Wealth.use((w) => w.overview))
    expect(after.items.some((i) => i.id === pea)).toBe(false)
    expect(after.netWorth).toBe(before.netWorth + 400_00)
    expect(after.history.slice(0, 10)).toEqual(before.history.slice(0, 10).map((v) => v + 400_00))
    expect(after.history[12]).toBe(after.netWorth)
    expect(after.closed).toEqual([{ type: "investment", history: expect.arrayContaining([400_00, 0]) }])
    expect(after.closed[0]!.history[0]).toBe(400_00)
  })
})

describe("Wealth creation", () => {
  it("keeps the new asset, and only one, when its first estimate fails", async () => {
    const h = await createHarness({ now: NOW, market: { cryptoMarkets: () => Effect.die(new Error("Connexion perdue")) } })
    try {
      const crypto = manual({
        name: "Bitcoin",
        type: "crypto",
        purchase: null,
        declared: null,
        retained: "estimated",
        source: { kind: "crypto", coinId: "bitcoin", quantity: 1 },
      })
      const id = await h.run(Wealth.use((w) => w.create(crypto)))
      const { results } = await h.d1.prepare("SELECT id FROM assets").all<{ id: string }>()
      expect(results).toEqual([{ id }])
    } finally {
      await h.dispose()
    }
  })
})

describe("Coin histories", () => {
  // Two more coins than a refresh fetches histories for.
  const coins = Array.from({ length: COIN_HISTORIES_PER_REFRESH + 2 }, (_, i) => `coin-${i}`)
  const setup = async (history: (id: string) => Effect.Effect<Array<{ date: string; price: number }>, ExternalError>) => {
    let priced = false
    const h = await createHarness({
      now: NOW,
      market: {
        cryptoMarkets: (ids) => Effect.succeed(new Map(priced ? ids.map((id) => [id, coin(100)]) : [])),
        cryptoHistory: history,
      },
    })
    const ids: string[] = []
    for (const coinId of coins) {
      ids.push(
        await h.run(
          Wealth.use((w) =>
            w.create(manual({ name: coinId, type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId, quantity: 1 } })),
          ),
        ),
      )
    }
    priced = true
    return { h, refresh: () => h.run(Wealth.use((w) => w.refresh({ ids }))) }
  }
  const yearOf = (price: number) => Array.from({ length: 366 }, (_, i) => ({ date: addDays(today, i - 365), price }))

  it("fetches a few yearly histories per refresh, one at a time, and the rest on the next refreshes", async () => {
    const fetched: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const { h, refresh } = await setup((id) =>
      Effect.gen(function* () {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        yield* Effect.sleep("5 millis")
        inFlight--
        fetched.push(id)
        return yearOf(100)
      }),
    )
    try {
      expect((await refresh()).updated).toBe(coins.length)
      expect(fetched).toHaveLength(COIN_HISTORIES_PER_REFRESH)
      expect(maxInFlight).toBe(1)
      await refresh()
      expect(fetched.toSorted()).toEqual(coins.toSorted())
      await refresh()
      expect(fetched).toHaveLength(coins.length)
      const { results } = await h.d1
        .prepare("SELECT COUNT(DISTINCT asset_id) AS n FROM asset_valuations WHERE date < ?")
        .bind(`${month}-01`)
        .all<{ n: number }>()
      expect(results[0]!.n).toBe(coins.length)
    } finally {
      await h.dispose()
    }
  })

  it("keeps one valuation per day when two refreshes fill the same histories at once", async () => {
    const { h, refresh } = await setup(() => Effect.sleep("5 millis").pipe(Effect.as(yearOf(100))))
    try {
      await Promise.all([refresh(), refresh()])
      const { results } = await h.d1
        .prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM asset_valuations GROUP BY asset_id, date HAVING COUNT(*) > 1)")
        .all<{ n: number }>()
      expect(results[0]!.n).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it("stops asking CoinGecko for histories once it answers 429, and still saves today's prices", async () => {
    let calls = 0
    const { h, refresh } = await setup(() => {
      calls++
      return Effect.fail(new ExternalError({ service: "CoinGecko", message: "CoinGecko limite les requêtes, réessaie dans une minute.", rateLimited: true }))
    })
    try {
      const result = await refresh()
      expect(calls).toBe(1)
      expect(result).toEqual({ updated: coins.length, failures: [] })
    } finally {
      await h.dispose()
    }
  })

  it("keeps each coin's trend and yearly prices, so charts never call CoinGecko", async () => {
    let historyCalls = 0
    const hourly = Array.from({ length: 169 }, (_, i) => 100 + i)
    const updatedAt = `${today}T09:00:00.000Z`
    const h = await createHarness({
      now: NOW,
      market: {
        cryptoMarkets: (ids) => Effect.succeed(new Map(ids.map((id) => [id, { price: 120, change24h: -0.02, change7d: 0.05, hourly, updatedAt }]))),
        cryptoHistory: () => {
          historyCalls++
          return Effect.succeed(yearOf(100))
        },
      },
    })
    try {
      const create = (name: string) =>
        h.run(
          Wealth.use((w) =>
            w.create(manual({ name, type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId: "solana", quantity: 1 } })),
          ),
        )
      await create("Wallet 1")
      // A second wallet of the same coin reads the prices already stored.
      await create("Wallet 2")
      expect(historyCalls).toBe(1)

      const overview = await h.run(Wealth.use((w) => w.overview))
      // The list gets one point every 4 hours, ending on the latest.
      const sparkline = hourly.filter((_, i) => i % 4 === 0)
      for (const item of overview.items) {
        expect(item.trend).toEqual({ date: today, change24h: -0.02, change7d: 0.05, sparkline })
      }
      const { daily, hourly: stored } = await h.run(Wealth.use((w) => w.coinHistory("solana")))
      expect(daily).toHaveLength(366)
      expect(daily[0]!.date).toBe(addDays(today, -365))
      // Today's row is the refresh's price, not the history's.
      expect(daily.at(-1)).toEqual({ date: today, price: 120 })
      expect(stored).toEqual({ at: updatedAt, prices: hourly })
      const { results } = await h.d1.prepare("SELECT COUNT(DISTINCT asset_id) AS n FROM asset_valuations WHERE date < ?").bind(`${month}-01`).all<{ n: number }>()
      expect(results[0]!.n).toBe(2)

      await h.run(Wealth.use((w) => w.refresh({ ids: overview.items.map((i) => i.id) })))
      expect(historyCalls).toBe(1)
    } finally {
      await h.dispose()
    }
  })

  it("fills a missing day with the days since the last history, wherever the gap is", async () => {
    let historyCalls = 0
    const asked: number[] = []
    const h = await createHarness({
      now: NOW,
      market: {
        cryptoMarkets: (ids) => Effect.succeed(new Map(ids.map((id) => [id, coin(120)]))),
        cryptoHistory: (_, days) => {
          historyCalls++
          asked.push(days)
          return Effect.succeed(yearOf(100))
        },
      },
    })
    try {
      const asset = await h.run(
        Wealth.use((w) =>
          w.create(manual({ name: "Solana", type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId: "solana", quantity: 1 } })),
        ),
      )
      const refresh = () => h.run(Wealth.use((w) => w.refresh({ ids: [asset] })))
      expect(historyCalls).toBe(1)

      // Fetched days ago, and a refresh every day since: nothing missing.
      await h.d1.prepare("UPDATE coins SET history_date = ? WHERE id = 'solana'").bind(addDays(today, -3)).run()
      await refresh()
      expect(historyCalls).toBe(1)

      // No refresh two days ago, though yesterday's price is there: the 4 days since are fetched.
      await h.d1.prepare("DELETE FROM coin_prices WHERE coin_id = 'solana' AND date = ?").bind(addDays(today, -2)).run()
      await refresh()
      expect(historyCalls).toBe(2)
      expect(asked).toEqual([365, 4])
      expect((await h.run(Wealth.use((w) => w.coinHistory("solana")))).daily.map((p) => p.date)).toContain(addDays(today, -2))
      await refresh()
      expect(historyCalls).toBe(2)
    } finally {
      await h.dispose()
    }
  })

  it("still prices the other coins when CoinGecko sends an odd entry or a corrupted sparkline is stored", async () => {
    const h = await createHarness({
      now: NOW,
      market: {
        cryptoMarkets: (ids) => Effect.succeed(new Map(ids.map((id) => [id, { ...coin(120), hourly: [100, 110, 120] }]))),
        cryptoHistory: () => Effect.succeed(yearOf(100)),
      },
    })
    try {
      await h.run(
        Wealth.use((w) =>
          w.create(manual({ name: "Solana", type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId: "solana", quantity: 1 } })),
        ),
      )
      await h.d1.prepare("UPDATE coins SET sparkline = '[1, \"oops\"' WHERE id = 'solana'").run()
      const overview = await h.run(Wealth.use((w) => w.overview))
      expect(overview.items[0]!.trend?.sparkline).toEqual([])
      expect((await h.run(Wealth.use((w) => w.coinHistory("solana")))).hourly).toBeNull()
      expect(await h.run(Wealth.use((w) => w.coinHistory("unknown")))).toEqual({ daily: [], hourly: null })
    } finally {
      await h.dispose()
    }
  })

  it("does not refresh on every visit a coin CoinGecko no longer lists", async () => {
    const h = await createHarness({
      now: NOW,
      market: { cryptoMarkets: () => Effect.succeed(new Map()), cryptoHistory: () => Effect.succeed(yearOf(100)) },
    })
    try {
      const id = await h.run(
        Wealth.use((w) =>
          w.create(manual({ name: "Delisted", type: "crypto", purchase: null, declared: null, retained: "estimated", source: { kind: "crypto", coinId: "gone", quantity: 1 } })),
        ),
      )
      const result = await h.run(Wealth.use((w) => w.refresh({ ids: [id] })))
      expect(result.failures).toHaveLength(1)
      expect((await h.run(Wealth.use((w) => w.overview))).needsRefresh).toBe(false)
    } finally {
      await h.dispose()
    }
  })
})
